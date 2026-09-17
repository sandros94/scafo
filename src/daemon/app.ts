/* The daemon's HTTP API: what a node exposes to its peers and to operators. */

import { H3, type H3Event } from "h3";
import { createNodeVerifier, type NodeSigningKey } from "../core/auth/node-token.ts";
import { createOidcVerifier } from "../core/auth/oidc.ts";
import { ScafoError } from "../core/error.ts";
import { APEX_ENVIRONMENT } from "../core/placement/routes.ts";
import { deploymentRevision } from "../core/registry/_revision.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { checkDomain } from "../core/registry/domains.ts";
import { isProjectBlocked } from "../core/registry/projects.ts";
import { isLeaseExpired } from "../core/registry/lease.ts";
import { getDeployRecord } from "../core/registry/deploys.ts";
import { coordinatorKey, environmentKey, nodeKey, parseDeployId } from "../core/registry/paths.ts";
import { setNodeSelector } from "../core/registry/placement.ts";
import { retireEnvironment, unretireEnvironment } from "../core/registry/retirement.ts";
import type { IngressFormat } from "../core/types/ingress.ts";
import {
  DEFAULT_ARTIFACT_BYTES,
  type ArtifactStager,
  type StagedArtifact,
} from "../core/types/deploy.ts";
import type {
  CoordinatorLease,
  EnvironmentRecord,
  NodeRecord,
  NodeVersions,
} from "../core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../core/types/supervisor.ts";
import { isHost } from "../core/utils/host.ts";
import { assertSlug, parseHostLabel } from "../core/utils/slug.ts";
import type { AssignmentFailure } from "./_assign.ts";
import { deleteEnvironmentRequest } from "./_environments.ts";
import { registerIngressRoutes } from "./_ingress-routes.ts";
import {
  type DeployVerifiers,
  readDeployMetadata,
  readSelectorRequest,
  verifyCaller,
} from "./_intake.ts";
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
import { assertProjectScope, scopedState } from "./_scope.ts";
import { registerOperatorRoutes } from "./_operator-routes.ts";
import { registerProjectRoutes } from "./_project-routes.ts";
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
  supervisor: Supervisor;
  /**
   * The binaries this daemon booted with, and what its node record reports. The
   * Scafo half is what `GET /.well-known/scafo/health` answers with, and the
   * Celld half is what every other node's is measured against before this one
   * starts a process for an environment or takes a deploy into it.
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
  /** Optional ingress counters, updated with routing after reconciliation. */
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
  /** Unplaced environments from this coordinator's last pass; absent otherwise. */
  unplaced?: AssignmentFailure[];
}

/** Body of `GET /v1/state`: what this node believes about itself right now. */
export interface DaemonState {
  /** This node's registry record; null until it has registered. */
  node: NodeRecord | null;
  /** Holder of the coordinator lease, whoever it is; null when nobody holds one. */
  lease: CoordinatorLease | null;
  /** Effective coordinator election result; expired lease records produce null. */
  coordinator: CoordinatorView | null;
  processes: ProcessStatus[];
  /** Placement views. Missing placement is pending, never implicit assignment. */
  placements: PlacementView[];
  /** Last pass of the reconcile loop; absent on a node that runs no loop. */
  reconcile?: ReconcileStatus;
  /** `true` when operator scope filtered this document, even if scope grants all projects. */
  scoped?: true;
}

/** Body of `DELETE /v1/environments/:project/:env`: the store keys it removed. */
export interface EnvironmentDeleted {
  deleted: string[];
}

/** Body of an environment configuration route. */
export interface EnvironmentResult {
  environment: EnvironmentRecord;
}

