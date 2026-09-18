/* Reconciles this node's registry placement with its supervised processes. */

import { describeError } from "../core/error.ts";
import { renderFleetRouting } from "../core/placement/fleet-routes.ts";
import { planReconcile, type ReconcileAction } from "../core/placement/reconcile.ts";
import { sameFailing, sameServing, servingOf } from "../core/placement/serving.ts";
import { deploymentRevision } from "../core/registry/_revision.ts";
import { nowDate } from "../core/registry/context.ts";
import { countingRegistry, storeOpsOf } from "../core/registry/counting.ts";
import type { FleetRouting } from "../core/types/ingress.ts";
import type { ApplicationRecord, NodeFailing, NodeServing } from "../core/types/registry.ts";
import type { RuntimeDriver, RuntimeProcess } from "../core/types/runtime.ts";
import { desiredFrom, type PlacementView } from "./_desired.ts";
import { createExecutor, failureOf, type ReconcileFailure } from "./_execute.ts";
import { runtimeDialHost } from "./config.ts";
import { registryView } from "./_view.ts";
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
  /**
   * Asks this node's process for `application`, if it runs one, to adopt the
   * fleet's current deployment now rather than at its own next poll.
   *
   * NEVER THROWS and never makes anything wait on it: the runtime's own pointer
   * poll is the fallback, so a failure is one line in the log. `revision` is what
   * the caller has just recorded, and telling this loop about it is what keeps
   * the next pass from asking for the same reload again.
   */
  reload(application: string, opts?: { revision?: number }): Promise<void>;
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
  /* The view every loop on this node shares; its reads are already counted by
     whoever built it, so it is taken from the daemon rather than rebuilt here. */
  const view = registryView(daemon);

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
  /* What the log has been told is failing, by action and subject, with the
     detail it was told: a failure is printed when it appears or changes, and
     once more when it clears, never on every pass in between. */
  const reported = new Map<string, string>();
  let lastPlacements: PlacementView[] = [];
  /* Set by the first pass that renders one, and kept across a pass that fails to
     read the registry: see {@link Reconciler.fleetRouting}. */
  let fleetRouting: FleetRouting | undefined;
  /* What the heartbeat was last asked to tell the fleet this node serves, and
     what it was last asked to say it cannot keep running. */
  let announced: NodeServing | undefined;
  let announcedFailing: NodeFailing | undefined;
  /* The deployment revision each application was on when this node last looked.
     A revision that MOVED while a process was already running is a deploy some
     other node accepted, and the process here is still serving what it adopted
     last — so it is asked to adopt now rather than at its own next poll. */
  const adopted = new Map<string, number>();

  /**
   * Asks the local process of `application` to adopt now. Answers whether
   * anything was asked, and never throws: see {@link Reconciler.reload}.
   */
  async function reload(application: string, opts?: { revision?: number }): Promise<void> {
    if (opts?.revision !== undefined) adopted.set(application, opts.revision);

    const process = executor
      .currentProcesses()
      .find((entry) => entry.application === application && entry.teardownPending !== true);
    if (process === undefined) return;

    try {
      await driver.reload({
        application,
        host: runtimeDialHost(daemon.config.runtime),
        port: process.internalPort,
      });
    } catch (error) {
      /* The runtime's own pointer poll adopts it within its interval either way,
         so this is worth one line and nothing else. */
      console.error(
        `scafo: "${application}" could not be asked to adopt its new deployment ` +
          `(${describeError(error)}); its runtime will pick it up on its own poll`,
      );
    }
  }

  /**
   * Asks every process whose application's deployment revision moved since the
   * last pass to adopt it now.
   *
   * ONLY FOR A PROCESS THAT WAS ALREADY RUNNING. One this pass has just started
   * reads the pointer as it boots, so there is nothing to tell it, and a first
   * pass after a restart would otherwise ask every process on the node at once.
   */
  function adopt(desired: ApplicationRecord[], before: ReadonlySet<string>): void {
    const running = new Set(executor.currentProcesses().map((entry) => entry.application));
    const served = new Set<string>();

    for (const record of desired) {
      const revision = deploymentRevision(record);
      if (revision === null) continue;
      served.add(record.name);

      const last = adopted.get(record.name);
      adopted.set(record.name, revision);
      if (last === undefined || last === revision) continue;
      if (!before.has(record.name) || !running.has(record.name)) continue;
      void reload(record.name);
    }
    /* An application this node no longer serves is one it has nothing to
       remember about: were it placed here again, its process would start fresh. */
    for (const name of adopted.keys()) {
      if (!served.has(name)) adopted.delete(name);
    }
  }

  /**
   * Asks every process that has not answered for itself yet whether it is
   * serving now, and tells the health tracker about the ones that are.
   *
   * ONCE PER PASS, AND NEVER OF A PROCESS THAT HAS ANSWERED. A ready run is
   * trusted until it exits, so the whole cost of this is one loopback request per
   * STARTING process per pass — nothing for a steady node, nothing for the bucket,
   * and no timer of its own. Becoming ready is what puts the application into
   * this node's `serving`, so the announcement below is where the fleet hears.
   *
   * NEVER FAILS A PASS. Not being ready is the ordinary answer, and the driver
   * already bounds how long each question may take.
   */
  async function probeReadiness(): Promise<void> {
    const health = daemon.processHealth;
    if (health === undefined) return;

    const ready = health.readyApplications();
    const host = runtimeDialHost(daemon.config.runtime);
    const waiting = executor
      .currentProcesses()
      /* A process on its way out is not asked, and neither is one this daemon
         adopted without knowing its ports: there is no listener to ask. */
      .filter(
        (process) =>
          process.teardownPending !== true && process.port > 0 && !ready.has(process.application),
      );

    await Promise.all(
      waiting.map(async (process) => {
        const answered = await driver
          .ready({ application: process.application, host, port: process.port })
          .catch(() => false);
        if (answered) health.ready(process.application);
      }),
    );
  }

  /**
   * Tells the fleet, through the heartbeat, when what this node serves has
   * changed. The heartbeat carries it on its own timer too, but a process that
   * just started is reachable now, and thirty seconds is a long time for a route
   * to wait; a process that just stopped is worse, because until the fleet
   * hears, it keeps routing to a port nothing answers on.
   *
   * It HINTS as well as beating, because a node record is not hinted by the
   * store: a heartbeat rewrites one every thirty seconds, and a token minted for
   * each of those would cost every node a listing several times a minute. This
   * beat is the rare one that carries something the fleet's routing depends on,
   * so it says so, and the peers pick it up within a reconcile interval instead
   * of on their node-refresh timer.
   */
  function announce(): void {
    const health = daemon.processHealth;
    const serving = servingOf(executor.currentProcesses(), {
      ready: health?.readyApplications() ?? new Set<string>(),
      ...(health === undefined ? {} : { failing: health.crashLooping() }),
    });
    const failing = health?.failing();
    /* A PROCESS THAT STARTED FAILING IS A ROUTING CHANGE, so it is announced
       exactly as one: it has just left this node's `serving`, and the ingresses
       that pull the fleet's routing have to hear before their own health checks
       work it out. */
    if (sameServing(serving, announced) && sameFailing(failing, announcedFailing)) return;
    announced = serving;
    announcedFailing = failing;
    /* The token is minted only once the beat has LANDED. Minted beside it, the
       token usually wins the race — it is one blind write against a
       read-modify-write — and every node that looks because of it, this one
       included, reads the record as it was and takes the change as seen. Nothing
       mints another, and the route waits for the node-refresh timer instead. A
       beat that failed is hinted all the same: the timer beat that follows it
       carries the same news, and a spare look costs a listing. */
    const beaten = daemon.heartbeat?.beat() ?? Promise.resolve();
    void beaten.then(
      () => view.hint(),
      () => view.hint(),
    );
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
      /* One hint GET when nothing moved; a listing of what could have moved, and
         a read of exactly the records that did, when something has. Other nodes'
         placements are not desired locally and are stopped if present. */
      const snapshot = await view.sync();
      const state = desiredFrom(snapshot, { nodeId: daemon.nodeId });
      const nodes = [...snapshot.nodes];
      const desired = state.applications;
      placements = state.placements;
      /* Rendered from what the pass read, before anything here changes: this
         node's own processes reach the fleet through its heartbeat, like every
         other node's, so every node's copy of the routing says the same. */
      fleetRouting = renderFleetRouting({
        platformDomains: daemon.config.platformDomains,
        applications: state.fleet,
        nodes,
        now: nowDate(registry),
        api: daemon.config.api.public,
      });
      /* WHOSE HOST IS WHOSE COMES FROM THE REGISTRY, not from what this node
         runs: a host is read as whoever the routing above would answer it with,
         which for an application placed on another node is still an answer. The
         whole snapshot rather than the fleet's servable set, because a claim
         outlives the deployment that was serving it. */
      daemon.ingressCounters?.observeApplications(snapshot.applications);
      const actual = executor.currentProcesses();
      /* Taken before anything is started, so a process this pass creates is told
         apart from one that was already serving something older. */
      const before = new Set(actual.map((entry) => entry.application));
      plan = planReconcile({ desired, actual });

      await executor.execute(plan, desired, pending, abort.signal);

      if (!abort.signal.aborted) {
        /* After execution, so a process this pass started is not asked to adopt
           what it has just booted onto. */
        adopt(desired, before);
        /* Inside the same try as the read that names the applications, so a
           pass that could not read the registry never gets this far: what it
           holds locally for an application it failed to read about is not
           state left over from a deletion. */
        await executor.discardLocalState(
          new Set(snapshot.applications.map((record) => record.name)),
          pending,
        );
      }
    } catch (error) {
      /* A registry read failure must not be interpreted as every application removed. */
      pending.push(failureOf(error, {}));
    } finally {
      /* BEFORE THE ANNOUNCEMENT, AND WHATEVER THE PASS DID. Readiness is a local
         question about processes that are running either way, so even a pass whose
         registry read failed asks it — and asking here, while the pass still holds
         the single-flight gate, is what lets `announce` publish a process the same
         moment it starts answering. */
      if (!abort.signal.aborted) await probeReadiness();
      lastActions = plan;
      failures = pending;
      logFailureChanges(reported, pending);
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

    reload,

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
 * The parts of the process environment worth handing to a runtime process: enough to find
 * and run the executable, and nothing that belongs to the daemon alone.
 *
 * `DOCKER_HOST` TRAVELS WITH THEM, unconditionally and unread. Celld finds the
 * engine's socket by itself — the default paths, or the one this names — and
 * scafo asks it nothing about containers; an operator who named a socket for
 * the daemon named it for the processes the daemon starts and for the publish
 * that builds their images, and dropping it here would leave those looking
 * somewhere else.
 */
export function runtimeBaseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TZ", "RUST_LOG", "DOCKER_HOST"]) {
    const value = env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

/**
 * Prints each failure of a pass the first time it is seen, or when its detail
 * changes, and prints once that it cleared: a start held pass after pass for
 * the same reason is one line in the log, not one every few seconds.
 */
function logFailureChanges(reported: Map<string, string>, pending: ReconcileFailure[]): void {
  const seen = new Set<string>();
  for (const failure of pending) {
    const key = `${failure.action ?? "pass"} ${failure.subject ?? ""}`.trim();
    seen.add(key);
    if (reported.get(key) === failure.detail) continue;
    reported.set(key, failure.detail);
    const code = failure.code === undefined ? "" : ` [${failure.code}]`;
    console.error(`scafo: reconcile ${key} failed${code}: ${failure.detail}`);
  }
  /* Deleting the entry being visited is defined for a Map, so the keys are
     walked in place. */
  for (const key of reported.keys()) {
    if (seen.has(key)) continue;
    reported.delete(key);
    console.error(`scafo: reconcile ${key} no longer fails`);
  }
}
