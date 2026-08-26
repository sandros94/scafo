import { ScafoError } from "../core/error.ts";
import type { CreditAccount } from "../core/capacity/credits.ts";
import type { StagedArtifact } from "../core/types/deploy.ts";
import type { CreditController, CreditHold, CreditOwner } from "./_credit-controller.ts";

export const DEFAULT_ACTIVE_TASKS: number = 1;
export const DEFAULT_DEPLOY_CREDIT_MB: number = 1024;
export const DEFAULT_PROJECT_ACTIVE_TASKS: number = 1;
export const DEFAULT_QUEUED_TASKS: number = 4;
export const DEFAULT_PROJECT_QUEUED_TASKS: number = 2;
export const DEFAULT_STAGED_BYTES: number = 5 * 1024 ** 3;
export const DEFAULT_PROJECT_STAGED_BYTES: number = 3 * 1024 ** 3;
export const DEFAULT_RECEIVE_TIMEOUT_MS: number = 600_000;
export const DEFAULT_QUEUE_TIMEOUT_MS: number = 600_000;
export const DEFAULT_TASK_TIMEOUT_MS: number = 300_000;
export const DEFAULT_OUTPUT_BYTES: number = 65_536;

export interface DeploySchedulerOptions {
  /** The node-wide controller active deploy work must reserve against. */
  credits: CreditController;
  /** Whole MiB one active deploy reserves until its staged artifact is gone. */
  creditMb: number;
  artifactBytes: number;
  activeTasks: number;
  projectActiveTasks: number;
  queuedTasks: number;
  projectQueuedTasks: number;
  stagedBytes: number;
  projectStagedBytes: number;
  receiveTimeoutMs: number;
  queueTimeoutMs: number;
  taskTimeoutMs: number;
}

export interface ScheduledDeploy<T> {
  completion: Promise<T>;
}

export interface DeployReservation {
  readonly project: string;
  signal: AbortSignal;
  cancel(reason?: unknown): void;
  /** Disposes a completed artifact rejected before enqueue, then releases capacity. */
  discard(artifact: StagedArtifact, reason?: unknown): Promise<void>;
  enqueue<T>(
    artifact: StagedArtifact,
    task: (signal: AbortSignal) => Promise<T>,
  ): ScheduledDeploy<T>;
}

export interface DeploySchedulerUsage {
  /** The shared node account, for typed observability without message parsing. */
  credit: Readonly<CreditAccount>;
  activeTasks: number;
  queuedTasks: number;
  stagedBytes: number;
  projects: Record<string, ProjectUsage>;
}

export interface ProjectUsage {
  activeTasks: number;
  queuedTasks: number;
  stagedBytes: number;
}

export interface DeployScheduler {
  reserve(project: string): DeployReservation;
  usage(): DeploySchedulerUsage;
  stop(reason: unknown): Promise<void>;
}

interface Job {
  creditOwner: CreditOwner;
  credit?: CreditHold;
  project: string;
  artifact: StagedArtifact;
  byteLength: number;
  task: (signal: AbortSignal) => Promise<unknown>;
  settled: PromiseWithResolvers<unknown>;
  queuedAt: number;
  controller?: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
  phase: "queued" | "active" | "cleanup";
}

interface ProjectState extends ProjectUsage {
  queue: Job[];
  ready: boolean;
}

interface FailedDiscard {
  project: string;
  artifact: StagedArtifact;
  bytes: number;
}

interface Receiving {
  abort(reason: unknown): void;
  settled: Promise<void>;
}

