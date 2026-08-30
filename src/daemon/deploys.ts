/*
 * Deploy intake: what happens to an artifact between the request that uploads it
 * and the environment that ends up serving it.
 *
 * A deploy is accepted and answered immediately, then carried out in the
 * background — publishing an artifact takes longer than a request should wait on.
 * Progress is reported through a status object the caller polls.
 */

import { describeError, isScafoError, ScafoError } from "../core/error.ts";
import { createBuild } from "../core/registry/builds.ts";
import { recordDeployment } from "../core/registry/_deployment.ts";
import { createEnvironment, getEnvironment } from "../core/registry/environments.ts";
import { fleetPrefix } from "../core/registry/paths.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import { assertProjectUnblocked, createProject } from "../core/registry/projects.ts";
import {
  DEFAULT_ARTIFACT_BYTES,
  type DeployRunner,
  type StagedArtifact,
} from "../core/types/deploy.ts";
import type {
  BuildRecord,
  BuildSource,
  NodeSelector,
  OidcActor,
  ReplicaCount,
  ScafoWarning,
} from "../core/types/registry.ts";
import { startBudget } from "../core/utils/budget.ts";
import { createRoutedWatch } from "./_routed.ts";
import type { DaemonContext } from "./app.ts";
import {
  createDeployScheduler,
  DEFAULT_ACTIVE_TASKS,
  DEFAULT_DEPLOY_CREDIT_MB,
  DEFAULT_PROJECT_ACTIVE_TASKS,
  DEFAULT_PROJECT_QUEUED_TASKS,
  DEFAULT_PROJECT_STAGED_BYTES,
  DEFAULT_QUEUED_TASKS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_RECEIVE_TIMEOUT_MS,
  DEFAULT_STAGED_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
  type DeployReservation,
  type DeploySchedulerOptions,
} from "./_deploy-scheduler.ts";

/** How long a deploy waits to be observed serving traffic. */
export const DEFAULT_ROUTED_TIMEOUT_MS: number = 120_000;

/** Time between two looks at what the reconcile loop reports. */
export const DEFAULT_POLL_MS: number = 500;

/**
 * Deploys remembered at once. The map is soft state with no upper bound of its
 * own, so the oldest are forgotten to keep a long-lived daemon from growing.
 */
export const DEFAULT_HISTORY: number = 256;

/**
 * How far a deploy has got. Exactly three of these are final — `deployed`,
 * `routed` and `failed` — so a client polls until it reaches one of them and
 * never has to guess whether a state it sees is still moving.
 *
 * - `accepted` — the project and environment exist and the artifact is in hand.
 * - `uploading` — work is under way: the artifact is being published, and when
 *   brought into service afterwards.
 * - `deployed` — the build is current, but no assigned node was seen serving it.
 * - `routed` — a process serving that build has passed its readiness gate.
 * - `failed` — the deploy did not complete. Its detail states when celld already
 *   moved current before Scafo could record the matching registry marker.
 */
export type DeployState = "accepted" | "uploading" | "deployed" | "routed" | "failed";

/** What a caller polling a deploy is told. */
export interface DeployStatus {
  id: string;
  project: string;
  /** Build the deploy produced; absent until it has been recorded. */
  build?: string;
  state: DeployState;
  /** Why it failed, when it did. */
  detail?: string;
  warnings: ScafoWarning[];
}

/** Everything a deploy request carries besides the artifact itself. */
export interface DeployMeta {
  project: string;
  environment: string;
  /** Name the runtime files this application under within the environment's fleet. */
  script: string;
  /** Id to record the build as; defaults to the version the runtime assigned. */
  buildId?: string;
  runtimeConfigurable: boolean;
  builtWithVarset?: string;
  /**
   * How many nodes should serve the environment. Absent says nothing about
   * placement, and an environment that already exists keeps what it has.
   */
  replicas?: ReplicaCount;
  /**
   * Which nodes may serve the environment, by the labels they carry. Absent says
   * nothing about placement, and an environment that already exists keeps the
   * selector it has.
   */
  nodeSelector?: NodeSelector;
  source?: BuildSource;
  /** Verified workload identity, assigned only by the deploy-auth boundary. */
  oidc?: OidcActor;
}

