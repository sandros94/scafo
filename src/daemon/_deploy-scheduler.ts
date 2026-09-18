import { ScafoError } from "../core/error.ts";
import type { StagedArtifact } from "../core/types/deploy.ts";

export const DEFAULT_ACTIVE_TASKS: number = 1;
export const DEFAULT_APPLICATION_ACTIVE_TASKS: number = 1;
export const DEFAULT_QUEUED_TASKS: number = 4;
export const DEFAULT_APPLICATION_QUEUED_TASKS: number = 2;
export const DEFAULT_STAGED_BYTES: number = 5 * 1024 ** 3;
export const DEFAULT_APPLICATION_STAGED_BYTES: number = 3 * 1024 ** 3;
export const DEFAULT_RECEIVE_TIMEOUT_MS: number = 600_000;
export const DEFAULT_QUEUE_TIMEOUT_MS: number = 600_000;
export const DEFAULT_TASK_TIMEOUT_MS: number = 300_000;
export const DEFAULT_OUTPUT_BYTES: number = 65_536;

export interface DeploySchedulerOptions {
  artifactBytes: number;
  activeTasks: number;
  applicationActiveTasks: number;
  queuedTasks: number;
  applicationQueuedTasks: number;
  stagedBytes: number;
  applicationStagedBytes: number;
  receiveTimeoutMs: number;
  queueTimeoutMs: number;
  taskTimeoutMs: number;
}

export interface ScheduledDeploy<T> {
  completion: Promise<T>;
}

export interface DeployReservation {
  readonly application: string;
  signal: AbortSignal;
  cancel(reason?: unknown): void;
  /** Disposes a completed artifact rejected before enqueue, then releases its slot and bytes. */
  discard(artifact: StagedArtifact, reason?: unknown): Promise<void>;
  enqueue<T>(
    artifact: StagedArtifact,
    task: (signal: AbortSignal) => Promise<T>,
  ): ScheduledDeploy<T>;
}

export interface DeploySchedulerUsage {
  activeTasks: number;
  queuedTasks: number;
  stagedBytes: number;
  applications: Record<string, ApplicationUsage>;
}

export interface ApplicationUsage {
  activeTasks: number;
  queuedTasks: number;
  stagedBytes: number;
}

export interface DeployScheduler {
  reserve(application: string): DeployReservation;
  usage(): DeploySchedulerUsage;
  stop(reason: unknown): Promise<void>;
}

interface Job {
  application: string;
  artifact: StagedArtifact;
  byteLength: number;
  task: (signal: AbortSignal) => Promise<unknown>;
  settled: PromiseWithResolvers<unknown>;
  queuedAt: number;
  controller?: AbortController;
  deadline?: ReturnType<typeof setTimeout>;
  phase: "queued" | "active" | "cleanup";
}

interface ApplicationState extends ApplicationUsage {
  queue: Job[];
  ready: boolean;
}

/**
 * An artifact whose disposal failed. Its bytes stay charged, because freeing
 * accounting without freeing storage lies; the task slot it held does not,
 * because the work is over and a slot pinned until restart would close deploy
 * intake for the whole node (the default is one active task). Disposal is
 * retried on every dispatch and once more at stop.
 */
interface Orphan {
  application: string;
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
  const applications = new Map<string, ApplicationState>();
  const ready: string[] = [];
  const receiving = new Set<Receiving>();
  const active = new Set<Job>();
  const orphans = new Set<Orphan>();
  const pendingCleanups = new Set<Promise<void>>();
  let activeTasks = 0;
  let queuedTasks = 0;
  let stagedBytes = 0;
  let queueTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let stopPromise: Promise<void> | undefined;
  let dispatching = false;
  let dispatchRequested = false;
  let sweeping: Promise<void> | undefined;

  const stateOf = (application: string): ApplicationState => {
    let state = applications.get(application);
    if (state === undefined) {
      state = { activeTasks: 0, queuedTasks: 0, stagedBytes: 0, queue: [], ready: false };
      applications.set(application, state);
    }
    return state;
  };