/** One node-wide deploy scheduler and all accounting it owns. */
export function createDeployScheduler(options: DeploySchedulerOptions): DeployScheduler {
  validateOptions(options);
  const projects = new Map<string, ProjectState>();
  const ready: string[] = [];
  const receiving = new Set<Receiving>();
  const active = new Set<Job>();
  const stuck = new Set<Job>();
  const failedDiscards = new Set<FailedDiscard>();
  const pendingCleanups = new Set<Promise<void>>();
  let activeTasks = 0;
  let queuedTasks = 0;
  let stagedBytes = 0;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let stopPromise: Promise<void> | undefined;
  let dispatching = false;
  let dispatchRequested = false;
  const unsubscribe = options.credits.subscribe(() => dispatch());
  const schedulerId = nextSchedulerId++;
  let nextJobId = 0;

  const stateOf = (project: string): ProjectState => {
    let state = projects.get(project);
    if (state === undefined) {
      state = { activeTasks: 0, queuedTasks: 0, stagedBytes: 0, queue: [], ready: false };
      projects.set(project, state);
    }
    return state;
  };

  const removeEmpty = (project: string, state: ProjectState): void => {
    if (state.activeTasks === 0 && state.queuedTasks === 0 && state.stagedBytes === 0) {
      projects.delete(project);
    }
  };

  const releaseQueued = (project: string, bytes: number): void => {
    const state = projects.get(project);
    if (state === undefined || state.queuedTasks <= 0 || state.stagedBytes < bytes) {
      throw new Error("deploy scheduler queued accounting underflow");
    }
    queuedTasks -= 1;
    stagedBytes -= bytes;
    state.queuedTasks -= 1;
    state.stagedBytes -= bytes;
    removeEmpty(project, state);
  };

  const releaseActive = (job: Job): void => {
    const state = projects.get(job.project);
    if (state === undefined || state.activeTasks <= 0 || state.stagedBytes < job.byteLength) {
      throw new Error("deploy scheduler active accounting underflow");
    }
    /* Release the external reservation before mutating local accounting. If the
       controller refuses, stop can retry the intact active job without lying
       about either resource. */
    job.credit?.release();
    job.credit = undefined;
    activeTasks -= 1;
    stagedBytes -= job.byteLength;
    state.activeTasks -= 1;
    state.stagedBytes -= job.byteLength;
    active.delete(job);
    removeEmpty(job.project, state);
  };

  const releaseQueuedJob = (job: Job): void => {
    /* A synchronous stop may claim a queued job while dispatch is acquiring its
       hold. The job owns that hold through cleanup, just like active work. */
    job.credit?.release();
    job.credit = undefined;
    releaseQueued(job.project, job.byteLength);
  };

  const markReady = (project: string, state: ProjectState): void => {
    if (
      state.ready ||
      state.queue.length === 0 ||
      state.activeTasks >= options.projectActiveTasks
    ) {
      return;
    }
    state.ready = true;
    ready.push(project);
  };

  const trackCleanup = (cleanup: Promise<void>): Promise<void> => {
    pendingCleanups.add(cleanup);
    void cleanup.then(
      () => pendingCleanups.delete(cleanup),
      () => pendingCleanups.delete(cleanup),
    );
    return cleanup;
  };

  const rejectAfterDispose = async (job: Job, reason: unknown): Promise<void> => {
    job.phase = "cleanup";
    try {
      await job.artifact.dispose();
      releaseQueuedJob(job);
      job.settled.reject(reason);
    } catch (error) {
      stuck.add(job);
      job.settled.reject(error);
    }
  };

  const expireQueued = (): void => {
    const now = performance.now();
    for (const [project, state] of projects) {
      const keep: Job[] = [];
      for (const job of state.queue) {
        if (job.queuedAt + options.queueTimeoutMs <= now) {
          void trackCleanup(rejectAfterDispose(job, deadline("queue", options.queueTimeoutMs)));
        } else {
          keep.push(job);
        }
      }
      state.queue = keep;
      if (keep.length === 0) state.ready = false;
      else markReady(project, state);
    }
  };

  const scheduleQueueTimer = (): void => {
    if (queueTimer !== undefined) clearTimeout(queueTimer);
    let earliest = Number.POSITIVE_INFINITY;
    for (const state of projects.values()) {
      for (const job of state.queue) earliest = Math.min(earliest, job.queuedAt);
    }
    if (!Number.isFinite(earliest)) {
      queueTimer = undefined;
      return;
    }
    queueTimer = setTimeout(
      () => {
        queueTimer = undefined;
        expireQueued();
        dispatch();
      },
      Math.max(0, earliest + options.queueTimeoutMs - performance.now()),
    );
  };

  const execute = async (job: Job): Promise<void> => {
    const controller = job.controller as AbortController;
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      const value = await job.task(controller.signal);
      outcome = controller.signal.aborted
        ? { ok: false, error: controller.signal.reason }
        : { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (job.deadline !== undefined) clearTimeout(job.deadline);

    try {
      await job.artifact.dispose();
      releaseActive(job);
    } catch (error) {
      stuck.add(job);
      job.settled.reject(error);
      return;
    }

    if (outcome.ok) job.settled.resolve(outcome.value);
    else job.settled.reject(outcome.error);
    const state = projects.get(job.project);
    if (state !== undefined) markReady(job.project, state);
    dispatch();
  };

  function dispatch(): void {
    if (dispatching) {
      dispatchRequested = true;
      return;
    }
    dispatching = true;
    try {
      do {
        dispatchRequested = false;
        expireQueued();
        while (!closed && activeTasks < options.activeTasks && ready.length > 0) {
          const project = ready.shift() as string;
          const state = projects.get(project);
          if (state === undefined) continue;
          state.ready = false;
          if (state.activeTasks >= options.projectActiveTasks) continue;
          const job = state.queue[0];
          if (job === undefined || job.phase !== "queued") continue;

          const credit = options.credits.tryReserveDeploy({
            owner: job.creditOwner,
            mb: options.creditMb,
          });
          if (credit === undefined) {
            state.ready = true;
            ready.unshift(project);
            break;
          }
          job.credit = credit;

          /* Reservation notifies synchronously. A listener may close the
             scheduler and hand this queued job to stop cleanup before the hold
             returns, so activation must prove it still owns the same head. */
          if (closed || state.queue[0] !== job || job.phase !== "queued") {
            continue;
          }

          state.queue.shift();
          queuedTasks -= 1;
          state.queuedTasks -= 1;
          activeTasks += 1;
          state.activeTasks += 1;
          job.phase = "active";
          job.controller = new AbortController();
          job.deadline = setTimeout(
            () => job.controller?.abort(deadline("task", options.taskTimeoutMs)),
            options.taskTimeoutMs,
          );
          active.add(job);
          markReady(project, state);
          queueMicrotask(() => void execute(job));
        }
      } while (dispatchRequested && !closed);
    } finally {
      dispatching = false;
      scheduleQueueTimer();
    }
  }

  const scheduler: DeployScheduler = {
    reserve(project): DeployReservation {
      if (closed) throw overloaded("deploy admission is closed while this node stops");
      const state = stateOf(project);
      if (
        queuedTasks + 1 > options.queuedTasks ||
        state.queuedTasks + 1 > options.projectQueuedTasks ||
        stagedBytes + options.artifactBytes > options.stagedBytes ||
        state.stagedBytes + options.artifactBytes > options.projectStagedBytes
      ) {
        removeEmpty(project, state);
        throw overloaded("this node has no queued deploy or staged-byte capacity");
      }

      queuedTasks += 1;
      stagedBytes += options.artifactBytes;
      state.queuedTasks += 1;
      state.stagedBytes += options.artifactBytes;
      const controller = new AbortController();
      const ownership = Promise.withResolvers<void>();
      let entry: Receiving;
      let phase: "receiving" | "aborting" | "queued" | "cleanup" | "cancelled" = "receiving";
      let receiveTimer: ReturnType<typeof setTimeout>;

      const finishReceiving = (): void => {
        if (!receiving.delete(entry)) return;
        ownership.resolve();
      };
      const abortReceiving = (reason: unknown): void => {
        if (phase !== "receiving") return;
        phase = "aborting";
        clearTimeout(receiveTimer);
        controller.abort(reason);
      };

      const reservation: DeployReservation = {
        project,
        signal: controller.signal,
        cancel(reason = new Error("deploy receive cancelled")): void {
          if (phase !== "receiving" && phase !== "aborting") {
            throw new ScafoError("invalid-input", "Deploy reservation was already consumed");
          }
          phase = "cancelled";
          clearTimeout(receiveTimer);
          controller.abort(reason);
          releaseQueued(project, options.artifactBytes);
          finishReceiving();
        },
        discard(
          artifact: StagedArtifact,
          reason = new Error("deploy receive rejected"),
        ): Promise<void> {
          if (phase !== "receiving" && phase !== "aborting") {
            throw new ScafoError("invalid-input", "Deploy reservation was already consumed");
          }
          phase = "cleanup";
          clearTimeout(receiveTimer);
          controller.abort(reason);
          const failed: FailedDiscard = {
            project,
            artifact,
            bytes: options.artifactBytes,
          };
          return trackCleanup(
            (async (): Promise<void> => {
              try {
                await artifact.dispose();
                releaseQueued(project, options.artifactBytes);
                phase = "cancelled";
              } catch (error) {
                failedDiscards.add(failed);
                throw error;
              } finally {
                finishReceiving();
              }
            })(),
          );
        },
        enqueue<T>(
          artifact: StagedArtifact,
          task: (signal: AbortSignal) => Promise<T>,
        ): ScheduledDeploy<T> {
          if (phase !== "receiving") {
            throw new ScafoError("invalid-input", "Deploy reservation was already consumed");
          }
          assertByteLength(artifact.byteLength, options.artifactBytes);
          phase = "queued";
          clearTimeout(receiveTimer);
          const shrink = options.artifactBytes - artifact.byteLength;
          stagedBytes -= shrink;
          state.stagedBytes -= shrink;
          const settled = Promise.withResolvers<unknown>();
          settled.promise.catch(() => {});
          const job: Job = {
            creditOwner: {
              namespace: "deploy",
              id: `${String(schedulerId)}:${String(nextJobId++)}`,
            },
            project,
            artifact,
            byteLength: artifact.byteLength,
            task,
            settled,
            queuedAt: performance.now(),
            phase: "queued",
          };
          state.queue.push(job);
          finishReceiving();
          markReady(project, state);
          dispatch();
          return { completion: settled.promise as Promise<T> };
        },
      };
      entry = { abort: abortReceiving, settled: ownership.promise };
      receiving.add(entry);
      receiveTimer = setTimeout(
        () => abortReceiving(deadline("receive", options.receiveTimeoutMs)),
        options.receiveTimeoutMs,
      );
      return reservation;
    },

    usage(): DeploySchedulerUsage {
      const usage: Record<string, ProjectUsage> = {};
      for (const [project, state] of projects) {
        Object.defineProperty(usage, project, {
          value: {
            activeTasks: state.activeTasks,
            queuedTasks: state.queuedTasks,
            stagedBytes: state.stagedBytes,
          },
          enumerable: true,
        });
      }
      return {
        credit: options.credits.account,
        activeTasks,
        queuedTasks,
        stagedBytes,
        projects: usage,
      };
    },

    stop(reason): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      closed = true;
      unsubscribe();
      stopPromise = (async (): Promise<void> => {
        if (queueTimer !== undefined) clearTimeout(queueTimer);
        const receivingCleanup: Promise<void>[] = [];
        for (const entry of receiving) {
          entry.abort(reason);
          receivingCleanup.push(entry.settled);
        }
        const queuedCleanup: Promise<void>[] = [];
        for (const state of projects.values()) {
          if (state.queue.length === 0) continue;
          const jobs = state.queue.splice(0);
          state.ready = false;
          for (const job of jobs) {
            queuedCleanup.push(trackCleanup(rejectAfterDispose(job, reason)));
          }
        }
        for (const job of active) job.controller?.abort(reason);
        await Promise.allSettled([
          ...receivingCleanup,
          ...queuedCleanup,
          ...pendingCleanups,
          ...Array.from(active, (job) => job.settled.promise),
        ]);
        for (const job of stuck) {
          try {
            await job.artifact.dispose();
            if (job.phase === "active") releaseActive(job);
            else releaseQueuedJob(job);
            stuck.delete(job);
          } catch {
            /* Still charged: freeing accounting without freeing storage lies. */
          }
        }
        for (const failed of failedDiscards) {
          try {
            await failed.artifact.dispose();
            releaseQueued(failed.project, failed.bytes);
            failedDiscards.delete(failed);
          } catch {
            /* Still charged: freeing accounting without freeing storage lies. */
          }
        }
      })();
      return stopPromise;
    },
  };

  return scheduler;
}

