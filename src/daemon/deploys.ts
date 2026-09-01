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
} from "../core/types/registry.ts";
import type { DaemonContext } from "./app.ts";
import {
  createDeployScheduler,
  DEFAULT_ACTIVE_TASKS,
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

/**
 * Deploys remembered at once. The map is soft state with no upper bound of its
 * own, so the oldest are forgotten to keep a long-lived daemon from growing.
 */
export const DEFAULT_HISTORY: number = 256;

/**
 * How far a deploy has got. Exactly two of these are final — `deployed` and
 * `failed` — so a client polls until it reaches one of them and
 * never has to guess whether a state it sees is still moving.
 *
 * - `accepted` — the project and environment exist and the artifact is in hand.
 * - `uploading` — work is under way: the artifact is being published, and when
 *   its immutable history and environment notice are persisted afterwards.
 * - `deployed` — celld published the deployment and Scafo persisted its metadata.
 * - `failed` — the deploy did not complete. Its detail states when celld may
 *   already have published before Scafo could record matching metadata.
 */
export type DeployState = "accepted" | "uploading" | "deployed" | "failed";

/** What a caller polling a deploy is told. */
export interface DeployStatus {
  id: string;
  project: string;
  /** Build the deploy produced; absent until it has been recorded. */
  build?: string;
  state: DeployState;
  /** Why it failed, when it did. */
  detail?: string;
}

/** Everything a deploy request carries besides the artifact itself. */
export interface DeployMeta {
  project: string;
  environment: string;
  /** Name the runtime files this application under within the environment's fleet. */
  script: string;
  /** Ask Celld to use the artifact's already self-contained Worker entry. */
  noBundle?: true;
  /** Id to record the build as; defaults to the version the runtime assigned. */
  buildId?: string;
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
  /** Defaults to {@link DEFAULT_HISTORY}. */
  history?: number;
  scheduler?: DeploySchedulerOptions;
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
  /** Closes admission and joins every receive, task, and cleanup. */
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
  const history = Math.max(1, opts?.history ?? DEFAULT_HISTORY);
  const deploy = daemon.config.deploy;
  const schedulerOptions = opts?.scheduler;
  const scheduler = createDeployScheduler({
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
  const continuations = new Set<Promise<void>>();

  const statuses = new Map<string, DeployStatus>();

  function update(id: string, patch: Partial<DeployStatus>): DeployStatus | null {
    const current = statuses.get(id);
    if (current === undefined) return null;

    const next: DeployStatus = { ...current, ...patch };
    statuses.set(id, next);
    return next;
  }

  async function publish(
    id: string,
    meta: DeployMeta,
    artifact: StagedArtifact,
    signal: AbortSignal,
  ): Promise<BuildRecord> {
    update(id, { state: "uploading" });
    const bucket = daemon.config.bucket;
    let celldVersionId: string | undefined;
    try {
      const published = await runner.run(
        {
          project: meta.project,
          environment: meta.environment,
          script: meta.script,
          ...(meta.noBundle === true ? { noBundle: true } : {}),
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
        ...(meta.source === undefined ? {} : { source: meta.source }),
        ...(meta.oidc === undefined ? {} : { oidc: meta.oidc }),
      });
      update(id, { build: build.id });
      throwIfStopped(signal);
      await recordDeployment(daemon.registry, meta.project, meta.environment, build.id, { signal });
      throwIfStopped(signal);
      update(id, { state: "deployed" });
      return build;
    } catch (error) {
      if (celldVersionId === undefined) throw error;
      throw new Error(
        `celld published version "${celldVersionId}", but Scafo could not confirm or finish ` +
          `recording its deployment revision: ${boundedDetail(error)}`,
        { cause: error },
      );
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
            () => undefined,
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

/** Drops the oldest deploys once more than `keep` are remembered. */
function forget(statuses: Map<string, DeployStatus>, keep: number): void {
  for (const id of statuses.keys()) {
    if (statuses.size <= keep) return;
    statuses.delete(id);
  }
}

function snapshot(status: DeployStatus): DeployStatus {
  return { ...status };
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
