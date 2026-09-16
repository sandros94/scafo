/* Reconciles this node's registry placement with its supervised processes. */

import { renderFleetRouting } from "../core/placement/fleet-routes.ts";
import { createPortAllocator } from "../core/placement/ports.ts";
import { planReconcile, type ReconcileAction } from "../core/placement/reconcile.ts";
import { sameServing, servingOf } from "../core/placement/serving.ts";
import { nowDate } from "../core/registry/context.ts";
import { countingRegistry, storeOpsOf } from "../core/registry/counting.ts";
import { listNodeRecords } from "../core/registry/nodes.ts";
import type { FleetRouting } from "../core/types/ingress.ts";
import type { NodeServing } from "../core/types/registry.ts";
import type { RuntimeDriver, RuntimeProcess } from "../core/types/runtime.ts";
import { type PlacementView, readDesired } from "./_desired.ts";
import { createExecutor, failureOf, type ReconcileFailure } from "./_execute.ts";
import { recordRouting } from "./_ingress.ts";
import type { DaemonContext } from "./app.ts";

export type { PlacementView } from "./_desired.ts";
export type { ReconcileFailure } from "./_execute.ts";

/** Time between two passes of the loop when none is configured. */
export const DEFAULT_RECONCILE_INTERVAL_MS: number = 5_000;

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
  /** Placement views read by the last pass. Missing placement means unassigned. */
  placements: PlacementView[];
}

/** The loop, and the handle to run it once or on a timer. */
export interface Reconciler {
  /** Runs one pass and resolves with the actions it planned. */
  runOnce(): Promise<ReconcileAction[]>;
  /** Queues one immediate follow-up pass while preserving single-flight execution. */
  kick(): void;
  start(): void;
  /** Closes the loop permanently, cancels its pass and waits for it to quiesce. */
  shutdown(): Promise<void>;
  stop(): void;
  status(): ReconcileStatus;
  /**
   * The fleet's routing as of the last pass that rendered one: every host the
   * fleet answers on and every node answering, in node order. What the ingress
   * routes of the node API serve.
   *
   * Undefined until a pass has rendered one, and never an empty document
   * standing in for that: an empty routing is a fleet with nothing deployed,
   * which is knowledge, and a node that has only just booted has none. A poller
   * cannot tell the two apart, so it would drop every route it holds for the
   * seconds before this node's first pass finishes. The absence is the honest
   * answer, and the ingress routes refuse rather than serve it.
   */
  fleetRouting(): FleetRouting | undefined;
}

export interface ReconcilerOptions {
  /** Time between passes. Defaults to {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
  intervalMs?: number;
  /** Base child environment. Include PATH when the runtime executable is not absolute. */
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

  /* Count every registry operation from this pass when observation is enabled. */
  const counted = observe === undefined ? undefined : countingRegistry(daemon.registry);
  const registry = counted?.registry ?? daemon.registry;

  /* Process state is rebuilt from supervisor ids after daemon restart. */
  const known = new Map<string, RuntimeProcess>();
  const executor = createExecutor({
    daemon,
    driver,
    baseEnv: opts?.baseEnv ?? runtimeBaseEnv(globalThis.process?.env ?? {}),
    known,
    registry,
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
  /* Set by the first pass that renders one, and kept across a pass that fails to
     read the registry: see {@link Reconciler.fleetRouting}. */
  let fleetRouting: FleetRouting | undefined;
  /* What the heartbeat was last asked to tell the fleet this node serves. */
  let announced: NodeServing | undefined;

  /**
   * Tells the fleet, through the heartbeat, when what this node serves has
   * changed. The heartbeat carries it on its own timer too, but a process that
   * just started is reachable now, and thirty seconds is a long time for a route
   * to wait; a process that just stopped is worse, because until the fleet
   * hears, it keeps routing to a port nothing answers on.
   */
  function announce(): void {
    const serving = servingOf(executor.currentProcesses());
    if (sameServing(serving, announced)) return;
    announced = serving;
    void daemon.heartbeat?.beat();
  }

  /**
   * One pass. `fromKick` says whether an immediate rerun requested this pass.
   */
  async function runPass(fromKick: boolean): Promise<ReconcileAction[]> {
    /* Timer, kicks, and callers share one gate to prevent duplicate starts. */
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
      /* Other nodes' placements are not desired locally and are stopped if present. */
      const [state, nodes] = await Promise.all([
        readDesired(registry, { nodeId: daemon.nodeId }),
        listNodeRecords(registry),
      ]);
      const desired = state.environments;
      placements = state.placements;
      /* Rendered from what the pass read, before anything here changes: this
         node's own processes reach the fleet through its heartbeat, like every
         other node's, so every node's copy of the routing says the same. */
      fleetRouting = renderFleetRouting({
        platformDomains: daemon.config.platformDomains,
        environments: state.fleet,
        nodes,
        now: nowDate(registry),
        api: daemon.config.api.public,
      });
      /* Preserve read failures beside actions for the resolvable environments. */
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
        /* Attribute traffic from the actual post-execution process state. Nothing
           leaves the node here — what an ingress reads is `fleetRouting` above,
           which it polls for itself — so there is no call to fail and nothing to
           record a failure against. */
        recordRouting(daemon, { desired, processes: executor.currentProcesses() });
      }
    } catch (error) {
      /* A registry read failure must not be interpreted as every environment removed. */
      pending.push(failureOf(error, {}));
    } finally {
      lastActions = plan;
      failures = pending;
      /* Report only placements this pass successfully read. */
      lastPlacements = placements;
      lastRunAt = new Date().toISOString();
      inFlight = false;
      if (activeAbort === abort) activeAbort = undefined;
      /* After `lastRunAt`: the heartbeat reads what a finished pass left. */
      if (!terminal) announce();

      /* Emit operation deltas against this pass's starting baseline. */
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

      /* Coalesce concurrent kicks into one pass after this one. */
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
      /* Close synchronously so no timer starts work during shutdown. */
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

    fleetRouting: (): FleetRouting | undefined => fleetRouting,

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