function validateOptions(options: DeploySchedulerOptions): void {
  if (
    typeof options.credits !== "object" ||
    options.credits === null ||
    typeof options.credits.subscribe !== "function" ||
    typeof options.credits.tryReserveDeploy !== "function"
  ) {
    throw new ScafoError("invalid-input", "Invalid deploy credit controller", {
      detail: "deploy scheduling requires a shared credit controller",
    });
  }
  for (const name of [
    "creditMb",
    "artifactBytes",
    "activeTasks",
    "projectActiveTasks",
    "queuedTasks",
    "projectQueuedTasks",
    "stagedBytes",
    "projectStagedBytes",
    "receiveTimeoutMs",
    "queueTimeoutMs",
    "taskTimeoutMs",
  ] as const) {
    const value = options[name];
    const queueCount = name === "queuedTasks" || name === "projectQueuedTasks";
    if (!Number.isSafeInteger(value) || value < (queueCount ? 0 : 1)) {
      throw new ScafoError("invalid-input", "Invalid deploy scheduler limit", {
        detail: `${name} must be a ${queueCount ? "non-negative" : "positive"} safe integer`,
      });
    }
  }
  for (const [project, global] of [
    ["projectActiveTasks", "activeTasks"],
    ["projectQueuedTasks", "queuedTasks"],
    ["projectStagedBytes", "stagedBytes"],
  ] as const) {
    if (options[project] > options[global]) {
      throw new ScafoError("invalid-input", "Invalid deploy scheduler limits", {
        detail: `${project} must not exceed ${global}`,
      });
    }
  }
  if (
    options.stagedBytes < options.artifactBytes ||
    options.projectStagedBytes < options.artifactBytes
  ) {
    throw new ScafoError("invalid-input", "Invalid deploy scheduler byte limits", {
      detail: "staged byte limits must each hold one complete artifact",
    });
  }
}

let nextSchedulerId = 1;

function assertByteLength(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ScafoError("invalid-input", "Invalid staged artifact length", {
      detail: `byteLength must be a non-negative safe integer no greater than ${String(maximum)}`,
    });
  }
}

function overloaded(detail: string): ScafoError {
  return new ScafoError("deploy-overloaded", "Deploy capacity is exhausted", {
    detail,
  });
}

function deadline(phase: "receive" | "queue" | "task", milliseconds: number): Error {
  return new ScafoError("deploy-timeout", `Deploy ${phase} deadline elapsed`, {
    detail: `the ${phase} deadline elapsed after ${String(milliseconds)}ms`,
  });
}
