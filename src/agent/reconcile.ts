/*
 * The reconcile loop: read what the registry wants served, look at what runs on
 * this node, and close the gap one action at a time.
 *
 * Planning is pure and lives in `src/core/placement`; everything effectful — the
 * registry reads, the supervisor, the runtime driver — is wired in here.
 */

import { createPortAllocator } from "../core/placement/ports.ts";
import { planReconcile, type ReconcileAction } from "../core/placement/reconcile.ts";
import type { ProbeOptions, RuntimeDriver, RuntimeProcess } from "../core/types/runtime.ts";
import { readDesired } from "./_desired.ts";
import { createExecutor, failureOf, type ReconcileFailure } from "./_execute.ts";
import type { AgentContext } from "./app.ts";

export type { ReconcileFailure } from "./_execute.ts";

/** Time between two passes of the loop when none is configured. */
export const DEFAULT_RECONCILE_INTERVAL_MS: number = 5_000;

/** What the loop did last, as reported by the agent API. */
export interface ReconcileStatus {
  /** ISO time the last pass finished; null before the first one. */
  lastRunAt: string | null;
  /** True while a pass is in flight. */
  running: boolean;
  /** Actions the last finished pass planned, in execution order. */
  lastActions: ReconcileAction[];
  /** Failures of the last finished pass; empty when it went through cleanly. */
  failures: ReconcileFailure[];
  /** Runtime processes this node believes it is running. */
  processes: RuntimeProcess[];
}

/** The loop, and the handle to run it once or on a timer. */
export interface Reconciler {
  /** Runs one pass and resolves with the actions it planned. */
  runOnce(): Promise<ReconcileAction[]>;
  start(): void;
  stop(): void;
  status(): ReconcileStatus;
}

export interface ReconcilerOptions {
  /** Time between passes. Defaults to {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Readiness gate settings; the configured probe path is used unless overridden. */
  probe?: ProbeOptions;
  /**
   * Environment every runtime process starts from.
   *
   * A spec's environment REPLACES the child's rather than extending it, so
   * without at least a `PATH` here a runtime named without a directory cannot be
   * found and no process starts at all. Defaults to the useful parts of the
   * agent's own environment.
   */
  baseEnv?: Record<string, string>;
}

/**
 * Builds the reconcile loop for this node.
 *
 * Nothing runs until {@link Reconciler.start} is called, or
 * {@link Reconciler.runOnce} is awaited.
 */
export function createReconciler(
  agent: AgentContext,
  driver: RuntimeDriver,
  opts?: ReconcilerOptions,
): Reconciler {
  const intervalMs = opts?.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;

  /* Soft state: what this node started. Lost on restart, and rebuilt from the
     supervisor's process ids the next time a pass runs. */
  const known = new Map<string, RuntimeProcess>();
  const executor = createExecutor({
    agent,
    driver,
    probe: { path: agent.config.runtime.probePath, ...opts?.probe },
    baseEnv: opts?.baseEnv ?? runtimeBaseEnv(globalThis.process?.env ?? {}),
    known,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lastRunAt: string | null = null;
  let lastActions: ReconcileAction[] = [];
  let failures: ReconcileFailure[] = [];

  async function runOnce(): Promise<ReconcileAction[]> {
    /* Passes must not overlap: two of them would plan against the same gap and
       start the same environment twice. */
    if (inFlight) return [];
    inFlight = true;

    const pending: ReconcileFailure[] = [];
    let plan: ReconcileAction[] = [];
    try {
      const desired = await readDesired(agent.registry);
      const actual = executor.currentProcesses();
      plan = planReconcile({
        desired,
        actual,
        ports: createPortAllocator({
          taken: actual.flatMap((process) => [process.port, process.internalPort]),
          start: agent.config.runtime.portRangeStart,
        }),
      });
      await executor.execute(plan, desired, pending);
    } catch (error) {
      /*
       * Only reading the registry and planning throw out this far; a failed
       * action is recorded and the rest of the plan still runs. A registry that
       * cannot be read looks exactly like "every environment was undeployed", so
       * a pass that fails here plans nothing rather than stopping live processes.
       */
      pending.push(failureOf(error, {}));
    } finally {
      lastActions = plan;
      failures = pending;
      lastRunAt = new Date().toISOString();
      inFlight = false;
    }
    return plan;
  }

  return {
    runOnce,

    start(): void {
      if (timer !== null) return;

      timer = setInterval(() => void runOnce(), intervalMs);
      /* The loop must never be the reason the process stays alive. */
      const handle = timer as { unref?: () => void };
      handle.unref?.();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },

    status(): ReconcileStatus {
      return {
        lastRunAt,
        running: inFlight,
        lastActions: [...lastActions],
        failures: [...failures],
        processes: [...known.values()].map((process) => ({ ...process })),
      };
    },
  };
}

/**
 * The parts of an environment worth handing to a runtime process: enough to find
 * and run the executable, and nothing that belongs to the agent alone.
 */
export function runtimeBaseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TZ", "RUST_LOG"]) {
    const value = env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}
