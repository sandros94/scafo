/* Asynchronous deploy intake: accepts staged artifacts, schedules publishing,
   and exposes bounded in-memory status history. */

import { describeError, isScafoError, ScafoError } from "../core/error.ts";
import { servingKey } from "../core/placement/serving.ts";
import { findVersionSkew, versionSkewError } from "../core/placement/version-skew.ts";
import { createBuild } from "../core/registry/builds.ts";
import { nowDate } from "../core/registry/context.ts";
import { listNodeRecords } from "../core/registry/nodes.ts";
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

/** Maximum in-memory deploy statuses. */
export const DEFAULT_HISTORY: number = 256;

/** Deploy lifecycle. `deployed` and `failed` are terminal; failure can follow
    a publish not yet recorded. */
export type DeployState = "accepted" | "uploading" | "deployed" | "failed";

/** The states a deploy stops moving in, and never moves out of again. */
const TERMINAL: ReadonlySet<DeployState> = new Set<DeployState>(["deployed", "failed"]);

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
  /** Optional placement intent; existing environments keep it when omitted. */
  replicas?: ReplicaCount;
  /** Optional placement intent; existing environments keep it when omitted. */
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

/** Builds deploy intake. Statuses are daemon-local; persisted builds survive a restart. */
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
    /* Terminal means terminal. A deploy that reached `deployed` HAPPENED — its
       revision is in the registry, and the environment is serving the build —
       so a cancellation that lands afterwards has nothing left to cancel and
       must not rewrite the outcome as a failure. The scheduler reports one
       whenever the task's signal was aborted, whatever the task returned. */
    if (TERMINAL.has(current.state)) return current;

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
      /* The commit point. Past it the deployment revision is written and there
         is nothing left to abandon, so the signal is not consulted again: a
         cancellation that arrives now would only mislabel work that is done. */
      await recordDeployment(daemon.registry, meta.project, meta.environment, build.id, { signal });
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
      /* Reject invalid identity before acknowledging the deploy. */
      const project = await createProject(daemon.registry, { slug: meta.project });
      /* Reject blocked projects before artifact work begins. */
      assertProjectUnblocked(project);
      await ensureEnvironment(daemon, meta.project, meta.environment, {
        ...(meta.replicas === undefined ? {} : { replicas: meta.replicas }),
        ...(meta.nodeSelector === undefined ? {} : { nodeSelector: meta.nodeSelector }),
      });
      await assertOneCelldVersion(daemon, meta.project, meta.environment);

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
          /* Enqueue before exposing an id to avoid ghost statuses. */
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
 * Refuses the deploy while another node still serves the environment on a
 * different Celld.
 *
 * ASKED AT INTAKE, before a byte of the artifact is read: publishing writes into
 * the environment's Celld fleet, whose bucket format belongs to whichever
 * version is serving it, and the caller's answer is a 409 it can act on rather
 * than an upload that is thrown away. The publish path asks nothing more — the
 * refusal has already happened, and the node the deploy lands on is this one.
 */
async function assertOneCelldVersion(
  daemon: DaemonContext,
  project: string,
  environment: string,
): Promise<void> {
  const about = { env: servingKey(project, environment), celld: daemon.versions.celld };
  const skew = findVersionSkew(await listNodeRecords(daemon.registry), {
    ...about,
    selfId: daemon.nodeId,
    now: nowDate(daemon.registry),
  });
  if (skew.length > 0) throw versionSkewError(skew, about);
}

/** Ensures an environment exists. Existing placement changes only when requested;
    creation remains idempotent under races. */
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