export interface DeployServiceOptions {
  /** Defaults to {@link DEFAULT_ROUTED_TIMEOUT_MS}. */
  routedTimeoutMs?: number;
  /** Defaults to {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Defaults to {@link DEFAULT_HISTORY}. */
  history?: number;
  scheduler?: Omit<DeploySchedulerOptions, "credits" | "creditMb"> &
    Partial<Pick<DeploySchedulerOptions, "credits" | "creditMb">>;
}

export interface DeployService {
  /** Atomically reserves receive capacity before the request body is read. */
  reserve(project: string): DeployReservation;
  /**
   * Validates the project and environment before any artifact bytes are read.
   * No status exists until the returned admission is started with a complete
   * staged artifact.
   */
  admit(meta: DeployMeta): Promise<DeployAdmission>;
  /** The deploy's status, or null when this daemon has never heard of it. */
  get(id: string): DeployStatus | null;
  /** Closes admission and joins every receive, task, watch, and cleanup. */
  stop(reason: unknown): Promise<void>;
}

/** One validated deploy waiting only for a complete staged artifact. */
export interface DeployAdmission {
  /** Transfers artifact ownership to background deploy processing. */
  start(artifact: StagedArtifact, reservation: DeployReservation): DeployStatus;
}

/**
 * Builds the deploy intake for this node.
 *
 * Statuses live in memory only: a daemon that restarts forgets every deploy that
 * was in flight, including ones it had already accepted. What it does not forget
 * is the registry — a build recorded before the restart is still there, and
 * still startable — so a client that loses track of a deploy re-runs it rather
 * than being left with a half-applied one.
 */
