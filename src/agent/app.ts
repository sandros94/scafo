/* The agent's HTTP API: what a node exposes to its peers and to operators. */

import { H3, type H3Event } from "h3";
import { createNodeVerifier, type NodeSigningKey } from "../core/auth/node-token.ts";
import { createOidcVerifier } from "../core/auth/oidc.ts";
import { ScafoError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { checkDomain } from "../core/registry/domains.ts";
import { canarySplit, flipAlias, rollbackAlias, setSplit } from "../core/registry/environments.ts";
import { isLeaseExpired } from "../core/registry/lease.ts";
import { setParkPolicy } from "../core/registry/park.ts";
import { APEX_ENVIRONMENT } from "../core/placement/routes.ts";
import { resolveWakeTarget } from "./_wake-target.ts";
import { coordinatorKey, environmentKey, nodeKey } from "../core/registry/paths.ts";
import { setNodeSelector } from "../core/registry/placement.ts";
import { retireEnvironment, unretireEnvironment } from "../core/registry/retirement.ts";
import type { CapacityPlan } from "../core/capacity/compute.ts";
import type { IngressDriver } from "../core/types/ingress.ts";
import type {
  CoordinatorLease,
  EnvironmentRecord,
  NodeRecord,
  ScafoWarning,
} from "../core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../core/types/supervisor.ts";
import { isHost } from "../core/utils/host.ts";
import { formatHostLabel, parseHostLabel } from "../core/utils/slug.ts";
import type { AssignmentFailure } from "./_assign.ts";
import { deleteEnvironmentRequest } from "./_environments.ts";
import { isPullingIngress } from "./_ingress.ts";
import {
  type DeployVerifiers,
  readAliasRequest,
  readDeployRequest,
  readParkRequest,
  readSelectorRequest,
  readSplitRequest,
  tryNodeToken,
  verifyCaller,
  verifyWorkload,
} from "./_intake.ts";
import type { AgentConfig } from "./config.ts";
import type { Coordinator } from "./coordinator.ts";
import type { DeployService, DeployStatus } from "./deploys.ts";
import { renderProblem, requireNodeToken } from "./middleware.ts";
import type { Observability } from "./observe.ts";
import type { ParkedView, PlacementView, Reconciler, ReconcileStatus } from "./reconcile.ts";
import { registerStorageRoutes } from "./_storage-routes.ts";
import type { StorageService } from "./storage.ts";
import { createWakeService, requestHost, type WakeCounters } from "./wake.ts";

/** Everything the HTTP layer serves from; assembled once while the node boots. */
export interface AgentContext {
  config: AgentConfig;
  /**
   * Id this node answers as and is registered under. It comes from the node's
   * persistent state rather than from the configuration, which only pins it.
   */
  nodeId: string;
  registry: RegistryContext;
  supervisor: Supervisor;
  /** Build of the agent, reported by `GET /v1/health`. */
  version: string;
  /**
   * Private half of this node's identity, when it holds one: what signs the node
   * tokens its calls to other nodes carry. Its public half is what the registry
   * files under {@link AgentContext.nodeId}.
   */
  signingKey?: NodeSigningKey;
  /** Opens the environments' sealed varsets; without it they cannot be served. */
  varsetKey?: CryptoKey;
  /** What this node probed about its own hardware; bounds the processes it starts. */
  capacity?: CapacityPlan;
  /** The reconcile loop, when this node runs one. */
  reconciler?: Reconciler;
  /**
   * The coordinator loop, when this node runs one. A node without it never
   * carries out lease-gated work itself, and forwards it to whoever does.
   */
  coordinator?: Coordinator;
  /** How this node calls its peers; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Where this node reports what it did, when it reports at all.
   *
   * ABSENT IS THE OFF STATE, and it is off that this is optional FOR: every
   * emission site is written `agent.observability?.emit({ ... })`, and optional
   * chaining short-circuits the argument too — so a node that is not observing
   * never builds a single event object. A seam is only ever attached here while
   * `observability.enabled` says so.
   */
  observability?: Observability;
  /**
   * Where the wake surface's weighted pick between an environment's serving legs
   * comes from — a value in `[0, 1)`, drawn once per look at a held request.
   *
   * Defaults to `Math.random`, which is what a split asks for. Injectable so a
   * test can state which leg a request takes rather than sample for it.
   */
  random?: () => number;
  /**
   * Where the node publishes what it serves. Without one the processes still
   * run and are simply not reachable from outside the node.
   */
  ingress?: IngressDriver;
  /** Accepts uploaded artifacts; without it this node refuses deploys. */
  deploys?: DeployService;
  /**
   * Guards and keeps the `/v1/storage` surface, where a colocated process
   * persists its TLS material through this node. Without it that surface is not
   * served at all.
   */
  storage?: StorageService;
}

/** Body of `GET /v1/health`. */
export interface AgentHealth {
  ok: boolean;
  version: string;
  node: string;
}

/** Who is coordinating right now, as `GET /v1/state` reports it. */
export interface CoordinatorView {
  /** Id of the node holding the lease. */
  node: string;
  /** Fencing token of the lease it holds; it only ever increases. */
  fence: number;
  /** True when the node answering is the one coordinating. */
  self: boolean;
  /**
   * Environments the last assignment pass could decide nothing for, each naming
   * the constraint that went unsatisfied. Absent when there were none.
   *
   * Only ever reported by the node that RAN the pass — the one saying `self` —
   * because it is that node's account of what it just did, not a fact in the
   * registry. This is where an environment whose selector no live node satisfies
   * becomes visible: nothing else changes, precisely because the pass refuses to
   * take a serving environment down over an unsatisfiable constraint.
   */
  unplaced?: AssignmentFailure[];
}

/** Body of `GET /v1/state`: what this node believes about itself right now. */
export interface AgentState {
  /** This node's registry record; null until it has registered. */
  node: NodeRecord | null;
  /** Holder of the coordinator lease, whoever it is; null when nobody holds one. */
  lease: CoordinatorLease | null;
  /**
   * The lease read as an election: null while nobody coordinates, which includes
   * a lease left behind by a node that is gone and whose TTL has run out.
   * {@link AgentState.lease} reports that record as it stands; this reports what
   * it still means.
   */
  coordinator: CoordinatorView | null;
  processes: ProcessStatus[];
  /**
   * Which nodes serve each environment this node has read a decision for, and
   * whether this node is one of them. Empty on a node that runs no reconcile
   * loop, and — the case worth reading carefully — on an installation where no
   * coordinator has decided anything yet, which is when every node serves
   * everything.
   */
  placements: PlacementView[];
  /**
   * Environments the last pass read as PARKED: nothing runs for them here, and a
   * request for one of their hosts is what starts it again. Empty on a node that
   * runs no reconcile loop.
   */
  parked: ParkedView[];
  /**
   * What this node has done about wakes since it booted. Node-local soft state,
   * like the deploy map: it is in no registry, a restart counts from zero again,
   * and each node of an installation reports only its own.
   */
  wakes: WakeCounters;
  /** Last pass of the reconcile loop; absent on a node that runs no loop. */
  reconcile?: ReconcileStatus;
}

/** Body of `DELETE /v1/environments/:project/:env`: the store keys it removed. */
export interface EnvironmentDeleted {
  deleted: string[];
}

/** Body of the retire, unretire, selector, park and split routes: the environment as it now stands. */
export interface EnvironmentResult {
  environment: EnvironmentRecord;
}

/** Body of `POST /v1/aliases`: the environment as it now stands. */
export interface AliasResult {
  environment: EnvironmentRecord;
  warnings: ScafoWarning[];
}

/**
 * Builds the agent app. Every route answers failures as RFC 9457 problem
 * documents, and every route but health and the two ingress-facing ones — the
 * on-demand-TLS ask and the configuration a pulled ingress polls — requires a
 * node, operator or workload token.
 */
export function createAgentApp(agent: AgentContext): H3 {
  /* One verifier of each kind for the whole app, never one per request: the node
     verifier caches the public keys it reads from the registry and remembers the
     id of every token already spent — single-use tokens only stay single-use
     while that record is shared — and the OIDC one caches each issuer's key set. */
  const nodeVerifier = createNodeVerifier(agent.registry);
  const authenticated = requireNodeToken(nodeVerifier);
  const verifiers: DeployVerifiers = {
    node: nodeVerifier,
    oidc: createOidcVerifier(agent.registry),
  };

  const app = new H3({
    /* The problem renderer decides what is worth logging, so the framework's own
       console output would only duplicate it. */
    silent: true,
    onError: renderProblem,
  });

  /*
   * HOST DISPATCH, AND IT COMES BEFORE EVERYTHING. A node's routing sends two
   * kinds of traffic to this listener: the operator and peer calls the routes
   * below answer, and every host the ingress had nothing else to do with — a
   * parked environment's, a superseded build's, or a name under a platform
   * domain that nothing serves. The second kind is decided by the `Host` header
   * alone and never reaches a route: no API path, no token, and no fall into an
   * API 404 either, because a host on that surface is answered by the wake
   * service whatever path it asks for.
   *
   * Global middleware, so it applies to routed and unrouted paths alike, and it
   * short-circuits by returning a response — `next()` is never called for a
   * host it takes.
   */
  const wake = createWakeService(agent);
  app.use((event): Promise<Response> => wake.handle(event), {
    match: (event) => wake.handles(requestHost(event)),
  });

  /*
   * Unauthenticated on purpose: an ingress or an init system has to be able to
   * poll it without holding a key.
   *
   * TODO: a node on its way out records `drainingAt` in its registry record,
   * which is what takes it out of placement, but says nothing here. An external
   * load balancer polling this route still sends it traffic until the process is
   * gone; reporting the state would let one drain connections first.
   */
  app.get("/v1/health", (): AgentHealth => ({
    ok: true,
    version: agent.version,
    node: agent.nodeId,
  }));

  /*
   * Unauthenticated on purpose: this is what an ingress asks before it issues a
   * certificate for a host, and it holds no key of ours. It answers nothing but
   * yes or no, and only about hosts that are already public knowledge.
   */
  app.get("/v1/ingress/ask", async (event): Promise<Response> => {
    const domain = event.url.searchParams.get("domain") ?? "";
    if (await servesHost(agent, domain)) return new Response(null, { status: 200 });

    throw new ScafoError("not-found", "Host is not served here", {
      detail: `"${domain}" is neither a claimed domain nor a label under a platform domain`,
    });
  });

  /*
   * What a pulled ingress reads its whole routing from — Traefik's `http`
   * provider polls exactly this, every couple of seconds.
   *
   * Unauthenticated, on the same reading as the ask endpoint above: what it
   * discloses is which hosts this node serves and on which loopback ports, both
   * of which are already public — the hosts by being resolvable, the ports by
   * being reachable only from the machine the ingress runs on. It holds no key
   * and grants nothing. The stance is also forced: Traefik's http provider can
   * be given static headers and nothing else, so any credential here would be a
   * fixed secret sitting in the ingress's own configuration file, which buys no
   * more than leaving it off. A node that needs the API closed closes it at the
   * listener, where `node.listen` already puts it on loopback by default.
   *
   * 404 rather than an empty document when this node drives no pulled ingress:
   * an empty document is a legitimate answer meaning "this node serves
   * nothing", and an ingress polling the wrong node must be able to tell the
   * two apart. Traefik keeps its last configuration when a poll fails, so the
   * mistake costs the operator a log line rather than an outage.
   */
  app.get("/v1/ingress/traefik", (): unknown => {
    const ingress = agent.ingress;
    if (ingress === undefined || !isPullingIngress(ingress)) {
      throw new ScafoError("not-found", "This node publishes no ingress configuration", {
        detail:
          `node "${agent.nodeId}" drives no ingress that reads its routing from the agent; ` +
          `set "ingress.driver" to "traefik" on the node this ingress polls`,
      });
    }
    return ingress.snapshot();
  });

  app.get(
    "/v1/state",
    async (): Promise<AgentState> => {
      const [node, lease] = await Promise.all([
        readJson<NodeRecord>(agent.registry, nodeKey(agent.nodeId)),
        readJson<CoordinatorLease>(agent.registry, coordinatorKey()),
      ]);
      const reconcile = agent.reconciler?.status();
      return {
        node: node?.value ?? null,
        lease: lease?.value ?? null,
        coordinator: coordinatorView(agent, lease?.value ?? null),
        processes: agent.supervisor.list(),
        /* From the reads the reconcile pass already made, rather than a second
           trip to the bucket for state this node has just been told. */
        placements: reconcile?.placements ?? [],
        parked: reconcile?.parked ?? [],
        wakes: wake.counters(),
        ...(reconcile === undefined ? {} : { reconcile }),
      };
    },
    { middleware: [authenticated] },
  );

  /*
   * Retiring is a plain CAS update on one record, so ANY node carries it out
   * itself: unlike a deletion there is nothing here that two nodes doing it at
   * once could corrupt, and no lease to wait for or forward to. The environment
   * stops being served on every node's next pass, which is the same machinery a
   * reassignment goes through.
   */
  app.post(
    "/v1/environments/:project/:env/retire",
    async (event): Promise<EnvironmentResult> => ({
      environment: await retireEnvironment(agent.registry, ...target(event)),
    }),
    { middleware: [authenticated] },
  );

  /* The way back, for as long as the grace runs: a retirement is a decision an
     operator must be able to take back with one call rather than with a restore. */
  app.post(
    "/v1/environments/:project/:env/unretire",
    async (event): Promise<EnvironmentResult> => ({
      environment: await unretireEnvironment(agent.registry, ...target(event)),
    }),
    { middleware: [authenticated] },
  );

  /*
   * Which nodes an environment may run on, set or cleared. A plain CAS update on
   * one record, so ANY node carries it out itself, exactly as retirement does.
   *
   * It states an intent and nothing more: the coordinator decides which of the
   * matching nodes actually get it, on its next assignment pass. A selector no
   * live node satisfies is therefore accepted here and reported there — refusing
   * it would mean an operator could not label a node they are about to add.
   */
  app.post(
    "/v1/environments/:project/:env/selector",
    async (event): Promise<EnvironmentResult> => {
      const request = await readSelectorRequest(event);
      const [project, name] = target(event);
      return {
        environment: await setNodeSelector(agent.registry, project, name, request.selector),
      };
    },
    { middleware: [authenticated] },
  );

  /*
   * How an environment scales to zero, set or cleared. A plain CAS update on one
   * record, so ANY node carries it out itself, exactly as the selector does.
   *
   * It states an intent and nothing more: parked-ness is never stored, so every
   * node derives it from this policy and the environment's wake stamps on its
   * next pass — and a policy that parks an environment already past its window
   * takes effect there rather than here.
   */
  app.post(
    "/v1/environments/:project/:env/park",
    async (event): Promise<EnvironmentResult> => {
      const request = await readParkRequest(event);
      const [project, name] = target(event);
      return {
        environment: await setParkPolicy(agent.registry, project, name, request.policy),
      };
    },
    { middleware: [authenticated] },
  );

  /*
   * How an environment's traffic is divided between its builds, set or cleared.
   * A plain CAS update on one record, like the two above, and it states an
   * intent the same way: the nodes serving the environment start the legs it
   * names on their next passes, and the routing follows as each becomes ready.
   *
   * Authenticated like `POST /v1/aliases` rather than like the selector — with a
   * WORKLOAD token accepted for the project in the path — because a split is the
   * same kind of act as a flip: it moves an application's live traffic between
   * that application's own builds, which is what a project's CI is trusted to do
   * for its own project and for no other.
   */
  app.post("/v1/environments/:project/:env/split", async (event): Promise<EnvironmentResult> => {
    const [project, name] = target(event);
    /* Before the body is read: the project is in the path, so there is nothing
         to learn from the request first. */
    await verifyCaller(verifiers, event, project);

    const request = await readSplitRequest(event);
    return {
      environment:
        request.kind === "canary"
          ? await canarySplit(agent.registry, project, name, request.canary)
          : await setSplit(agent.registry, project, name, request.split),
    };
  });

  /*
   * Deleting is lease-gated, so only the coordinator can carry it out — but any
   * node accepts the request and forwards it there, because which node holds the
   * lease is this installation's business rather than the operator's.
   *
   * `?force=1` skips both the ephemeral and the retirement-grace requirement;
   * without it a long-lived environment is refused with the route that applies.
   */
  app.delete(
    "/v1/environments/:project/:env",
    (event): Promise<Response | EnvironmentDeleted> => deleteEnvironmentRequest(agent, event),
    { middleware: [authenticated] },
  );

  app.post("/v1/deploys", async (event): Promise<Response> => {
    /* An operator's token needs nothing but the header, so it is checked before
       the artifact is buffered. A workload's is checked against the project the
       upload names, which cannot be known until the body has been read. */
    const operator = await tryNodeToken(verifiers, event);
    const request = await readDeployRequest(event);
    if (operator === null) await verifyWorkload(verifiers, event, request.meta.project);

    const status = await deployService(agent).start(request.meta, request.artifact);
    /* Answered before the artifact has been published: the rest of the work
       outlives this request and is reported at the location below. */
    return new Response(JSON.stringify(status), {
      status: 202,
      headers: { "content-type": "application/json", "location": deployLocation(status.id) },
    });
  });

  app.get("/v1/deploys/:id", async (event): Promise<DeployStatus> => {
    const id = event.context.params?.id ?? "";
    const status = agent.deploys?.get(id) ?? null;

    /*
     * A workload token is only ever checked against a project, and the only
     * project an id names is the one of the deploy it belongs to. An id this
     * node has never seen therefore has nothing to authenticate against, and is
     * answered as an authentication failure rather than as a miss — which id
     * exists is not something an unauthenticated caller gets to find out.
     */
    await verifyCaller(verifiers, event, status?.project ?? null);
    if (status === null) {
      throw new ScafoError("not-found", "No such deploy", {
        detail: `this node has no deploy "${id}"; a restarted agent forgets the ones it accepted`,
      });
    }
    return status;
  });

  app.post("/v1/aliases", async (event): Promise<AliasResult> => {
    const request = await readAliasRequest(event);
    await verifyCaller(verifiers, event, request.project);

    if (request.rollback) {
      const environment = await rollbackAlias(agent.registry, request.project, request.environment);
      return { environment, warnings: [] };
    }
    return flipAlias(agent.registry, request.project, request.environment, request.build as string);
  });

  /*
   * TLS STORAGE, AND IT MUST NEVER BE REACHABLE THROUGH A PUBLIC OR
   * INGRESS-EXPOSED SURFACE. These routes carry PRIVATE KEYS in both directions
   * — an ingress's certificates, the account key it issues them with, and the
   * locks that serialize issuance — guarded by one shared token rather than by
   * the keys the rest of the API is verified against. They are for a caller on
   * this machine or inside the installation's own tunnel and for nobody else: no
   * ingress may proxy a public host to them, and no listener serving them may
   * reach past loopback or that tunnel.
   *
   * A node holding no storage token serves nothing here at all, rather than
   * refusing each request in turn.
   */
  if (agent.storage !== undefined) registerStorageRoutes(app, agent, agent.storage);

  return app;
}

/** Where the status of a deploy is polled. */
export function deployLocation(id: string): string {
  return `/v1/deploys/${id}`;
}

/**
 * The lease as an election. `self` takes the coordinator loop's own word for it
 * rather than comparing ids alone: the loop holds the ETag that fences its
 * writes, and a node whose renewal was refused has already stopped coordinating
 * while the record it was refused over still names it.
 */
function coordinatorView(
  agent: AgentContext,
  lease: CoordinatorLease | null,
): CoordinatorView | null {
  if (lease === null || isLeaseExpired(lease, nowDate(agent.registry))) return null;

  const status = agent.coordinator?.status();
  const self = status?.holding === true && lease.node === agent.nodeId;
  /* Only from the node that made them, and only while there are any: a settled
     installation says nothing here rather than saying "nothing went wrong". */
  const unplaced = self ? (status?.lastAssignment?.unplaced ?? []) : [];

  return {
    node: lease.node,
    fence: lease.fence,
    self,
    ...(unplaced.length === 0 ? {} : { unplaced: unplaced.map((entry) => ({ ...entry })) }),
  };
}

/**
 * Whether this installation answers for `host`: a label under one of its
 * platform domains, or a custom domain some environment has claimed and is still
 * being served under.
 *
 * The platform domains are checked first, so the common case costs no bucket
 * read. A host that is not a host at all is simply not served, rather than an
 * error — the caller is an ingress asking about whatever arrived on the wire.
 *
 * A claim is followed by ONE more read, of the environment holding it, and the
 * reason is what this endpoint is for: the answer decides whether a certificate
 * is issued. A retired environment is being decommissioned and its routes are
 * already gone, so a certificate minted for it now would be a fresh public
 * record of a name that answers nothing — with a lifetime outlasting the
 * environment itself. An environment that is gone entirely reads the same way,
 * which also covers the claim a half-finished deletion left behind.
 */
async function servesHost(agent: AgentContext, host: string): Promise<boolean> {
  if (!isHost(host)) return false;

  /*
   * A platform-domain host is approved only when the name resolves to
   * something real: an environment, a wakeable build, or a process actually
   * running one. A parseable label alone is NOT enough — the ask gates
   * CERTIFICATE ISSUANCE, and approving every well-formed name would let
   * anyone mint issuance attempts for junk labels until the CA's rate limit
   * starves the names that matter.
   */
  for (const domain of agent.config.platformDomains) {
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) continue;

    const label = host.slice(0, -suffix.length);
    if (parseHostLabel(label) === null) return false;
    if (servedLabel(agent, label)) return true;
    const target = await resolveWakeTarget(agent.registry, {
      host,
      platformDomains: agent.config.platformDomains,
      parked: agent.reconciler?.parkedRecords() ?? [],
    });
    return target !== null;
  }

  const claim = await checkDomain(agent.registry, host);
  if (claim === null) return false;

  const environment = await readJson<EnvironmentRecord>(
    agent.registry,
    environmentKey(claim.project, claim.environment),
  );
  return environment !== null && environment.value.retiredAt === undefined;
}

/**
 * Whether a process this node is RUNNING answers to the label: its build-hash
 * name, or its environment's own label. Running is what matters here — a
 * served host needs its certificate whatever its park policy says about
 * waking it later.
 */
function servedLabel(agent: AgentContext, label: string): boolean {
  const processes = agent.reconciler?.status().processes ?? [];
  return processes.some(
    (process) =>
      label === formatHostLabel(process.project, process.build) ||
      label === formatHostLabel(process.project, process.env) ||
      (process.env === APEX_ENVIRONMENT && label === process.project),
  );
}

/** The `:project` and `:env` a route was matched on, as a positional pair. */
function target(event: H3Event): [project: string, env: string] {
  return [event.context.params?.project ?? "", event.context.params?.env ?? ""];
}

function deployService(agent: AgentContext): DeployService {
  const deploys = agent.deploys;
  if (deploys === undefined) {
    throw new ScafoError("capability-missing", "This node does not accept deploys", {
      detail: "no deploy runner is configured, so there is nothing to publish an artifact with",
    });
  }
  return deploys;
}
