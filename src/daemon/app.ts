/* The daemon's HTTP API: what a node exposes to its peers and to operators. */

import { H3, type H3Event } from "h3";
import { createNodeVerifier, type NodeSigningKey } from "../core/auth/node-token.ts";
import { createOidcVerifier } from "../core/auth/oidc.ts";
import { ScafoError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { checkDomain } from "../core/registry/domains.ts";
import { isProjectBlocked } from "../core/registry/projects.ts";
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
import type { IngressCounters } from "./access-counters.ts";
import type { DaemonConfig } from "./config.ts";
import type { Coordinator } from "./coordinator.ts";
import type { DeployService, DeployStatus } from "./deploys.ts";
import {
  callerOperator,
  nodeIdentity,
  renderProblem,
  requireNodeToken,
  requireOperatorToken,
} from "./middleware.ts";
import { assertProjectScope, scopedState } from "./_scope.ts";
import { registerOperatorRoutes } from "./_operator-routes.ts";
import { registerProjectRoutes } from "./_project-routes.ts";
import type { Observability } from "./observe.ts";
import type { ParkedView, PlacementView, Reconciler, ReconcileStatus } from "./reconcile.ts";
import { registerStorageRoutes } from "./_storage-routes.ts";
import type { StorageService } from "./storage.ts";
import { createWakeService, requestHost, type WakeCounters } from "./wake.ts";

/** Everything the HTTP layer serves from; assembled once while the node boots. */
export interface DaemonContext {
  config: DaemonConfig;
  /**
   * Id this node answers as and is registered under. It comes from the node's
   * persistent state rather than from the configuration, which only pins it.
   */
  nodeId: string;
  registry: RegistryContext;
  supervisor: Supervisor;
  /** Build of the daemon, reported by `GET /v1/health`. */
  version: string;
  /**
   * Private half of this node's identity, when it holds one: what signs the node
   * tokens its calls to other nodes carry. Its public half is what the registry
   * files under {@link DaemonContext.nodeId}.
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
   * emission site is written `daemon.observability?.emit({ ... })`, and optional
   * chaining short-circuits the argument too — so a node that is not observing
   * never builds a single event object. A seam is only ever attached here while
   * `observability.enabled` says so.
   */
  observability?: Observability;
  /**
   * Where the requests this node's INGRESS served are counted, when an operator
   * named the access log it writes them to.
   *
   * ABSENT IS THE OFF STATE, exactly as above, and it is the ordinary one: the
   * adapter is built only when `observability.ingressAccessLog` names a file.
   * The routing is fed to it after every reconcile pass, because the routing is
   * what says which environment a host in that log belongs to.
   */
  ingressCounters?: IngressCounters;
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
export interface DaemonHealth {
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
export interface DaemonState {
  /** This node's registry record; null until it has registered. */
  node: NodeRecord | null;
  /** Holder of the coordinator lease, whoever it is; null when nobody holds one. */
  lease: CoordinatorLease | null;
  /**
   * The lease read as an election: null while nobody coordinates, which includes
   * a lease left behind by a node that is gone and whose TTL has run out.
   * {@link DaemonState.lease} reports that record as it stands; this reports what
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
  /**
   * Present, and always `true`, when this document was FILTERED to the projects
   * the caller reaches — set for any operator-tier caller, including one scoped
   * to every project and therefore shown everything.
   *
   * Absent for the two callers the whole document belongs to: a machine of the
   * fleet, and an admin. See `scopedState`, which is where both the filtering
   * and the reason for that exact rule live.
   */
  scoped?: true;
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
 * Builds the node app. Every route answers failures as RFC 9457 problem
 * documents, and every route but health and the two ingress-facing ones — the
 * on-demand-TLS ask and the configuration a pulled ingress polls — requires a
 * node, operator or workload token.
 */
export function createNodeApp(daemon: DaemonContext): H3 {
  /* One verifier of each kind for the whole app, never one per request: the node
     verifier caches the public keys it reads from the registry and remembers the
     id of every token already spent — single-use tokens only stay single-use
     while that record is shared — and the OIDC one caches each issuer's key set. */
  const nodeVerifier = createNodeVerifier(daemon.registry);
  const authenticated = requireNodeToken(nodeVerifier);
  const verifiers: DeployVerifiers = {
    node: nodeVerifier,
    oidc: createOidcVerifier(daemon.registry),
    registry: daemon.registry,
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
  const wake = createWakeService(daemon);
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
  app.get("/v1/health", (): DaemonHealth => ({
    ok: true,
    version: daemon.version,
    node: daemon.nodeId,
  }));

  /*
   * Unauthenticated on purpose: this is what an ingress asks before it issues a
   * certificate for a host, and it holds no key of ours. It answers nothing but
   * yes or no, and only about hosts that are already public knowledge.
   */
  app.get("/v1/ingress/ask", async (event): Promise<Response> => {
    const domain = event.url.searchParams.get("domain") ?? "";
    if (await servesHost(daemon, domain)) return new Response(null, { status: 200 });

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
    const ingress = daemon.ingress;
    if (ingress === undefined || !isPullingIngress(ingress)) {
      throw new ScafoError("not-found", "This node publishes no ingress configuration", {
        detail:
          `node "${daemon.nodeId}" drives no ingress that reads its routing from the daemon; ` +
          `set "ingress.driver" to "traefik" on the node this ingress polls`,
      });
    }
    return ingress.snapshot();
  });

  /*
   * WHAT THIS NODE BELIEVES, NARROWED TO WHAT THE CALLER MAY KNOW. Almost every
   * section here names projects — placements, parked environments, processes,
   * the environments the last pass could not place — so on a multi-tenant fleet
   * the unfiltered document is the tenant list, handed to anyone holding any
   * trusted key. `scopedState` is where that is decided, beside the refusal an
   * operator meets when it NAMES another tenant's project, because the two are
   * halves of one boundary and splitting them across files is how they drift.
   *
   * The caller is resolved once and cached on the event, so this costs the same
   * single record read a scoped route already makes. A node-signed PEER resolves
   * to no operator record and is handed the document untouched — the deploy-await
   * hop polls exactly this route for the process it is waiting on.
   */
  app.get(
    "/v1/state",
    async (event): Promise<DaemonState> => {
      const [node, lease] = await Promise.all([
        readJson<NodeRecord>(daemon.registry, nodeKey(daemon.nodeId)),
        readJson<CoordinatorLease>(daemon.registry, coordinatorKey()),
      ]);
      const reconcile = daemon.reconciler?.status();
      const state: DaemonState = {
        node: node?.value ?? null,
        lease: lease?.value ?? null,
        coordinator: coordinatorView(daemon, lease?.value ?? null),
        processes: daemon.supervisor.list(),
        /* From the reads the reconcile pass already made, rather than a second
           trip to the bucket for state this node has just been told. */
        placements: reconcile?.placements ?? [],
        parked: reconcile?.parked ?? [],
        wakes: wake.counters(),
        ...(reconcile === undefined ? {} : { reconcile }),
      };

      const callerId = nodeIdentity(event)?.nodeId;
      const caller =
        callerId === undefined ? null : await callerOperator(event, daemon.registry, callerId);
      return scopedState(caller, state);
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
      environment: await retireEnvironment(daemon.registry, ...(await scopedTarget(daemon, event))),
    }),
    { middleware: [authenticated] },
  );

  /* The way back, for as long as the grace runs: a retirement is a decision an
     operator must be able to take back with one call rather than with a restore. */
  app.post(
    "/v1/environments/:project/:env/unretire",
    async (event): Promise<EnvironmentResult> => ({
      environment: await unretireEnvironment(
        daemon.registry,
        ...(await scopedTarget(daemon, event)),
      ),
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
      const [project, name] = await scopedTarget(daemon, event);
      const request = await readSelectorRequest(event);
      return {
        environment: await setNodeSelector(daemon.registry, project, name, request.selector),
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
      const [project, name] = await scopedTarget(daemon, event);
      const request = await readParkRequest(event);
      return {
        environment: await setParkPolicy(daemon.registry, project, name, request.policy),
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
          ? await canarySplit(daemon.registry, project, name, request.canary)
          : await setSplit(daemon.registry, project, name, request.split),
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
    async (event): Promise<Response | EnvironmentDeleted> => {
      /* Before the hop, never after it: the request that reaches the
         coordinator is signed by THIS node rather than by the operator, so a
         scope checked at the far end would be a scope checked against a
         machine. The node the operator addressed is the only one that can. */
      await scopedTarget(daemon, event);
      return deleteEnvironmentRequest(daemon, event);
    },
    { middleware: [authenticated] },
  );

  app.post("/v1/deploys", async (event): Promise<Response> => {
    /* An operator's token needs nothing but the header, so it is checked before
       the artifact is buffered. A workload's is checked against the project the
       upload names, which cannot be known until the body has been read. */
    const operator = await tryNodeToken(verifiers, event);
    const request = await readDeployRequest(event);
    if (operator === null) {
      await verifyWorkload(verifiers, event, request.meta.project);
    } else if (operator.kind === "node") {
      /* The project is in the BODY here, so the scope cannot be checked where
         `verifyCaller` checks it for every other route — but it is still
         checked before a single byte of the artifact is published. */
      await assertProjectScope(
        daemon.registry,
        event,
        operator.identity.nodeId,
        request.meta.project,
      );
    }

    const status = await deployService(daemon).start(request.meta, request.artifact);
    /* Answered before the artifact has been published: the rest of the work
       outlives this request and is reported at the location below. */
    return new Response(JSON.stringify(status), {
      status: 202,
      headers: { "content-type": "application/json", "location": deployLocation(status.id) },
    });
  });

  app.get("/v1/deploys/:id", async (event): Promise<DeployStatus> => {
    const id = event.context.params?.id ?? "";
    const status = daemon.deploys?.get(id) ?? null;

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
        detail: `this node has no deploy "${id}"; a restarted daemon forgets the ones it accepted`,
      });
    }
    return status;
  });

  app.post("/v1/aliases", async (event): Promise<AliasResult> => {
    const request = await readAliasRequest(event);
    await verifyCaller(verifiers, event, request.project);

    if (request.rollback) {
      const environment = await rollbackAlias(
        daemon.registry,
        request.project,
        request.environment,
      );
      return { environment, warnings: [] };
    }
    return flipAlias(
      daemon.registry,
      request.project,
      request.environment,
      request.build as string,
    );
  });

  /*
   * THE KEYS THIS FLEET TRUSTS, administered by the operators it already trusts.
   * The only routes of the API a node's own token cannot reach: a node daemon
   * that has been taken over must not be able to write its installation a new
   * operator, so these ask WHO the verified id is as well as that it signed.
   */
  const operatorGuard = requireOperatorToken(nodeVerifier, daemon.registry);
  registerOperatorRoutes(app, daemon, operatorGuard);

  /*
   * THE PROJECTS OF THIS FLEET, behind the same guard and for the same reason
   * one step over: stopping a tenant is an act of the installation, so a machine
   * of it cannot take one, and neither can the tenant.
   */
  registerProjectRoutes(app, daemon, operatorGuard);

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
  if (daemon.storage !== undefined) registerStorageRoutes(app, daemon, daemon.storage);

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
  daemon: DaemonContext,
  lease: CoordinatorLease | null,
): CoordinatorView | null {
  if (lease === null || isLeaseExpired(lease, nowDate(daemon.registry))) return null;

  const status = daemon.coordinator?.status();
  const self = status?.holding === true && lease.node === daemon.nodeId;
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
 *
 * A BLOCKED PROJECT IS REFUSED ON BOTH ROUTES IN, and for the same reason one
 * step up: it answers nothing anywhere in the fleet, so a certificate for one of
 * its names would outlive the block. The check is made as soon as the host has
 * been resolved to a PROJECT — before the running processes are consulted,
 * because a pass may not have stopped them yet, and before the wake resolver,
 * which refuses a blocked project itself and is only reached for the hosts
 * nothing is running for.
 */
async function servesHost(daemon: DaemonContext, host: string): Promise<boolean> {
  if (!isHost(host)) return false;

  /*
   * THE BARE APEX OF A PLATFORM DOMAIN IS THE FLEET'S API, and the wildcard
   * certificate does not cover it — `*.<domain>` is one label and never the
   * domain itself — so this ask is the only way it is ever issued one. Approved
   * without a bucket read: the name is this node's own configuration, and what
   * answers there is the daemon rather than anything that could be missing.
   *
   * REFUSED WHILE `api.public` IS OFF, which is what it was before the apex
   * served anything: no route points there, so a certificate for it would name
   * something that answers nothing.
   */
  if (daemon.config.api.public && daemon.config.platformDomains.includes(host)) return true;

  /*
   * A platform-domain host is approved only when the name resolves to
   * something real: an environment, a wakeable build, or a process actually
   * running one. A parseable label alone is NOT enough — the ask gates
   * CERTIFICATE ISSUANCE, and approving every well-formed name would let
   * anyone mint issuance attempts for junk labels until the CA's rate limit
   * starves the names that matter.
   */
  for (const domain of daemon.config.platformDomains) {
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) continue;

    const label = host.slice(0, -suffix.length);
    const parsed = parseHostLabel(label);
    if (parsed === null) return false;
    if (await isProjectBlocked(daemon.registry, parsed.project)) return false;

    if (servedLabel(daemon, label)) return true;
    const target = await resolveWakeTarget(daemon.registry, {
      host,
      platformDomains: daemon.config.platformDomains,
      parked: daemon.reconciler?.parkedRecords() ?? [],
    });
    return target !== null;
  }

  const claim = await checkDomain(daemon.registry, host);
  if (claim === null) return false;
  if (await isProjectBlocked(daemon.registry, claim.project)) return false;

  const environment = await readJson<EnvironmentRecord>(
    daemon.registry,
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
function servedLabel(daemon: DaemonContext, label: string): boolean {
  const processes = daemon.reconciler?.status().processes ?? [];
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

/**
 * The same, with the caller's PROJECT SCOPE checked against the `:project`
 * before anything is read or written.
 *
 * Every route whose path names a project goes through this rather than through
 * {@link target}, which is what makes the check hard to leave off one of them:
 * the pair a handler needs and the refusal it owes come from the same call. A
 * caller holding no node token — a workload, or nobody — has no operator record
 * to be scoped by and passes through; the routes that admit one authenticate it
 * against the project separately.
 */
async function scopedTarget(
  daemon: DaemonContext,
  event: H3Event,
): Promise<[project: string, env: string]> {
  const pair = target(event);
  const callerId = nodeIdentity(event)?.nodeId;
  if (callerId !== undefined) {
    await assertProjectScope(daemon.registry, event, callerId, pair[0]);
  }
  return pair;
}

function deployService(daemon: DaemonContext): DeployService {
  const deploys = daemon.deploys;
  if (deploys === undefined) {
    throw new ScafoError("capability-missing", "This node does not accept deploys", {
      detail: "no deploy runner is configured, so there is nothing to publish an artifact with",
    });
  }
  return deploys;
}