export function createDeployService(
  daemon: DaemonContext,
  runner: DeployRunner,
  opts?: DeployServiceOptions,
): DeployService {
  const routedTimeoutMs = opts?.routedTimeoutMs ?? DEFAULT_ROUTED_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const history = Math.max(1, opts?.history ?? DEFAULT_HISTORY);
  const deploy = daemon.config.deploy;
  const schedulerOptions = opts?.scheduler;
  const credits = schedulerOptions?.credits ?? daemon.credits;
  if (credits === undefined) {
    throw new ScafoError("invalid-input", "Missing deploy credit controller", {
      detail: "deploy admission requires the node-wide credit controller",
    });
  }
  const scheduler = createDeployScheduler({
    credits,
    creditMb: schedulerOptions?.creditMb ?? deploy?.creditMb ?? DEFAULT_DEPLOY_CREDIT_MB,
    artifactBytes: deploy?.artifactBytes ?? DEFAULT_ARTIFACT_BYTES,
    activeTasks: deploy?.activeTasks ?? DEFAULT_ACTIVE_TASKS,
    projectActiveTasks: deploy?.projectActiveTasks ?? DEFAULT_PROJECT_ACTIVE_TASKS,
    queuedTasks: deploy?.queuedTasks ?? DEFAULT_QUEUED_TASKS,
    projectQueuedTasks: deploy?.projectQueuedTasks ?? DEFAULT_PROJECT_QUEUED_TASKS,
    stagedBytes: deploy?.stagedBytes ?? DEFAULT_STAGED_BYTES,
    projectStagedBytes: deploy?.projectStagedBytes ?? DEFAULT_PROJECT_STAGED_BYTES,
    receiveTimeoutMs: deploy?.receiveTimeoutMs ?? DEFAULT_RECEIVE_TIMEOUT_MS,
    queueTimeoutMs: deploy?.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
    taskTimeoutMs: deploy?.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
    ...schedulerOptions,
  });
  const stopping = new AbortController();
  const continuations = new Set<Promise<void>>();

  const statuses = new Map<string, DeployStatus>();

  function update(id: string, patch: Partial<DeployStatus>): DeployStatus | null {
    const current = statuses.get(id);
    if (current === undefined) return null;

    const next: DeployStatus = { ...current, ...patch };
    statuses.set(id, next);
    return next;
  }

  function warn(id: string, warning: ScafoWarning): void {
    const current = statuses.get(id);
    if (current !== undefined) update(id, { warnings: [...current.warnings, warning] });
  }

  /**
   * Waits for the new build to be reported serving traffic.
   *
   * WATCHED WHERE IT WAS PLACED, NOT WHERE IT WAS UPLOADED. A deploy is accepted
   * by whichever node the caller reached, and which nodes serve the environment
   * is the coordinator's decision, taken afterwards — so this asks THIS node's
   * processes first and, when the placement names other nodes, asks those
   * (`_routed.ts`). Without that, a deploy sent to any node but the one placement
   * happened to choose spent its whole budget watching a node that was never
   * going to start anything.
   *
   * Running out of time is a warning and never a failure: the build exists,
   * celld published it and the deployment notice was recorded, so the loop will
   * keep trying long after this deploy stopped watching.
   */
  async function awaitRouted(
    id: string,
    meta: DeployMeta,
    target: { build: string; celldVersionId: string; revision: number },
    signal: AbortSignal,
  ): Promise<void> {
    const giveUp = async (detail: string): Promise<void> => {
      update(id, { state: "deployed" });
      warn(id, { code: "deploy-not-routed", detail });
    };

    if (daemon.reconciler === undefined) {
      await giveUp(
        `build "${target.build}" was deployed and made current, but this node runs no ` +
          `reconcile loop, so nothing here will start it`,
      );
      return;
    }

    const watch = createRoutedWatch(daemon, {
      project: meta.project,
      env: meta.environment,
      revision: target.revision,
      version: target.celldVersionId,
    });

    /* A duration rather than a moment in time, so it is measured monotonically
       (`utils/budget.ts`): a wall clock stepping forward mid-wait would cut this
       short and warn that nothing was serving the build while the loop was still
       bringing it up. */
    const remaining = startBudget(routedTimeoutMs);
    for (;;) {
      throwIfStopped(signal);
      if (await watch.routed()) {
        update(id, { state: "routed" });
        return;
      }
      if (remaining() <= 0) {
        await giveUp(
          `build "${target.build}" was deployed and made current, but no process serving it ` +
            `had passed its readiness gate after ${String(routedTimeoutMs)}ms` +
            /* Named, because a deploy that was watching another node entirely is
               the one case where "nothing was ready" is not about this node. */
            `${watchedOn(watch.asked())}`,
        );
        return;
      }
      await delay(pollMs, signal);
    }
  }

  async function publish(
    id: string,
    meta: DeployMeta,
    artifact: StagedArtifact,
    signal: AbortSignal,
  ): Promise<{ build: BuildRecord; celldVersionId: string; revision: number }> {
    update(id, { state: "uploading" });
    const bucket = daemon.config.bucket;
    let celldVersionId: string | undefined;
    try {
      const published = await runner.run(
        {
          project: meta.project,
          environment: meta.environment,
          script: meta.script,
          artifact,
          target: {
            endpoint: bucket.endpoint,
            region: bucket.region,
            bucket: bucket.bucket,
            prefix: joinPrefix(bucket.prefix, fleetPrefix(meta.project, meta.environment)),
            accessKey: bucket.accessKey,
            secretKey: bucket.secretKey,
          },
        },
        { signal },
      );
      celldVersionId = published.celldVersionId;

      throwIfStopped(signal);
      const build = await createBuild(daemon.registry, meta.project, {
        id: meta.buildId ?? published.celldVersionId,
        celldVersionId: published.celldVersionId,
        runtimeConfigurable: meta.runtimeConfigurable,
        ...(meta.builtWithVarset === undefined ? {} : { builtWithVarset: meta.builtWithVarset }),
        ...(meta.source === undefined ? {} : { source: meta.source }),
        ...(meta.oidc === undefined ? {} : { oidc: meta.oidc }),
      });
      update(id, { build: build.id });
      throwIfStopped(signal);
      const current = await recordDeployment(
        daemon.registry,
        meta.project,
        meta.environment,
        build.id,
        { signal },
      );
      for (const warning of current.warnings) warn(id, warning);
      throwIfStopped(signal);
      return { build, celldVersionId: published.celldVersionId, revision: current.revision };
    } catch (error) {
      if (celldVersionId === undefined) throw error;
      throw new Error(
        `celld published version "${celldVersionId}", but Scafo could not confirm or finish ` +
          `recording its deployment revision: ${boundedDetail(error)}`,
        { cause: error },
      );
    }
  }

  async function finish(
    id: string,
    meta: DeployMeta,
    published: { build: BuildRecord; celldVersionId: string; revision: number },
  ): Promise<void> {
    try {
      /* Starting, gating and routing the new build is the reconcile loop's job;
         this only watches for it to happen, and settles the state either way. */
      await awaitRouted(
        id,
        meta,
        {
          build: published.build.id,
          celldVersionId: published.celldVersionId,
          revision: published.revision,
        },
        stopping.signal,
      );
    } catch (error) {
      update(id, {
        state: "failed",
        detail:
          `celld published and Scafo recorded build "${published.build.id}", but stopped ` +
          `before its routing watch finished: ${boundedDetail(error)}`,
      });
    }
  }

  return {
    reserve(project): DeployReservation {
      return scheduler.reserve(project);
    },

    async admit(meta): Promise<DeployAdmission> {
      /* Done before the deploy is acknowledged: a project or environment name
         the registry refuses is the caller's mistake and must be answered as
         one, not buried in a status it has to poll for. */
      const project = await createProject(daemon.registry, { slug: meta.project });
      /*
       * A BLOCKED PROJECT ACCEPTS NOTHING, checked off the record `createProject`
       * has just handed back rather than with a read of its own — an existing
       * project is returned as it stands, and a project this call brought into
       * being cannot be blocked.
       *
       * Refused HERE, at intake, so nothing is bundled, uploaded or pointed at,
       * and the caller is told outright instead of polling a status for a
       * failure. It names the block because whoever reaches this line has
       * already been shown to reach the project — a caller outside its scope was
       * refused before the artifact was read.
       */
      assertProjectUnblocked(project);
      await ensureEnvironment(daemon, meta.project, meta.environment, {
        ...(meta.replicas === undefined ? {} : { replicas: meta.replicas }),
        ...(meta.nodeSelector === undefined ? {} : { nodeSelector: meta.nodeSelector }),
      });

      return {
        start(artifact, reserved): DeployStatus {
          if (reserved.project !== meta.project) {
            throw new ScafoError("invalid-input", "Deploy reservation belongs to another project", {
              detail: `the reservation is for "${reserved.project}", not "${meta.project}"`,
            });
          }
          const id = randomDeployId();
          const accepted: DeployStatus = {
            id,
            project: meta.project,
            state: "accepted",
            warnings: [],
          };
          /* Enqueue owns the handoff. It must succeed before an id becomes
             observable; a refused one leaves no ghost status or history row. */
          const scheduled = reserved.enqueue(artifact, (signal) =>
            publish(id, meta, artifact, signal),
          );
          statuses.set(id, accepted);
          forget(statuses, history);
          const answer = snapshot(accepted);
          const continuation = scheduled.completion.then(
            (build) => finish(id, meta, build),
            (error) => {
              update(id, { state: "failed", detail: boundedDetail(error) });
            },
          );
          continuations.add(continuation);
          void continuation.finally(() => continuations.delete(continuation));
          return answer;
        },
      };
    },

    get(id): DeployStatus | null {
      const status = statuses.get(id);
      return status === undefined ? null : snapshot(status);
    },

    async stop(reason): Promise<void> {
      stopping.abort(reason);
      await scheduler.stop(reason);
      await Promise.allSettled(continuations);
    },
  };
}