/**
 * Builds the node app. Every route answers failures as RFC 9457 problem
 * documents, and every route but health and the on-demand-TLS ask requires a
 * token: a node, operator or workload token, or on the storage and routing
 * surfaces the ingress token.
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

  /* Public certificate-issuance check: answers only whether a public host is served. */
  app.get("/v1/ingress/ask", async (event): Promise<Response> => {
    const domain = event.url.searchParams.get("domain") ?? "";
    if (await servesHost(daemon, domain)) return new Response(null, { status: 200 });

    throw new ScafoError("not-found", "Host is not served here", {
      detail: `"${domain}" is neither a claimed domain nor a label under a platform domain`,
    });
  });

  /* Operator tokens receive project-scoped state; peer and admin tokens receive
     the whole document. */
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

  /* Retirement is one CAS update, so it does not require coordinator authority. */
  app.post(
    "/v1/environments/:project/:env/retire",
    async (event): Promise<EnvironmentResult> => ({
      environment: await retireEnvironment(daemon.registry, ...(await scopedTarget(daemon, event))),
    }),
    { middleware: [authenticated] },
  );

  /* Retirement remains reversible during its grace period. */
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

  /* Selectors are CAS-updated intent. Unsatisfied selectors remain valid and
     are reported by assignment rather than rejected here. */
  app.post(
    "/v1/environments/:project/:env/selector",
    async (event): Promise<EnvironmentResult> => {
      const [project, name] = await scopedTarget(daemon, event);
      const request = await readSelectorRequest(event, { maxBytes: daemon.config.api.jsonBytes });
      return {
        environment: await setNodeSelector(daemon.registry, project, name, request.selector),
      };
    },
    { middleware: [authenticated] },
  );

  /* Deletion is coordinator-gated and transparently forwarded. `force=1` skips
     ephemeral and retirement-grace checks. */
  app.delete(
    "/v1/environments/:project/:env",
    async (event): Promise<Response | EnvironmentDeleted> => {
      /* Check operator scope before forwarding under a node token. */
      await scopedTarget(daemon, event);
      return deleteEnvironmentRequest(daemon, event);
    },
    { middleware: [authenticated] },
  );

  app.post("/v1/projects/:project/deploys", async (event): Promise<Response> => {
    const project = event.context.params?.project ?? "";
    assertSlug(project);
    /* Authenticate project access before reading deployment metadata or body. */
    const caller = await verifyCaller(verifiers, event, project);
    const meta = readDeployMetadata(event, project);
    if (caller.kind === "workload") meta.oidc = caller.identity.actor;

    const service = deployService(daemon);
    const stager = artifactStager(daemon);
    const reservation = service.reserve(project);
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

    /* The project in the id is what the caller is authenticated against, exactly
       as the upload was: an operator's scope is applied to it and a workload
       token is verified against its trust policy. An id that is no id of ours
       names no project, so there is nothing to authenticate and nothing to
       disclose. */
    await verifyCaller(verifiers, event, parsed?.project ?? null);
    if (parsed === null) {
      throw new ScafoError("not-found", "No such deploy", {
        detail: `"${id}" is not a deploy id this installation mints`,
      });
    }

    const local = daemon.deploys?.get(id) ?? null;
    if (local !== null) return local;

    const record = await getDeployRecord(daemon.registry, parsed.project, id);
    /* A record that disagrees with the id it is filed under is not the one the
       caller was authenticated for. */
    if (record.project !== parsed.project) {
      throw new ScafoError("not-found", "No such deploy", {
        detail: `"${id}" is not a deploy of project "${parsed.project}"`,
      });
    }
    return deployStatusOf(record);
  });

  /* Trusted-key administration requires an operator token, never a node token. */
  const operatorGuard = requireOperatorToken(nodeVerifier, daemon.registry);
  registerOperatorRoutes(app, daemon, operatorGuard);

  /* Project administration uses the same operator-only boundary. */
  registerProjectRoutes(app, daemon, operatorGuard);

  /* TLS storage carries private keys: serve it only when configured, and never
     expose it through a public ingress. */
  if (daemon.storage !== undefined) {
    registerStorageRoutes(app, daemon, daemon.storage);
    /* The routing names every node's address and port: same token, same rule. */
    registerIngressRoutes(app, daemon, daemon.storage);
  }

  return app;
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

/** Returns whether a host is currently certificate-eligible. Retired, missing,
 * and blocked project environments are refused. */
async function servesHost(daemon: DaemonContext, host: string): Promise<boolean> {
  if (!isHost(host)) return false;

  /* Wildcard certificates exclude the bare platform apex, which serves the API
     only while explicitly public. */
  if (daemon.config.api.public && daemon.config.platformDomains.includes(host)) return true;

  /* Require a deployed, unretired environment before certificate issuance. */
  for (const domain of daemon.config.platformDomains) {
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) continue;

    const label = host.slice(0, -suffix.length);
    const parsed = parseHostLabel(label);
    if (parsed === null) return false;
    if (await isProjectBlocked(daemon.registry, parsed.project)) return false;

    const environment = await readJson<EnvironmentRecord>(
      daemon.registry,
      environmentKey(parsed.project, parsed.ref ?? APEX_ENVIRONMENT),
    );
    return servesEnvironment(environment?.value);
  }

  const claim = await checkDomain(daemon.registry, host);
  if (claim === null) return false;
  if (await isProjectBlocked(daemon.registry, claim.project)) return false;

  const environment = await readJson<EnvironmentRecord>(
    daemon.registry,
    environmentKey(claim.project, claim.environment),
  );
  return servesEnvironment(environment?.value);
}

/** Whether an environment owns a currently serviceable public host. */
function servesEnvironment(environment?: EnvironmentRecord): boolean {
  return (
    environment !== undefined &&
    environment.retiredAt === undefined &&
    deploymentRevision(environment) !== null
  );
}

/** The `:project` and `:env` a route was matched on, as a positional pair. */
function target(event: H3Event): [project: string, env: string] {
  return [event.context.params?.project ?? "", event.context.params?.env ?? ""];
}

/** Returns the target after applying operator project scope before I/O. */
async function scopedTarget(
  daemon: DaemonContext,
  event: H3Event,
): Promise<[project: string, env: string]> {
  const pair = target(event);
  const caller = nodeIdentity(event);
  if (caller !== undefined) {
    assertProjectScope(caller, pair[0]);
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

function artifactStager(daemon: DaemonContext): ArtifactStager {
  if (daemon.artifactStager !== undefined) return daemon.artifactStager;
  throw new ScafoError("capability-missing", "Artifact staging is unavailable", {
    detail: "no file-backed artifact stager is configured on this node",
  });
}
