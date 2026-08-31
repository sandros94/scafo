/*
 * The reconcile loop: read what the registry wants served, look at what runs on
 * this node, and close the gap one action at a time.
 *
 * Planning is pure and lives in `src/core/placement`; everything effectful — the
 * registry reads, the supervisor, the runtime driver — is wired in here.
 */

import { createPortAllocator } from "../core/placement/ports.ts";
import { planReconcile, type ReconcileAction } from "../core/placement/reconcile.ts";
import { countingRegistry, storeOpsOf } from "../core/registry/counting.ts";
import type { RuntimeDriver, RuntimeProcess } from "../core/types/runtime.ts";
import { type PlacementView, readDesired } from "./_desired.ts";
import { createExecutor, failureOf, type ReconcileFailure } from "./_execute.ts";
import { applyIngress } from "./_ingress.ts";
import type { DaemonContext } from "./app.ts";

export type { PlacementView } from "./_desired.ts";
export type { ReconcileFailure } from "./_execute.ts";

/** Time between two passes of the loop when none is configured. */
export const DEFAULT_RECONCILE_INTERVAL_MS: number = 5_000;

/** What a failure to converge the ingress is recorded against. */
export const INGRESS_SUBJECT: string = "ingress";

/** What the loop did last, as reported by the node API. */
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
  /**
   * Placement decisions the last pass read, including the environments this node
   * is NOT one of the nodes for. An environment missing from this list has none,
   * and is therefore served here.
   */
  placements: PlacementView[];
}

/** The loop, and the handle to run it once or on a timer. */
export interface Reconciler {
  /** Runs one pass and resolves with the actions it planned. */
  runOnce(): Promise<ReconcileAction[]>;
  /**
   * Asks for a pass now rather than at the next tick.
   *
   * Single-flight, like every other way in: a kick that arrives while a pass is
   * running is remembered and honoured exactly once when that pass finishes, and
   * two passes never overlap. It returns immediately and reports nothing —
   * whatever the pass achieves is read back from {@link Reconciler.status}.
   */
  kick(): void;
  start(): void;
  /** Closes the loop permanently, cancels its pass and waits for it to quiesce. */
  shutdown(): Promise<void>;
  stop(): void;
  status(): ReconcileStatus;
}

export interface ReconcilerOptions {
  /** Time between passes. Defaults to {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Environment every runtime process starts from.
   *
   * A spec's environment REPLACES the child's rather than extending it, so
   * without at least a `PATH` here a runtime named without a directory cannot be
   * found and no process starts at all. Defaults to the useful parts of the
   * daemon's own environment.
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
  daemon: DaemonContext,
  driver: RuntimeDriver,
  opts?: ReconcilerOptions,
): Reconciler {
  const intervalMs = opts?.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;

  const observe = daemon.observability;

  /*
   * WHAT THE PASS COSTS THE BUCKET, counted only while this node is observing.
   * The wrapper is the loop's OWN — the executor is handed it too, so a pass's
   * locks and varset reads are in the same numbers as its listings — and nothing
   * else on the node writes through it, which is what makes a delta taken across
   * one pass exactly that pass's. Off, the daemon's registry is used unwrapped
   * and nothing here allocates.
   */
  const counted = observe === undefined ? undefined : countingRegistry(daemon.registry);
  const registry = counted?.registry ?? daemon.registry;

  /* Soft state: what this node started. Lost on restart, and rebuilt from the
     supervisor's process ids the next time a pass runs. */
  const known = new Map<string, RuntimeProcess>();
  const executor = createExecutor({
    daemon,
    registry,
    driver,
    baseEnv: opts?.baseEnv ?? runtimeBaseEnv(globalThis.process?.env ?? {}),
    known,
  });

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let terminal = false;
  let activePass: Promise<ReconcileAction[]> | undefined;
  let activeAbort: AbortController | undefined;
  let shutdown: Promise<void> | undefined;
  /* A pass was asked for while one was running: see `runOnce`. */
  let kicked = false;
  let lastRunAt: string | null = null;
  let lastActions: ReconcileAction[] = [];
  let failures: ReconcileFailure[] = [];
  let lastPlacements: PlacementView[] = [];