/**
 * The environment a deploy names, created when it is not there yet.
 *
 * A deploy asks for an environment to EXIST; it says nothing about how that
 * environment is configured. Creating one outright would say something:
 * `ephemeral` is part of an environment's identity and defaults to false, so a
 * deploy aimed at a preview environment that was created ephemeral would be
 * refused for disagreeing about a setting the deploy never expressed.
 *
 * Reading first and creating only what is missing is the same intent without
 * that opinion. Two deploys racing to create one environment still both end in
 * `createEnvironment`, which is idempotent for matching settings.
 *
 * The two PLACEMENT settings — `replicas` and `nodeSelector` — are the only ones
 * a deploy may state about an environment that already exists, and only when
 * they were asked for explicitly: where and how widely an application runs is an
 * operational decision, and a deploy that silently rewrote it would move that
 * application because someone re-ran a pipeline with a stale flag. Neither can
 * be CLEARED here for the same reason; that takes a command that says so.
 */
async function ensureEnvironment(
  daemon: DaemonContext,
  project: string,
  environment: string,
  wanted: { replicas?: ReplicaCount; nodeSelector?: NodeSelector },
): Promise<void> {
  let exists = true;
  try {
    await getEnvironment(daemon.registry, project, environment);
  } catch (error) {
    if (!isScafoError(error) || error.code !== "not-found") throw error;
    exists = false;
  }

  if (!exists) {
    await createEnvironment(daemon.registry, project, { name: environment, ...wanted });
    return;
  }
  if (wanted.replicas !== undefined) {
    await setReplicas(daemon.registry, project, environment, wanted.replicas);
  }
  if (wanted.nodeSelector !== undefined) {
    await setNodeSelector(daemon.registry, project, environment, wanted.nodeSelector);
  }
}

