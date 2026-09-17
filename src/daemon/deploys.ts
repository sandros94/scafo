/* Asynchronous deploy intake: accepts staged artifacts, schedules publishing,
   and exposes bounded in-memory status history. */

import { describeError, isScafoError, ScafoError } from "../core/error.ts";
import { servingKey } from "../core/placement/serving.ts";
import { findVersionSkew, versionSkewError } from "../core/placement/version-skew.ts";
import { createDeployment } from "../core/registry/deployments.ts";
import { nowDate } from "../core/registry/context.ts";
import {
  createDeployRecord,
  isDeployTerminal,
  updateDeployRecord,
} from "../core/registry/deploys.ts";
import { listNodeRecords } from "../core/registry/nodes.ts";
import { recordRevision } from "../core/registry/_revision.ts";
import { createEnvironment, getEnvironment } from "../core/registry/environments.ts";
import { fleetPrefix } from "../core/registry/paths.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import { assertProjectUnblocked, createProject } from "../core/registry/projects.ts";
import { getVarset, varsetHash } from "../core/registry/varsets.ts";
import {
  DEFAULT_ARTIFACT_BYTES,
  type DeployRunner,
  type StagedArtifact,
} from "../core/types/deploy.ts";
import type {
  DeploymentRecord,
  DeploymentSource,
  CarriedVarset,
  DeployRecord,
  DeployState,
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

/* A deploy id's grammar lives with the key it is built into, so that one rule
   answers both what an id is and what may be read under it. */
export type { DeployIdParts } from "../core/registry/paths.ts";
export { parseDeployId } from "../core/registry/paths.ts";
export type { DeployState } from "../core/types/registry.ts";

/** What a caller polling a deploy is told. */
export interface DeployStatus {
  id: string;
  project: string;
  /** Deployment the deploy produced, by version; absent until it has been recorded. */
  deployment?: string;
  state: DeployState;
  /** Varset the deploy carried; set once it has been deployed, absent when none. */
  varset?: CarriedVarset;
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
  /** Optional placement intent; existing environments keep it when omitted. */
  replicas?: ReplicaCount;
  /** Optional placement intent; existing environments keep it when omitted. */
  nodeSelector?: NodeSelector;
  source?: DeploymentSource;
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
  /**
   * Records the deploy and transfers artifact ownership to background
   * processing. The record is written BEFORE the id is answered: the id is the
   * caller's only handle, and a handle nothing is recorded under is one no node
   * could ever answer for, so a record that cannot be written refuses the deploy.
   */
  start(artifact: StagedArtifact, reservation: DeployReservation): Promise<DeployStatus>;
}

/** The status a poll is answered with, read off a deploy's registry record. */
export function deployStatusOf(record: DeployRecord): DeployStatus {
  return {
    id: record.id,
    project: record.project,
    state: record.state,
    ...(record.deployment === undefined ? {} : { deployment: record.deployment }),
    ...(record.varset === undefined ? {} : { varset: record.varset }),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
  };
}

/**
 * Builds deploy intake. Every state a deploy moves through is written to its
 * registry record; the statuses kept here are this node's hot cache of the
 * deploys it accepted itself.
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
    /* Terminal means terminal. A deploy that reached `deployed` HAPPENED — its
       revision is in the registry, and the environment is serving the deployment —
       so a cancellation that lands afterwards has nothing left to cancel and
       must not rewrite the outcome as a failure. The scheduler reports one
       whenever the task's signal was aborted, whatever the task returned. */
    if (isDeployTerminal(current.state)) return current;

    const next: DeployStatus = { ...current, ...patch };
    statuses.set(id, next);
    return next;
  }

  async function publish(
    id: string,
    meta: DeployMeta,
    carried: CarriedVars | undefined,
    artifact: StagedArtifact,
    signal: AbortSignal,
  ): Promise<DeploymentRecord> {
    /* What was handed to the runtime is what the notice is stamped with: both
       come from the one read taken at admission, so an edit made while the
       artifact was uploading cannot leave the two disagreeing. */
    const stamp = carried === undefined ? undefined : { name: carried.name, hash: carried.hash };
    update(id, { state: "uploading" });
    /* The terminal write is the one that matters, so a lost `uploading` is
       reported and the deploy goes on: the record is a state behind for as long
       as the publish takes, and the reaper measures a deploy's silence in
       liveness windows rather than seconds. */
    await updateDeployRecord(daemon.registry, meta.project, id, { state: "uploading" }).catch(
      (error: unknown) => {
        console.error(
          `scafo: deploy "${id}" could not be recorded as uploading: ${describeError(error)}`,
        );
      },
    );
    const bucket = daemon.config.bucket;
    let celldVersionId: string | undefined;
    try {
      const published = await runner.run(
        {
          project: meta.project,
          environment: meta.environment,
          script: meta.script,
          ...(meta.noBundle === true ? { noBundle: true } : {}),
          ...(carried === undefined ? {} : { vars: carried.vars }),
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
      const deployment = await createDeployment(daemon.registry, meta.project, {
        version: published.celldVersionId,
        ...(meta.source === undefined ? {} : { source: meta.source }),
        ...(meta.oidc === undefined ? {} : { oidc: meta.oidc }),
      });
      update(id, { deployment: deployment.version });
      throwIfStopped(signal);
      /* The commit point. Past it the deployment revision is written and there
         is nothing left to abandon, so the signal is not consulted again: a
         cancellation that arrives now would only mislabel work that is done. */
      await recordRevision(daemon.registry, meta.project, meta.environment, deployment.version, {
        signal,
        ...(stamp === undefined ? {} : { varset: stamp }),
      });
      await updateDeployRecord(daemon.registry, meta.project, id, {
        state: "deployed",
        deployment: deployment.version,
        ...(stamp === undefined ? {} : { varset: stamp }),
      });
      update(id, { state: "deployed", ...(stamp === undefined ? {} : { varset: stamp }) });
      return deployment;
    } catch (error) {
      if (celldVersionId === undefined) throw error;
      throw new Error(
        `celld published version "${celldVersionId}", but Scafo could not confirm or finish ` +
          `recording its deployment revision: ${boundedDetail(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Records how a deploy ended when it ended badly.
   *
   * The scheduler reports every failure here, the ones that never reached
   * {@link publish} included, so this is where a deploy stops moving whatever
   * stopped it. A record that has already finished refuses the write, which is
   * the right answer for a cancellation arriving after the commit point.
   */
  async function recordFailure(id: string, project: string, detail: string): Promise<void> {
    const next = update(id, { state: "failed", detail });
    /* Already terminal HERE: nothing to record, and nothing to overwrite. A
       deploy this node has forgotten still gets the write — the bound on the
       cache is not a statement about the deploy. */
    if (next !== null && next.state !== "failed") return;

    try {
      await updateDeployRecord(daemon.registry, project, id, { state: "failed", detail });
    } catch (error) {
      if (isScafoError(error) && error.code === "cas-conflict") return;
      console.error(
        `scafo: deploy "${id}" could not be recorded as failed: ${describeError(error)}`,
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
      const carried = await carriedVars(daemon, meta.project, meta.environment);

      return {
        async start(artifact, reserved): Promise<DeployStatus> {
          if (reserved.project !== meta.project) {
            throw new ScafoError("invalid-input", "Deploy reservation belongs to another project", {
              detail: `the reservation is for "${reserved.project}", not "${meta.project}"`,
            });
          }
          const id = deployId(meta.project);
          /* Before anything is enqueued: a deploy whose record could not be
             written is one the caller is told about now, rather than one it
             holds an id for that no node will ever answer. */
          await createDeployRecord(daemon.registry, meta.project, {
            id,
            environment: meta.environment,
            node: daemon.nodeId,
            ...(meta.source === undefined ? {} : { source: meta.source }),
            ...(meta.oidc === undefined ? {} : { oidc: meta.oidc }),
          });

          const accepted: DeployStatus = {
            id,
            project: meta.project,
            state: "accepted",
          };
          /* Enqueue before exposing an id to avoid ghost statuses. */
          const scheduled = reserved.enqueue(artifact, (signal) =>
            publish(id, meta, carried, artifact, signal),
          );
          statuses.set(id, accepted);
          forget(statuses, history);
          const answer = snapshot(accepted);
          const continuation = scheduled.completion.then(
            () => undefined,
            (error) => recordFailure(id, meta.project, boundedDetail(error)),
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

/** A varset as one deploy carries it: its name, its variables, and their digest. */
interface CarriedVars extends CarriedVarset {
  vars: Record<string, string>;
}

/**
 * The variables the environment's deploys carry, read once at intake.
 *
 * A varset the environment names but that is not there stops the deploy HERE,
 * before a byte of the artifact is read: publishing without it would start the
 * application on variables nobody chose for it, and which of the two ways out is
 * meant — write the varset again, or stop carrying one — is not Scafo's to guess.
 */
async function carriedVars(
  daemon: DaemonContext,
  project: string,
  environment: string,
): Promise<CarriedVars | undefined> {
  const name = (await getEnvironment(daemon.registry, project, environment)).varset;
  if (name === undefined) return undefined;

  try {
    const varset = await getVarset(daemon.registry, project, name);
    return { name, vars: varset.vars, hash: await varsetHash(varset.vars) };
  } catch (error) {
    if (!isScafoError(error)) throw error;
    if (error.code !== "not-found" && error.code !== "invalid-varset") throw error;

    /* Two ways out, and which is meant is not scafo's to guess: the name
       may be a slug to write again, or one an earlier build filed the record
       under, which only a new record and a new pointer replace. */
    const why = error.code === "not-found" ? "no longer exists" : "this build cannot read";
    throw new ScafoError(error.code, "Varset cannot be carried", {
      detail:
        `"${project}/${environment}" carries varset "${name}", which ${why}: write a varset ` +
        `with "scafo varset set --project ${project} --name <name> --file <file>" and point ` +
        `the environment at it with "scafo env varset --project ${project} --env ` +
        `${environment} --name <name>", or stop it carrying one with "scafo env varset ` +
        `--project ${project} --env ${environment} --none"`,
      cause: error,
    });
  }
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

/**
 * Mints an id for one deploy of `project`.
 *
 * It NAMES the project, because a poll may reach any node of the installation
 * and the project is what that node authenticates the caller against — an
 * operator's scope and a workload's trust policy are both answers about a
 * project. The second half stays unguessable, so knowing a whole id remains
 * evidence of having started the deploy.
 */
export function deployId(project: string): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${project}.${hex}`;
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