  /**
   * One pass. `fromKick` says whether an immediate rerun requested this pass.
   */
  async function runPass(fromKick: boolean): Promise<ReconcileAction[]> {
    /* Passes must not overlap: two of them would plan against the same gap and
       start the same environment twice. Every way in — the timer, a kick, a
       caller awaiting one pass — goes through this one gate. */
    if (inFlight) return [];
    inFlight = true;
    const abort = new AbortController();
    activeAbort = abort;

    observe?.emit({ type: "reconcile.pass.start", kicked: fromKick });
    const startedMs = observe === undefined ? 0 : observe.nowMs();
    const before = counted?.counts();

    const pending: ReconcileFailure[] = [];
    let plan: ReconcileAction[] = [];
    let placements: PlacementView[] = [];
    try {
      /* Filtered to this node: an environment placed on other nodes is not
         desired here, and what still runs for it is planned for a stop. */
      const state = await readDesired(registry, {
        nodeId: daemon.nodeId,
        mode: "required",
      });
      const desired = state.environments;
      placements = state.placements;
      /* Gaps in what could be resolved, reported beside the actions rather than
         instead of them: the environments they concern are still planned for,
         minus whatever went missing. */
      for (const failure of state.failures) {
        pending.push({ at: new Date().toISOString(), ...failure });
      }

      const actual = executor.currentProcesses();
      plan = planReconcile({
        desired,
        actual,
        ports: createPortAllocator({
          taken: actual.flatMap((process) => [process.port, process.internalPort]),
          start: daemon.config.runtime.portRangeStart,
        }),
      });

      await executor.execute(plan, desired, pending, abort.signal);

      if (!abort.signal.aborted) {
        try {
          /* Routing is published from what the pass ended with, not from what it planned. */
          await applyIngress(daemon, {
            desired,
            processes: executor.currentProcesses(),
          });
        } catch (error) {
          /*
           * An ingress that cannot be reached is recorded and nothing more. The
           * processes this pass started are running either way, the next pass
           * states the same routing again, and a pass that gave up here would stop
           * reconciling the node over a failure outside it.
           */
          pending.push(failureOf(error, { subject: INGRESS_SUBJECT }));
        }
      }
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
      /* What THIS pass read, so a registry it could not read reports nothing
         rather than a decision that may since have moved. */
      lastPlacements = placements;
      lastRunAt = new Date().toISOString();
      inFlight = false;
      if (activeAbort === abort) activeAbort = undefined;

      /* The three are made together and are undefined together; a pass reports
         what it cost against the baseline it took at its own start. */
      if (observe !== undefined && counted !== undefined && before !== undefined) {
        const spent = counted.counts();
        observe.emit({
          type: "reconcile.pass.end",
          actions: plan.length,
          failures: pending.length,
          storeOps: storeOpsOf(spent) - storeOpsOf(before),
          listOps: spent.list - before.list,
          durationMs: observe.nowMs() - startedMs,
        });
      }

      /* Exactly one more pass for however many kicks arrived while this one was
         running: they all asked for the same thing, which is a pass that starts
         after the state they stamped was written. */
      if (!terminal && kicked) {
        kicked = false;
        void startPass(true);
      }
    }
    return plan;
  }

  function startPass(fromKick: boolean): Promise<ReconcileAction[]> {
    if (terminal || inFlight) return Promise.resolve([]);
    const pass = runPass(fromKick);
    activePass = pass;
    void pass.finally(() => {
      if (activePass === pass) activePass = undefined;
    });
    return pass;
  }

  const kick = (): void => {
    if (terminal) return;
    if (inFlight) {
      kicked = true;
      return;
    }
    void startPass(true);
  };

  return {
    runOnce: (): Promise<ReconcileAction[]> => startPass(false),

    kick,

    start(): void {
      if (terminal || timer !== null) return;

      timer = setInterval(() => void startPass(false), intervalMs);
      /* The loop must never be the reason the process stays alive. */
      const handle = timer as { unref?: () => void };
      handle.unref?.();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },

    shutdown(): Promise<void> {
      if (shutdown !== undefined) return shutdown;
      /* Synchronous closure matters: Sail awaits bucket and lease work before
         this call, and no timer may start runtime work in that gap or after it. */
      terminal = true;
      kicked = false;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      activeAbort?.abort(new Error("Reconciler is shutting down"));
      shutdown = (activePass ?? Promise.resolve()).then(() => {});
      return shutdown;
    },

    status(): ReconcileStatus {
      return {
        lastRunAt,
        running: inFlight,
        lastActions: [...lastActions],
        failures: [...failures],
        processes: executor.currentProcesses().map((process) => ({ ...process })),
        placements: lastPlacements.map((view) => ({ ...view, nodes: [...view.nodes] })),
      };
    },
  };
}

/**
 * The parts of an environment worth handing to a runtime process: enough to find
 * and run the executable, and nothing that belongs to the daemon alone.
 */
export function runtimeBaseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TZ", "RUST_LOG"]) {
    const value = env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}
