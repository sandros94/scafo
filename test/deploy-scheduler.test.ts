import { afterEach, describe, expect, it, vi } from "vitest";
import type { StagedArtifact } from "../src/core/types/deploy.ts";
import {
  createDeployScheduler,
  type DeployScheduler,
  type DeploySchedulerOptions,
} from "../src/daemon/_deploy-scheduler.ts";

const baseLimits: DeploySchedulerOptions = {
  artifactBytes: 100,
  activeTasks: 2,
  projectActiveTasks: 1,
  queuedTasks: 4,
  projectQueuedTasks: 2,
  stagedBytes: 300,
  projectStagedBytes: 200,
  receiveTimeoutMs: 600_000,
  queueTimeoutMs: 600_000,
  taskTimeoutMs: 300_000,
};

function limits(overrides: Partial<DeploySchedulerOptions> = {}): DeploySchedulerOptions {
  return {
    ...baseLimits,
    ...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("deploy scheduler accounting", () => {
  it("reserves global and project count and bytes atomically", () => {
    const scheduler = createDeployScheduler(limits({ queuedTasks: 2 }));
    scheduler.reserve("one");
    scheduler.reserve("two");

    expect(() => scheduler.reserve("three")).toThrow(
      expect.objectContaining({ code: "deploy-overloaded", status: 429 }),
    );
    expect(scheduler.usage()).toEqual({
      activeTasks: 0,
      queuedTasks: 2,
      stagedBytes: 200,
      projects: {
        one: { activeTasks: 0, queuedTasks: 1, stagedBytes: 100 },
        two: { activeTasks: 0, queuedTasks: 1, stagedBytes: 100 },
      },
    });
  });

  it("mutates nothing when one dimension refuses a reservation", () => {
    const scheduler = createDeployScheduler(limits({ projectQueuedTasks: 1 }));
    scheduler.reserve("one");
    const before = scheduler.usage();

    expect(() => scheduler.reserve("one")).toThrow(
      expect.objectContaining({ code: "deploy-overloaded" }),
    );
    expect(scheduler.usage()).toEqual(before);
  });

  it("shrinks the pessimistic reservation to immutable staged bytes", async () => {
    const scheduler = createDeployScheduler(limits());
    const reservation = scheduler.reserve("one");
    const artifact = staged(17);
    const task = reservation.enqueue(artifact, async () => {});

    expect(scheduler.usage()).toMatchObject({ activeTasks: 1, queuedTasks: 0, stagedBytes: 17 });
    await task.completion;
    expect(artifact.disposals).toBe(1);
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("zero queued capacity refuses all intake because receiving consumes that slot", () => {
    const scheduler = createDeployScheduler(limits({ queuedTasks: 0, projectQueuedTasks: 0 }));
    expect(() => scheduler.reserve("one")).toThrow(
      expect.objectContaining({ code: "deploy-overloaded" }),
    );
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("types reuse of a one-shot reservation without changing accounting", async () => {
    const scheduler = createDeployScheduler(limits());
    const reservation = scheduler.reserve("one");
    const task = reservation.enqueue(staged(1), async () => {});

    expect(() => reservation.enqueue(staged(1), async () => {})).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    await task.completion;
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("types repeated cancellation of a one-shot reservation", () => {
    const scheduler = createDeployScheduler(limits());
    const reservation = scheduler.reserve("one");
    reservation.cancel();

    expect(() => reservation.cancel()).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("keeps a rejected pre-enqueue artifact charged until stop retries disposal", async () => {
    const scheduler = createDeployScheduler(limits());
    const reservation = scheduler.reserve("one");
    let disposals = 0;
    const artifact: StagedArtifact = {
      byteLength: 1,
      open: () => new Blob([new Uint8Array([1])]).stream(),
      dispose: () => {
        disposals += 1;
        return disposals === 1 ? Promise.reject(new Error("disk busy")) : Promise.resolve();
      },
    };

    await expect(reservation.discard(artifact)).rejects.toThrow("disk busy");
    expect(scheduler.usage()).toMatchObject({ queuedTasks: 1, stagedBytes: 100 });

    await scheduler.stop(new Error("node stopping"));
    expect(disposals).toBe(2);
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("makes stop join an in-progress rejected artifact disposal", async () => {
    const scheduler = createDeployScheduler(limits());
    const disposal = deferred<void>();
    const artifact = staged(1, disposal.promise);
    const discarding = scheduler.reserve("one").discard(artifact);

    let stopped = false;
    const stopping = scheduler.stop(new Error("node stopping")).then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    expect(scheduler.usage()).toMatchObject({ queuedTasks: 1, stagedBytes: 100 });

    disposal.resolve();
    await Promise.all([discarding, stopping]);
    expect(scheduler.usage()).toEqual(emptyUsage());
  });
});

describe("deploy scheduler ordering", () => {
  it("is per-project FIFO and round-robin across ready projects", async () => {
    const scheduler = createDeployScheduler(limits({ activeTasks: 1 }));
    const gate = deferred<void>();
    const order: string[] = [];

    enqueue(scheduler, "a", "a1", order, gate.promise);
    enqueue(scheduler, "a", "a2", order);
    enqueue(scheduler, "b", "b1", order);
    enqueue(scheduler, "b", "b2", order);
    await settle();
    expect(order).toEqual(["a1"]);

    gate.resolve();
    await expect.poll(() => order).toEqual(["a1", "b1", "a2", "b2"]);
    await expect.poll(() => scheduler.usage()).toEqual(emptyUsage());
  });

  it("does not let a project waiting on its cap occupy a global slot", async () => {
    const scheduler = createDeployScheduler(limits());
    const gate = deferred<void>();
    const order: string[] = [];

    enqueue(scheduler, "a", "a1", order, gate.promise);
    enqueue(scheduler, "a", "a2", order);
    enqueue(scheduler, "b", "b1", order);
    await settle();

    expect(order).toEqual(["a1", "b1"]);
    gate.resolve();
    await expect.poll(() => order).toEqual(["a1", "b1", "a2"]);
  });
});

describe("deploy scheduler deadlines and cleanup", () => {
  it("starts the receive clock at reservation and releases a partial receive", async () => {
    vi.useFakeTimers();
    const scheduler = createDeployScheduler(limits({ receiveTimeoutMs: 600_000 }));
    const reservation = scheduler.reserve("one");
    reservation.signal.addEventListener(
      "abort",
      () => reservation.cancel(reservation.signal.reason),
      { once: true },
    );

    await vi.advanceTimersByTimeAsync(599_999);
    expect(reservation.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(reservation.signal.aborted).toBe(true);
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("starts the queue clock only after staging and expires before dispatch", async () => {
    vi.useFakeTimers();
    const scheduler = createDeployScheduler(
      limits({
        activeTasks: 1,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 700_000,
      }),
    );
    const gate = deferred<void>();
    const running = scheduler.reserve("one").enqueue(staged(1), async () => gate.promise);
    const waitingArtifact = staged(1);
    const waiting = scheduler.reserve("two").enqueue(waitingArtifact, async () => {
      throw new Error("expired work ran");
    });

    await vi.advanceTimersByTimeAsync(599_999);
    expect(waitingArtifact.disposals).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    await expect(waiting.completion).rejects.toThrow("queue deadline");
    expect(waitingArtifact.disposals).toBe(1);
    gate.resolve();
    await running.completion;
  });

  it("makes stop join disposal already started by queue expiry", async () => {
    vi.useFakeTimers();
    const scheduler = createDeployScheduler(
      limits({
        activeTasks: 1,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 700_000,
      }),
    );
    const active = scheduler.reserve("one").enqueue(staged(1), (signal) => aborted(signal));
    const disposal = deferred<void>();
    const waiting = scheduler.reserve("two").enqueue(staged(1, disposal.promise), async () => {});

    await vi.advanceTimersByTimeAsync(600_000);
    let stopped = false;
    const stopping = scheduler.stop(new Error("node stopping")).then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(scheduler.usage()).toMatchObject({ queuedTasks: 1, stagedBytes: 1 });

    disposal.resolve();
    await stopping;
    await expect(active.completion).rejects.toThrow("node stopping");
    await expect(waiting.completion).rejects.toThrow("queue deadline");
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("aborts active work at its deadline and awaits cleanup", async () => {
    vi.useFakeTimers();
    const scheduler = createDeployScheduler(limits({ taskTimeoutMs: 300_000 }));
    const cleaned = deferred<void>();
    let signal: AbortSignal | undefined;
    const artifact = staged(1);
    const task = scheduler.reserve("one").enqueue(artifact, async (given) => {
      signal = given;
      await aborted(given);
      await cleaned.promise;
    });

    await vi.advanceTimersByTimeAsync(300_000);
    expect(signal?.aborted).toBe(true);
    expect(artifact.disposals).toBe(0);
    expect(scheduler.usage().activeTasks).toBe(1);

    cleaned.resolve();
    await expect(task.completion).rejects.toThrow("task deadline");
    expect(artifact.disposals).toBe(1);
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("disposes before releasing accounting and fails closed on disposal failure", async () => {
    const scheduler = createDeployScheduler(limits());
    const disposal = deferred<void>();
    const artifact = staged(10, disposal.promise);
    const task = scheduler.reserve("one").enqueue(artifact, async () => {});
    await settle();

    expect(scheduler.usage()).toMatchObject({ activeTasks: 1, stagedBytes: 10 });
    disposal.resolve();
    await task.completion;
    expect(scheduler.usage()).toEqual(emptyUsage());

    const failed = staged(11, Promise.reject(new Error("disk busy")));
    const failedTask = scheduler.reserve("one").enqueue(failed, async () => {});
    await expect(failedTask.completion).rejects.toThrow("disk busy");
    expect(scheduler.usage()).toMatchObject({ activeTasks: 1, stagedBytes: 11 });
  });

  it("keeps failed-cleanup accounting until stop retries disposal", async () => {
    const scheduler = createDeployScheduler(limits());
    let disposals = 0;
    const artifact = staged(1);
    artifact.dispose = async (): Promise<void> => {
      artifact.disposals += 1;
      disposals += 1;
      if (disposals === 1) throw new Error("disk busy");
    };

    const task = scheduler.reserve("one").enqueue(artifact, async () => {});
    await expect(task.completion).rejects.toThrow("disk busy");
    expect(scheduler.usage()).toMatchObject({ activeTasks: 1, stagedBytes: 1 });

    await scheduler.stop(new Error("node stopping"));
    expect(scheduler.usage()).toEqual(emptyUsage());
  });

  it("stop closes admission, aborts receiving/active, disposes queued, and awaits cleanup", async () => {
    const scheduler = createDeployScheduler(limits({ activeTasks: 1 }));
    const activeCleanup = deferred<void>();
    const active = scheduler.reserve("one").enqueue(staged(1), async (signal) => {
      await aborted(signal);
      await activeCleanup.promise;
    });
    const queuedArtifact = staged(2);
    const queued = scheduler.reserve("two").enqueue(queuedArtifact, async () => {});
    const receiving = scheduler.reserve("three");
    receiving.signal.addEventListener("abort", () => receiving.cancel(receiving.signal.reason), {
      once: true,
    });

    const stopping = scheduler.stop(new Error("node stopping"));
    const alsoStopping = scheduler.stop(new Error("ignored second reason"));
    expect(alsoStopping).toBe(stopping);
    await settle();
    expect(receiving.signal.aborted).toBe(true);
    expect(queuedArtifact.disposals).toBe(1);
    expect(scheduler.usage().activeTasks).toBe(1);
    expect(() => scheduler.reserve("four")).toThrow(
      expect.objectContaining({ code: "deploy-overloaded" }),
    );

    activeCleanup.resolve();
    await Promise.all([stopping, alsoStopping]);
    await expect(active.completion).rejects.toThrow("node stopping");
    await expect(queued.completion).rejects.toThrow("node stopping");
    expect(scheduler.usage()).toEqual(emptyUsage());
  });
});

interface TestArtifact extends StagedArtifact {
  disposals: number;
}

function staged(byteLength: number, disposal: Promise<void> = Promise.resolve()): TestArtifact {
  return {
    byteLength,
    disposals: 0,
    open: () => new Blob([new Uint8Array(byteLength)]).stream(),
    async dispose(): Promise<void> {
      this.disposals += 1;
      await disposal;
    },
  };
}

function enqueue(
  scheduler: DeployScheduler,
  project: string,
  name: string,
  order: string[],
  wait: Promise<void> = Promise.resolve(),
): void {
  scheduler.reserve(project).enqueue(staged(1), async () => {
    order.push(name);
    await wait;
  });
}

function emptyUsage(): ReturnType<DeployScheduler["usage"]> {
  return {
    activeTasks: 0,
    queuedTasks: 0,
    stagedBytes: 0,
    projects: {},
  };
}

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
