/* The daemon's HTTP API: what a node exposes to its peers and to operators. */

import { H3 } from "h3";
import { createNodeVerifier, type NodeSigningKey } from "../core/auth/node-token.ts";
import { createOidcVerifier } from "../core/auth/oidc.ts";
import { ScafoError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import type { RegistryView } from "../core/registry/view.ts";
import { isLeaseExpired } from "../core/registry/lease.ts";
import {
  abandonedDeploy,
  getDeployRecord,
  isDeployIdle,
  isDeployTerminal,
} from "../core/registry/deploys.ts";
import { coordinatorKey, nodeKey, parseDeployId } from "../core/registry/paths.ts";
import type { IngressFormat } from "../core/types/ingress.ts";
import {
  DEFAULT_ARTIFACT_BYTES,
  type ArtifactStager,
  type StagedArtifact,
} from "../core/types/deploy.ts";
import type {
  CoordinatorLease,
  DeployRecord,
  NodeRecord,
  NodeVersions,
} from "../core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../core/types/supervisor.ts";
import type { ProcessHealthTracker, ProcessHealthView } from "./_process-health.ts";
import { assertSlug } from "../core/utils/slug.ts";
import type { AssignmentFailure } from "./_assign.ts";
import { registerIngressRoutes } from "./_ingress-routes.ts";
import { type DeployVerifiers, readDeployMetadata, verifyCaller } from "./_intake.ts";
import type { IngressCounters } from "./access-counters.ts";
import type { DaemonConfig } from "./config.ts";
import type { Coordinator } from "./coordinator.ts";
import { deployStatusOf, type DeployService, type DeployStatus } from "./deploys.ts";
import {
  nodeIdentity,
  renderProblem,
  requireNodeToken,
  requireOperatorToken,
} from "./middleware.ts";
import { scopedState } from "./_scope.ts";
import { registerOperatorRoutes } from "./_operator-routes.ts";
import { registerFleetRoutes } from "./_fleet-routes.ts";
import { registerApplicationRoutes } from "./_application-routes.ts";
import type { Heartbeat } from "./heartbeat.ts";
import type { Observability } from "./observe.ts";
import type { PlacementView, Reconciler, ReconcileStatus } from "./reconcile.ts";
import { registerStorageRoutes } from "./_storage-routes.ts";
import type { StorageService } from "./storage.ts";

/** Everything the HTTP layer serves from; assembled once while the node boots. */
export interface DaemonContext {
  config: DaemonConfig;
  /** Persistent node identity; configuration may only pin it. */
  nodeId: string;
  registry: RegistryContext;
  /**
   * The registry view this node's loops share: the reconcile pass, the
   * coordinator and deploy intake's version-skew gate all read it rather than
   * listing the installation each for themselves. Built on first use by
   * `registryView`, so a caller that wants one on its own clock supplies it.
   */
  view?: RegistryView;
  supervisor: Supervisor;
  /**
   * What this node knows about the processes it supervises: how often each has
   * exited, when it last did, and what it said on the way out. Absent on a node
   * that supervises nothing, and every surface that reads it treats that as
   * "nothing to report" rather than "everything is fine".
   */
  processHealth?: ProcessHealthTracker;
  /**
   * The binaries this daemon booted with, and what its node record reports. The
   * Scafo half is what `GET /.well-known/scafo/health` answers with, and the
   * Celld half is what every other node's is measured against before this one
   * starts a process for an application or takes a deploy into it.
   */
  versions: NodeVersions;
  /** Node private key used for peer tokens; its public half is in the registry. */
  signingKey?: NodeSigningKey;
  /** The reconcile loop, when this node runs one. */
  reconciler?: Reconciler;
  /**
   * The heartbeat, when this node runs one. The reconcile loop beats it out of
   * turn when what the node serves changes, so the fleet hears at once.
   */
  heartbeat?: Heartbeat;
  /**
   * The coordinator loop, when this node runs one. A node without it never
   * carries out lease-gated work itself, and forwards it to whoever does.
   */
  coordinator?: Coordinator;
  /** How this node calls its peers; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Optional observability seam. Its absence avoids event-object allocation. */
  observability?: Observability;
  /** Optional ingress counters, told what the registry holds by each pass. */
  ingressCounters?: IngressCounters;
  /**
   * The formats this node renders the fleet's routing in for an ingress that
   * polls, by the name it is served under (`/v1/ingress/<name>`).
   */
  ingressFormats?: Record<string, IngressFormat>;
  /** Accepts uploaded artifacts; without it this node refuses deploys. */
  deploys?: DeployService;
  /** Stages request bodies outside memory; without it this node refuses deploys. */
  artifactStager?: ArtifactStager;
  /** Optional token-protected local TLS storage surface. */
  storage?: StorageService;
}

/* The application routes' own bodies are part of the node's public surface, and
   they are declared beside the routes that answer with them. */
export type {
  ApplicationDeleted,
  ApplicationDomain,
  ApplicationResult,
  ApplicationsResult,
} from "./_application-routes.ts";

/** Body of `GET /.well-known/scafo/health`. */
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
  /** Unplaced applications from this coordinator's last pass; absent otherwise. */
  unplaced?: AssignmentFailure[];
}