  const removeEmpty = (application: string, state: ApplicationState): void => {
    if (state.activeTasks === 0 && state.queuedTasks === 0 && state.stagedBytes === 0) {
      applications.delete(application);
    }
  };

  const releaseBytes = (application: string, bytes: number): void => {
    const state = applications.get(application);
    if (state === undefined || state.stagedBytes < bytes) {
      throw new Error("deploy scheduler staged-byte accounting underflow");
    }
    stagedBytes -= bytes;
    state.stagedBytes -= bytes;
    removeEmpty(application, state);
  };

  const releaseQueuedSlot = (application: string): void => {
    const state = applications.get(application);
    if (state === undefined || state.queuedTasks <= 0) {
      throw new Error("deploy scheduler queued accounting underflow");
    }
    queuedTasks -= 1;
    state.queuedTasks -= 1;
    removeEmpty(application, state);
  };

  const releaseActiveSlot = (job: Job): void => {
    const state = applications.get(job.application);
    if (state === undefined || state.activeTasks <= 0) {
      throw new Error("deploy scheduler active accounting underflow");
    }
    activeTasks -= 1;
    state.activeTasks -= 1;
    active.delete(job);
    removeEmpty(job.application, state);
  };

  /** Disposes an artifact and frees its bytes, or keeps them charged as an orphan. */
  const disposeCharged = async (
    application: string,
    artifact: StagedArtifact,
    bytes: number,
  ): Promise<void> => {
    try {
      await artifact.dispose();
    } catch (error) {
      orphans.add({ application, artifact, bytes });
      throw error;
    }
    releaseBytes(application, bytes);
  };

  /** Retries every orphaned disposal, one sweep at a time; whatever still fails stays charged. */
  const sweepOrphans = (): Promise<void> => {
    if (sweeping !== undefined) return sweeping;
    sweeping = trackCleanup(
      (async (): Promise<void> => {
        try {
          for (const orphan of orphans) {
            try {
              await orphan.artifact.dispose();
            } catch {
              continue;
            }
            orphans.delete(orphan);
            releaseBytes(orphan.application, orphan.bytes);
          }
        } finally {
          sweeping = undefined;
        }
      })(),
    );
    return sweeping;
  };

