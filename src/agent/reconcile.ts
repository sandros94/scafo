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
import { type ParkedEnvironment, type PlacementView, readDesired } from "./_desired.ts";
import { createExecutor, failureOf, type ReconcileFailure } from "./_execute.ts";
import { applyIngress } from "./_ingress.ts";
import type { AgentContext } from "./app.ts";

export type { ParkedEnvironment, PlacementView } from "./_desired.ts";
export type { ReconcileFailure } from "./_execute.ts";

/** One parked environment as a status reports it: the name is all that is read there. */
export interface ParkedView {
  project: string;
  env: string;
}

/** Time between two passes of the loop when none is configured. */
export const DEFAULT_RECONCILE_INTERVAL_MS: number = 5_000;

/** What a failure to converge the ingress is recorded against. */
export const INGRESS_SUBJECT: string = "ingress";

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
  /**
   * Placement decisions the last pass read, including the environments this node
   * is NOT one of the nodes for. An environment missing from this list has none,
   * and is therefore served here.
   */
  placements: PlacementView[];
  /**
   * Environments the last pass read as parked: nothing of their own runs here,
   * and a request for one of their hosts wakes it. Named rather than reported
   * whole, because a name is all a status needs — {@link Reconciler.parkedRecords}
   * is what the wake surface resolves hosts against.
   */
  parked: ParkedView[];
}

/** The loop, and the handle to run it once or on a timer. */
export interface Reconciler {
  /** Runs one pass and resolves with the actions it planned. */
  runOnce(): Promise<ReconcileAction[]>;
  /**
   * Asks for a pass NOW rather than at the next tick — what a wake does after it
   * has stamped, so the environment it just asked for is started in
   * milliseconds instead of at the end of the interval.
   *
   * Single-flight, like every other way in: a kick that arrives while a pass is
   * running is remembered and honoured exactly once when that pass finishes, and
   * two passes never overlap. It returns immediately and reports nothing —
   * whatever the pass achieves is read back from {@link Reconciler.status}.
   */
  kick(): void;
  start(): void;
  stop(): void;
  status(): ReconcileStatus;
  /**
   * The parked environments of the last pass, with the records the wake surface
   * needs: an environment's own hosts, the custom domains its record mirrors,
   * and the park policy it is woken under.
   *
   * Empty before the first pass, and empty after one that could not read the
   * registry — this is what THIS node last read, never a cache of what it once
   * knew.
   */
  parkedRecords(): ParkedEnvironment[];
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
  /* A pass was asked for while one was running: see `runOnce`. */
  let kicked = false;
  let lastRunAt: string | null = null;
  let lastActions: ReconcileAction[] = [];
  let failures: ReconcileFailure[] = [];
  let lastPlacements: PlacementView[] = [];
  let lastParked: ParkedEnvironment[] = [];

  async function runOnce(): Promise<ReconcileAction[]> {
    /* Passes must not overlap: two of them would plan against the same gap and
       start the same environment twice. Every way in — the timer, a kick, a
       caller awaiting one pass — goes through this one gate. */
    if (inFlight) return [];
    inFlight = true;

    const pending: ReconcileFailure[] = [];
    let plan: ReconcileAction[] = [];
    let placements: PlacementView[] = [];
    let parked: ParkedEnvironment[] = [];
    try {
      /* Filtered to this node: an environment placed on other nodes is not
         desired here, and what still runs for it is planned for a stop. */
      const state = await readDesired(agent.registry, { nodeId: agent.nodeId });
      const desired = state.environments;
      placements = state.placements;
      parked = state.parked;
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
          start: agent.config.runtime.portRangeStart,
        }),
      });
      await executor.execute(plan, desired, pending);

      try {
        /* Routing is published from what the pass ended with, not from what it
           planned: only a process that came out of it ready may take traffic.
           The parked environments travel with it, because their hosts are routed
           to this agent to be woken rather than to a process. */
        await applyIngress(agent, { desired, processes: [...known.values()], parked });
      } catch (error) {
        /*
         * An ingress that cannot be reached is recorded and nothing more. The
         * processes this pass started are running either way, the next pass
         * states the same routing again, and a pass that gave up here would stop
         * reconciling the node over a failure outside it.
         */
        pending.push(failureOf(error, { subject: INGRESS_SUBJECT }));
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
      lastParked = parked;
      lastRunAt = new Date().toISOString();
      inFlight = false;
      /* Exactly one more pass for however many kicks arrived while this one was
         running: they all asked for the same thing, which is a pass that starts
         after the state they stamped was written. */
      if (kicked) {
        kicked = false;
        void runOnce();
      }
    }
    return plan;
  }

  return {
    runOnce,

    kick(): void {
      if (inFlight) {
        kicked = true;
        return;
      }
      void runOnce();
    },

    parkedRecords(): ParkedEnvironment[] {
      return lastParked.map((entry) => ({ ...entry }));
    },

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
        placements: lastPlacements.map((view) => ({ ...view, nodes: [...view.nodes] })),
        parked: lastParked.map((entry) => ({ project: entry.project, env: entry.env.name })),
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
