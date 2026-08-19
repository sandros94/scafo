/* The agent's HTTP API: what a node exposes to its peers and to operators. */

import { H3, type H3Event } from "h3";
import { createNodeVerifier, type NodeSigningKey } from "../core/auth/node-token.ts";
import { createOidcVerifier } from "../core/auth/oidc.ts";
import { ScaloError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { checkDomain } from "../core/registry/domains.ts";
import { flipAlias, rollbackAlias } from "../core/registry/environments.ts";
import { isLeaseExpired } from "../core/registry/lease.ts";
import { coordinatorKey, environmentKey, nodeKey } from "../core/registry/paths.ts";
import { retireEnvironment, unretireEnvironment } from "../core/registry/retirement.ts";
import type { CapacityPlan } from "../core/capacity/compute.ts";
import type { IngressDriver } from "../core/types/ingress.ts";
import type {
  CoordinatorLease,
  EnvironmentRecord,
  NodeRecord,
  ScaloWarning,
} from "../core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../core/types/supervisor.ts";
import { isHost } from "../core/utils/host.ts";
import { parseHostLabel } from "../core/utils/slug.ts";
import { deleteEnvironmentRequest } from "./_environments.ts";
import {
  type DeployVerifiers,
  readAliasRequest,
  readDeployRequest,
  tryNodeToken,
  verifyCaller,
  verifyWorkload,
} from "./_intake.ts";
import type { AgentConfig } from "./config.ts";
import type { Coordinator } from "./coordinator.ts";
import type { DeployService, DeployStatus } from "./deploys.ts";
import { renderProblem, requireNodeToken } from "./middleware.ts";
import type { PlacementView, Reconciler, ReconcileStatus } from "./reconcile.ts";

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
   * Where the node publishes what it serves. Without one the processes still
   * run and are simply not reachable from outside the node.
   */
  ingress?: IngressDriver;
  /** Accepts uploaded artifacts; without it this node refuses deploys. */
  deploys?: DeployService;
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
  /** Last pass of the reconcile loop; absent on a node that runs no loop. */
  reconcile?: ReconcileStatus;
}

/** Body of `DELETE /v1/environments/:project/:env`: the store keys it removed. */
export interface EnvironmentDeleted {
  deleted: string[];
}

/** Body of the retire and unretire routes: the environment as it now stands. */
export interface EnvironmentRetirement {
  environment: EnvironmentRecord;
}

/** Body of `POST /v1/aliases`: the environment as it now stands. */
export interface AliasResult {
  environment: EnvironmentRecord;
  warnings: ScaloWarning[];
}

/**
 * Builds the agent app. Every route answers failures as RFC 9457 problem
 * documents, and every route but health and the ingress ask requires a node,
 * operator or workload token.
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

    throw new ScaloError("not-found", "Host is not served here", {
      detail: `"${domain}" is neither a claimed domain nor a label under a platform domain`,
    });
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
    async (event): Promise<EnvironmentRetirement> => ({
      environment: await retireEnvironment(agent.registry, ...target(event)),
    }),
    { middleware: [authenticated] },
  );

  /* The way back, for as long as the grace runs: a retirement is a decision an
     operator must be able to take back with one call rather than with a restore. */
  app.post(
    "/v1/environments/:project/:env/unretire",
    async (event): Promise<EnvironmentRetirement> => ({
      environment: await unretireEnvironment(agent.registry, ...target(event)),
    }),
    { middleware: [authenticated] },
  );

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
      throw new ScaloError("not-found", "No such deploy", {
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

  return {
    node: lease.node,
    fence: lease.fence,
    self: agent.coordinator?.status().holding === true && lease.node === agent.nodeId,
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

  for (const domain of agent.config.platformDomains) {
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) continue;
    if (parseHostLabel(host.slice(0, -suffix.length)) !== null) return true;
  }

  const claim = await checkDomain(agent.registry, host);
  if (claim === null) return false;

  const environment = await readJson<EnvironmentRecord>(
    agent.registry,
    environmentKey(claim.project, claim.environment),
  );
  return environment !== null && environment.value.retiredAt === undefined;
}

/** The `:project` and `:env` a route was matched on, as a positional pair. */
function target(event: H3Event): [project: string, env: string] {
  return [event.context.params?.project ?? "", event.context.params?.env ?? ""];
}

function deployService(agent: AgentContext): DeployService {
  const deploys = agent.deploys;
  if (deploys === undefined) {
    throw new ScaloError("capability-missing", "This node does not accept deploys", {
      detail: "no deploy runner is configured, so there is nothing to publish an artifact with",
    });
  }
  return deploys;
}