/**
 * One supervised process as `GET /v1/state` reports it: what the supervisor
 * holds, and what this node's health tracker has watched it do.
 *
 * The health half is absent only for a process the tracker has never been told
 * about — one adopted by a daemon that restarted under it — and a reader takes
 * that for "not known" rather than for "healthy".
 */
export interface SupervisedProcess extends ProcessStatus {
  /** The word every surface reports this process with. */
  health?: ProcessHealthView["health"];
  /**
   * Whether the run now going has answered its own health endpoint. Only a ready
   * process is in the node record's `serving`, so this is what says WHY an
   * application a node is running is not being routed to it.
   */
  ready?: boolean;
  /** When it answered, ISO-8601; absent for a process that has not. */
  readyAt?: string;
  /** Exits in a row with no run between them that served. */
  restarts?: number;
  /** The last exit, when there has been one. */
  lastExit?: ProcessHealthView["lastExit"];
  /** When a start is being held back, until when. */
  retryAt?: string;
}

/** Body of `GET /v1/state`: what this node believes about itself right now. */
export interface DaemonState {
  /** This node's registry record; null until it has registered. */
  node: NodeRecord | null;
  /** Holder of the coordinator lease, whoever it is; null when nobody holds one. */
  lease: CoordinatorLease | null;
  /** Effective coordinator election result; expired lease records produce null. */
  coordinator: CoordinatorView | null;
  processes: SupervisedProcess[];
  /** Placement views. Missing placement is pending, never implicit assignment. */
  placements: PlacementView[];
  /** Last pass of the reconcile loop; absent on a node that runs no loop. */
  reconcile?: ReconcileStatus;
  /** `true` when operator scope filtered this document, even if scope grants all applications. */
  scoped?: true;
}

/**
 * Builds the node app. Every route answers failures as RFC 9457 problem
 * documents, and every route but health requires a token: a node, operator or
 * workload token, or on the storage and routing surfaces the ingress token.
 */