  const markReady = (application: string, state: ApplicationState): void => {
    if (
      state.ready ||
      state.queue.length === 0 ||
      state.activeTasks >= options.applicationActiveTasks
    ) {
      return;
    }
    state.ready = true;
    ready.push(application);
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
      await disposeCharged(job.application, job.artifact, job.byteLength);
    } catch {
      /* Orphaned: the bytes stay charged, the reason the job was refused stands. */
    }
    releaseQueuedSlot(job.application);
    job.settled.reject(reason);
  };

  const expireQueued = (): void => {
    const now = performance.now();
    for (const [application, state] of applications) {
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
      else markReady(application, state);
    }
  };

  const scheduleQueueTimer = (): void => {
    if (queueTimer !== undefined) clearTimeout(queueTimer);
    let earliest = Number.POSITIVE_INFINITY;
    for (const state of applications.values()) {
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

    /* The slot is freed once the disposal has been attempted, whichever way it
       went: what the task did is what the caller hears, and an artifact left
       behind is the node's problem to keep retrying, not the deploy's. */
    try {
      await disposeCharged(job.application, job.artifact, job.byteLength);
    } catch {
      /* Orphaned. */
    }
    releaseActiveSlot(job);

    if (outcome.ok) job.settled.resolve(outcome.value);
    else job.settled.reject(outcome.error);
    const state = applications.get(job.application);
    if (state !== undefined) markReady(job.application, state);
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
        if (orphans.size > 0) void sweepOrphans();
        expireQueued();
        while (!closed && activeTasks < options.activeTasks && ready.length > 0) {
          const application = ready.shift() as string;
          const state = applications.get(application);
          if (state === undefined) continue;
          state.ready = false;
          if (state.activeTasks >= options.applicationActiveTasks) continue;
          const job = state.queue[0];
          if (job === undefined || job.phase !== "queued") continue;

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
          markReady(application, state);
          queueMicrotask(() => void execute(job));
        }
      } while (dispatchRequested && !closed);
    } finally {
      dispatching = false;
      scheduleQueueTimer();
    }
  }

  const scheduler: DeployScheduler = {
    reserve(application): DeployReservation {
      if (closed) throw overloaded("deploy admission is closed while this node stops");
      const state = stateOf(application);
      if (
        queuedTasks + 1 > options.queuedTasks ||
        state.queuedTasks + 1 > options.applicationQueuedTasks ||
        stagedBytes + options.artifactBytes > options.stagedBytes ||
        state.stagedBytes + options.artifactBytes > options.applicationStagedBytes
      ) {
        removeEmpty(application, state);
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
        application,
        signal: controller.signal,
        cancel(reason = new Error("deploy receive cancelled")): void {
          if (phase !== "receiving" && phase !== "aborting") {
            throw new ScafoError("invalid-input", "Deploy reservation was already consumed");
          }
          phase = "cancelled";
          clearTimeout(receiveTimer);
          controller.abort(reason);
          releaseQueuedSlot(application);
          releaseBytes(application, options.artifactBytes);
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
          return trackCleanup(
            (async (): Promise<void> => {
              try {
                await disposeCharged(application, artifact, options.artifactBytes);
                phase = "cancelled";
              } finally {
                releaseQueuedSlot(application);
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
            application,
            artifact,
            byteLength: artifact.byteLength,
            task,
            settled,
            queuedAt: performance.now(),
            phase: "queued",
          };
          state.queue.push(job);
          finishReceiving();
          markReady(application, state);
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
      const usage: Record<string, ApplicationUsage> = {};
      for (const [application, state] of applications) {
        Object.defineProperty(usage, application, {
          value: {
            activeTasks: state.activeTasks,
            queuedTasks: state.queuedTasks,
            stagedBytes: state.stagedBytes,
          },
          enumerable: true,
        });
      }
      return {
        activeTasks,
        queuedTasks,
        stagedBytes,
        applications: usage,
      };
    },

    stop(reason): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      closed = true;
      stopPromise = (async (): Promise<void> => {
        if (queueTimer !== undefined) clearTimeout(queueTimer);
        const receivingCleanup: Promise<void>[] = [];
        for (const entry of receiving) {
          entry.abort(reason);
          receivingCleanup.push(entry.settled);
        }
        const queuedCleanup: Promise<void>[] = [];
        for (const state of applications.values()) {
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
        await sweepOrphans();
      })();
      return stopPromise;
    },
  };

  return scheduler;
}

function validateOptions(options: DeploySchedulerOptions): void {
  for (const name of [
    "artifactBytes",
    "activeTasks",
    "applicationActiveTasks",
    "queuedTasks",
    "applicationQueuedTasks",
    "stagedBytes",
    "applicationStagedBytes",
    "receiveTimeoutMs",
    "queueTimeoutMs",
    "taskTimeoutMs",
  ] as const) {
    const value = options[name];
    const queueCount = name === "queuedTasks" || name === "applicationQueuedTasks";
    if (!Number.isSafeInteger(value) || value < (queueCount ? 0 : 1)) {
      throw new ScafoError("invalid-input", "Invalid deploy scheduler limit", {
        detail: `${name} must be a ${queueCount ? "non-negative" : "positive"} safe integer`,
      });
    }
  }
  for (const [application, global] of [
    ["applicationActiveTasks", "activeTasks"],
    ["applicationQueuedTasks", "queuedTasks"],
    ["applicationStagedBytes", "stagedBytes"],
  ] as const) {
    if (options[application] > options[global]) {
      throw new ScafoError("invalid-input", "Invalid deploy scheduler limits", {
        detail: `${application} must not exceed ${global}`,
      });
    }
  }
  if (
    options.stagedBytes < options.artifactBytes ||
    options.applicationStagedBytes < options.artifactBytes
  ) {
    throw new ScafoError("invalid-input", "Invalid deploy scheduler byte limits", {
      detail: "staged byte limits must each hold one complete artifact",
    });
  }
}

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