/**
 * Where the watch had got to, for a warning to say so. Empty on the ordinary
 * path — this node's own processes were the answer — and then the warning says
 * nothing extra at all.
 */
function watchedOn(nodes: readonly string[]): string {
  if (nodes.length === 0) return "";
  return `, on the node${nodes.length === 1 ? "" : "s"} its placement names (${nodes.join(", ")})`;
}

/** Drops the oldest deploys once more than `keep` are remembered. */
function forget(statuses: Map<string, DeployStatus>, keep: number): void {
  for (const id of statuses.keys()) {
    if (statuses.size <= keep) return;
    statuses.delete(id);
  }
}

function snapshot(status: DeployStatus): DeployStatus {
  return { ...status, warnings: status.warnings.map((warning) => ({ ...warning })) };
}

/** Joins the installation's key prefix to a fleet prefix. */
function joinPrefix(keyPrefix: string | undefined, fleet: string): string {
  const trimmed = keyPrefix?.replaceAll(/^\/+|\/+$/g, "") ?? "";
  return trimmed === "" ? fleet : `${trimmed}/${fleet}`;
}

/** Unguessable, so knowing an id is itself evidence of having started the deploy. */
function randomDeployId(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** The specifics a scafo failure carries are the useful half; keep both. */
function boundedDetail(error: unknown): string {
  const encoded = new TextEncoder().encode(describeError(error));
  if (encoded.byteLength <= 4096) return new TextDecoder().decode(encoded);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = 4096; end > 4092; end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {}
  }
  return "";
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, ms);
    const cancel = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason);
    };
    function done(): void {
      signal.removeEventListener("abort", cancel);
      resolve();
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}