export function createNodeApp(daemon: DaemonContext): H3 {
  /* Reuse verifiers: node replay detection and OIDC key caches are app-wide. */
  const nodeVerifier = createNodeVerifier(daemon.registry);
  const authenticated = requireNodeToken(nodeVerifier);
  const verifiers: DeployVerifiers = {
    node: nodeVerifier,
    oidc: createOidcVerifier(daemon.registry),
  };

  const app = new H3({
    /* Problem rendering owns error logging. */
    silent: true,
    onError: renderProblem,
  });

  /* Public health endpoint for ingress and process supervision. */
  app.get("/.well-known/scafo/health", (): DaemonHealth => ({
    ok: true,
    version: daemon.versions.scafo,
    node: daemon.nodeId,
  }));

  /* Operator tokens receive application-scoped state; peer and admin tokens
     receive the whole document. */
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
        processes: supervisedProcesses(daemon),
        /* Reuse reconciliation's placement snapshot. */
        placements: reconcile?.placements ?? [],
        ...(reconcile === undefined ? {} : { reconcile }),
      };

      const identity = nodeIdentity(event);
      const caller = identity?.kind === "operator" ? identity.operator : null;
      return scopedState(caller, state);
    },
    { middleware: [authenticated] },
  );

  app.post("/v1/applications/:name/deploys", async (event): Promise<Response> => {
    const application = event.context.params?.name ?? "";
    assertSlug(application);
    /* Authenticate application access before reading deployment metadata or body. */
    const caller = await verifyCaller(verifiers, event, application);
    const meta = readDeployMetadata(event, application);
    if (caller.kind === "workload") meta.oidc = caller.identity.actor;

    const service = deployService(daemon);
    const stager = artifactStager(daemon);
    const reservation = service.reserve(application);
    let artifact: StagedArtifact | undefined;
    let status: DeployStatus;
    try {
      const admission = await service.admit(meta);
      const body = event.req.body;
      if (body === null) {
        throw new ScafoError("invalid-input", "Malformed request", {
          detail: "the raw artifact body is required",
        });
      }
      artifact = await stager.stage(body, {
        maxBytes: daemon.config.deploy?.artifactBytes ?? DEFAULT_ARTIFACT_BYTES,
        signal: AbortSignal.any([event.req.signal, reservation.signal]),
      });
      status = await admission.start(artifact, reservation);
    } catch (error) {
      if (artifact === undefined) reservation.cancel(error);
      else await reservation.discard(artifact, error);
      throw error;
    }
    return new Response(JSON.stringify(status), {
      status: 202,
      headers: { "content-type": "application/json", "location": deployLocation(status.id) },
    });
  });

  /* Any node answers a poll: the deploy's state is a registry record, and behind
     an apex that several nodes answer for the poll lands wherever the ingress
     sends it. The accepting node still answers from memory, which is the same
     record a moment sooner. */
  app.get("/v1/deploys/:id", async (event): Promise<DeployStatus> => {
    const id = event.context.params?.id ?? "";
    const parsed = parseDeployId(id);

    /* The application in the id is what the caller is authenticated against,
       exactly as the upload was: an operator's scope is applied to it and a
       workload token is verified against its trust policy. An id that is no id
       of ours names no application, so there is nothing to authenticate and
       nothing to disclose. */
    await verifyCaller(verifiers, event, parsed?.application ?? null);
    if (parsed === null) {
      throw new ScafoError("not-found", "No such deploy", {
        detail: `"${id}" is not a deploy id this installation mints`,
      });
    }

    const local = daemon.deploys?.get(id) ?? null;
    if (local !== null) return local;

    const record = await getDeployRecord(daemon.registry, parsed.application, id);
    /* A record that disagrees with the id it is filed under is not the one the
       caller was authenticated for. */
    if (record.application !== parsed.application) {
      throw new ScafoError("not-found", "No such deploy", {
        detail: `"${id}" is not a deploy of application "${parsed.application}"`,
      });
    }
    return deployStatusOf(await judgeAbandoned(daemon, record));
  });

  /* Trusted-key administration requires an operator token, never a node token. */
  const operatorGuard = requireOperatorToken(nodeVerifier, daemon.registry);
  registerOperatorRoutes(app, daemon, operatorGuard);

  /* Application administration uses the same operator-only boundary. */
  registerApplicationRoutes(app, daemon, { operator: operatorGuard, peer: authenticated });

  /* So does what an admin says about the installation itself. */
  registerFleetRoutes(app, daemon, operatorGuard);

  /* TLS storage carries private keys: serve it only when configured, and never
     expose it through a public ingress. */
  if (daemon.storage !== undefined) {
    registerStorageRoutes(app, daemon, daemon.storage);
    /* The routing names every node's address and port: same token, same rule. */
    registerIngressRoutes(app, daemon, daemon.storage);
  }

  return app;
}

/**
 * The record as it stands, or the failure a deploy nobody is carrying out any
 * more has already suffered.
 *
 * JUDGED AT READ TIME rather than waited for. The state of a deploy lives in the
 * daemon that accepted it, so a node that stopped answering has taken it with
 * it; the record it left says `uploading` and will say so until a coordinator
 * sweeps. A caller polling for an answer gets one now instead — `deploy-timeout`,
 * the same code and the same detail the sweep will eventually write down.
 *
 * It costs ONE extra read and only for a deploy that is both unfinished and has
 * not moved for a whole liveness window, which is the only case where the
 * question can have a different answer. Nothing is written: a poll is a read.
 */
/**
 * The supervisor's own list, each entry carrying what the health tracker has
 * watched that process do.
 *
 * A PROCESS THE TRACKER KNOWS AND THE SUPERVISOR DOES NOT IS STILL REPORTED: a
 * crash-looping process spends most of its life exited and waiting for its next
 * start, and a document that listed only what is running this instant would show
 * nothing at all for exactly the application somebody is asking about.
 */
function supervisedProcesses(daemon: DaemonContext): SupervisedProcess[] {
  const views = daemon.processHealth?.views() ?? {};
  const processes: SupervisedProcess[] = daemon.supervisor.list().map((status) => ({
    ...status,
    ...healthOf(views[status.id]),
  }));

  const listed = new Set(processes.map((process) => process.id));
  for (const [application, view] of Object.entries(views)) {
    if (listed.has(application)) continue;
    processes.push({
      id: application,
      state: "exited",
      startedAt: view.startedAt ?? view.lastExit?.at ?? "",
      ...(view.lastError === undefined ? {} : { lastError: view.lastError }),
      ...healthOf(view),
    });
  }
  return processes.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
}

/** The health half of one process's entry, or nothing when it is not tracked. */
function healthOf(view: ProcessHealthView | undefined): Partial<SupervisedProcess> {
  if (view === undefined) return {};
  return {
    health: view.health,
    ready: view.ready,
    ...(view.readyAt === undefined ? {} : { readyAt: view.readyAt }),
    restarts: view.restarts,
    ...(view.lastExit === undefined ? {} : { lastExit: view.lastExit }),
    ...(view.retryAt === undefined ? {} : { retryAt: view.retryAt }),
    /* The tracker's tail outlives the supervisor id, so it is what a caller
       reads once the process it came from has been forgotten. */
    ...(view.lastError === undefined ? {} : { lastError: view.lastError }),
  };
}

async function judgeAbandoned(daemon: DaemonContext, record: DeployRecord): Promise<DeployRecord> {
  const now = nowDate(daemon.registry);
  if (!isDeployIdle(record, now) || isDeployTerminal(record.state)) return record;

  const node = await readJson<NodeRecord>(daemon.registry, nodeKey(record.node));
  const failure = abandonedDeploy(record, { now, node: node?.value ?? null });
  return failure === null ? record : { ...record, ...failure };
}

/** Where the status of a deploy is polled. */
export function deployLocation(id: string): string {
  return `/v1/deploys/${id}`;
}

/** Interprets the lease as an election; `self` requires the loop's current fence. */
function coordinatorView(
  daemon: DaemonContext,
  lease: CoordinatorLease | null,
): CoordinatorView | null {
  if (lease === null || isLeaseExpired(lease, nowDate(daemon.registry))) return null;

  const status = daemon.coordinator?.status();
  const self = status?.holding === true && lease.node === daemon.nodeId;
  /* Only the current coordinator can report its non-empty assignment failures. */
  const assignment = self ? (status?.lastAssignment ?? undefined) : undefined;
  const unplaced = assignment?.unplaced ?? [];

  return {
    node: lease.node,
    fence: lease.fence,
    self,
    ...(unplaced.length === 0
      ? {}
      : {
          unplaced: unplaced.map((entry) => ({ ...entry })),
        }),
  };
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

function artifactStager(daemon: DaemonContext): ArtifactStager {
  if (daemon.artifactStager !== undefined) return daemon.artifactStager;
  throw new ScafoError("capability-missing", "Artifact staging is unavailable", {
    detail: "no file-backed artifact stager is configured on this node",
  });
}
