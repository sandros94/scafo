/* Internal: carrying out one reconcile plan against this node. */

import { describeError, ScafoError } from "../core/error.ts";
import { formatProcessId, parseProcessId } from "../core/placement/ids.ts";
import type { DesiredEnvironment, ReconcileAction } from "../core/placement/reconcile.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { lockHolder, withLock } from "../core/registry/locks.ts";
import { fleetPrefix } from "../core/registry/paths.ts";
import {
  POINTER_LOCK_SPACE,
  POINTER_READ_HOLD_MS,
  pointerLockName,
  ROLLOUT_LOCK_TIMEOUT_MS,
} from "../core/registry/pointer-lock.ts";
import type {
  ProbeOptions,
  RuntimeDriver,
  RuntimeProcess,
  RuntimeSpecInput,
} from "../core/types/runtime.ts";
import { openEnvironmentVars } from "./_desired.ts";
import type { DaemonContext } from "./app.ts";
import { advertisedAddress } from "./config.ts";
import { DEFAULT_RUNTIME_CREDIT_MB } from "./_credit-controller.ts";

/** Stands in for the listeners of a process this daemon did not start itself. */
const UNKNOWN_PORT = 0;

/** Something one pass could not do. */
export interface ReconcileFailure {
  /** When it was recorded. */
  at: string;
  /** The kind of action that failed, when one was being executed. */
  action?: ReconcileAction["type"];
  /** What it concerned: a process id, or a `project/environment` pair. */
  subject?: string;
  code?: ScafoError["code"];
  detail: string;
}

/** How long a rollout holds the fleet's deployment pointer, and waits for it. */
export interface PointerLockOptions {
  /**
   * Time the lock is kept past the spawn, for the process to read the pointer.
   * Defaults to {@link POINTER_READ_HOLD_MS}.
   */
  holdMs?: number;
  /**
   * Longest a rollout waits to take the lock before recording the failure and
   * leaving the environment to the next pass. Defaults to
   * {@link ROLLOUT_LOCK_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/** Everything the executor acts through. */
export interface ExecutorDeps {
  daemon: DaemonContext;
  /**
   * The registry this pass reads and writes through — the loop's own, which may
   * be counted, and never the daemon's own `registry` directly. Everything a
   * pass costs the bucket has to go through one place for the pass to be able to
   * report it.
   */
  registry: RegistryContext;
  driver: RuntimeDriver;
  /** Readiness gate settings applied to every process this executor gates. */
  probe: ProbeOptions;
  /** Environment every process starts from; must carry a usable `PATH`. */
  baseEnv: Record<string, string>;
  /** How this node holds one environment's deployment pointer while it rolls out. */
  pointerLock?: PointerLockOptions;
  /**
   * Soft state shared with the loop: what this node started, and what it knows
   * about each process beyond the supervisor's own view of it.
   */
  known: Map<string, RuntimeProcess>;
}

export interface Executor {
  /** Runs a plan in order, recording what fails and carrying on with the rest. */
  execute(
    plan: ReconcileAction[],
    desired: DesiredEnvironment[],
    pending: ReconcileFailure[],
  ): Promise<void>;
  /** This node's running runtime processes, as the planner needs to see them. */
  currentProcesses(): RuntimeProcess[];
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { daemon, registry, driver, probe, baseEnv, known } = deps;
  const holdMs = deps.pointerLock?.holdMs ?? POINTER_READ_HOLD_MS;
  const lockTimeoutMs = deps.pointerLock?.timeoutMs ?? ROLLOUT_LOCK_TIMEOUT_MS;
  const holder = lockHolder(daemon.nodeId);
  const observe = daemon.observability;
  if (daemon.credits === undefined) {
    throw new ScafoError("invalid-input", "Missing node credit controller");
  }
  const credits = daemon.credits;
  /* A runtime whose teardown failed stays exactly known but can never be
     routed or gated. A later pass retries the stop through this set. */
  const quarantined = new Set<string>();
  const transitions: {
    hold: import("./_credit-controller.ts").CreditHold;
    processId: string;
    mb: number;
  }[] = [];

  /**
   * Brings one build into service, as one uninterrupted sequence.
   *
   * THE FLEET POINTER IS ONE POINTER PER ENVIRONMENT, AND A PROCESS READS IT
   * ONCE — while it starts. So the activation that names a build and the start
   * that loads it MUST NOT BE SEPARATED, and above all must not be batched with
   * another build's: activate A, activate B, start A, start B would start BOTH
   * processes against the pointer B left behind, and an environment split
   * between two builds would run one build twice. Nothing downstream would
   * notice — the registry, the routing and the process ids would all still say
   * there are two legs.
   *
   * This function is that pairing, and the planner emits one action per build so
   * it cannot be taken apart from the outside. It runs to the end or stops at
   * the first step that fails: a failed activation raises before anything is
   * started, because a process started under the old pointer would serve the
   * wrong build.
   *
   * PAIRING IS NOT ENOUGH ON ITS OWN, because this node is not the only writer:
   * a deploy accepted anywhere in the fleet moves the same pointer whenever its
   * bundle finishes, and another node rolling the same environment out moves it
   * too. So the sequence runs under the environment's pointer lock, held past
   * the spawn for as long as the process needs to read what was just written
   * ({@link POINTER_READ_HOLD_MS}). The gate is deliberately OUTSIDE it —
   * readiness takes tens of seconds, and every other writer of this environment
   * in the fleet would be waiting on them.
   *
   * THE HOLD GUARDS THE POINTER, NOT THE GATE, and the rollout goes on WITHOUT
   * the lock from the spawn onwards. What the lock promises is about pointer
   * WRITERS — none of them may move the pointer before the process it was moved
   * for has made its one read — and neither registering that process nor probing
   * it writes one. Made to wait for the hold, they cost a wake the whole of it:
   * the surface holding the request cannot SEE a process that is in neither
   * {@link ExecutorDeps.known} nor the status, and the gate that would make it
   * servable has not started either, which measured 66% of a median live wake.
   * So the rollout registers and gates alongside the rest of the hold. It still
   * AWAITS that hold before it is done — the pass owes the process its read
   * window either way. Losing the lock cancels that hold, stops and awaits the
   * process, and only then reports the original lock loss.
   */
  async function runRollout(
    action: Extract<ReconcileAction, { type: "rollout" }>,
    wanted: Map<string, DesiredEnvironment>,
    pending: ReconcileFailure[],
  ): Promise<void> {
    const key = placement(action.project, action.env);
    const entry = wanted.get(key);
    if (entry === undefined) return;

    const leg = entry.builds.find((candidate) => candidate.build.id === action.build);
    if (leg === undefined) return;

    const processId = formatProcessId({
      project: action.project,
      env: action.env,
      build: action.build,
    });
    const creditMb = daemon.config.runtime.creditMb ?? DEFAULT_RUNTIME_CREDIT_MB;
    const transition = credits.tryReserveTransition({
      owner: { namespace: "process", id: processId },
      mb: creditMb,
    });
    if (transition === undefined) {
      throw new ScafoError("capacity-unavailable", "Runtime credit is unavailable", {
        detail: `this node cannot admit ${String(creditMb)}MiB for "${processId}" yet`,
      });
    }
    transitions.push({ hold: transition, processId, mb: creditMb });
    const version = leg.build.celldVersionId;
    if (version === undefined) {
      throw new ScafoError("invalid-input", "Build has no runtime version", {
        detail:
          `build "${action.build}" of "${key}" carries no runtime version id, ` +
          `so the fleet cannot be pointed at it`,
      });
    }
    const input: RuntimeSpecInput = {
      project: entry.project,
      env: entry.env,
      build: leg.build,
      /* Throws when this environment has variables this node cannot open, which
         takes the start with it: the failure is recorded against this one
         environment, every other environment of the pass carries on, and this
         one keeps whatever process it already had. Starting it without its
         configuration would be a silent misconfiguration — the process would
         come up and serve requests against whatever its code defaults to. */
      vars: await openEnvironmentVars(registry, entry, daemon.varsetKey),
      ports: action.ports,
      node: {
        endpoint: daemon.config.bucket.endpoint,
        region: daemon.config.bucket.region,
        bucket: daemon.config.bucket.bucket,
        keyPrefix: daemon.config.bucket.prefix,
        accessKey: daemon.config.bucket.accessKey,
        secretKey: daemon.config.bucket.secretKey,
        advertiseHost: advertisedAddress(daemon.config.node).host,
        bindHost: daemon.config.runtime.bindHost,
      },
      capacity: daemon.capacity,
      maxRssMb: creditMb,
      baseEnv,
    };

    /* Built before the lock is taken, and deliberately: opening a varset is a
       bucket read that may refuse the whole rollout, and the section below is
       only the three steps that must not be interleaved with another writer. */
    const spec = driver.processSpec(input);
    if (spec.id !== processId) {
      throw new ScafoError("invalid-input", "Runtime process id does not match credit owner");
    }
    const started: RuntimeProcess = {
      processId: spec.id,
      project: entry.project,
      env: entry.env.name,
      build: leg.build.id,
      port: action.ports.public,
      internalPort: action.ports.internal,
      ready: false,
    };

    /* Settled AT THE SPAWN, which is where the rest of this rollout stops needing
       the lock. Observed in every path below, but never before the section has
       had its turn to fail. */
    const spawned = Promise.withResolvers<void>();
    spawned.promise.catch(() => {});

    let cancelled = false;
    let cleanup: Promise<void> | undefined;
    const stopStarted = (): Promise<void> => {
      cancelled = true;
      if (cleanup !== undefined) return cleanup;
      /* Unroute synchronously, before a stop that may take the whole grace. */
      known.set(spec.id, started);
      cleanup = (async (): Promise<void> => {
        try {
          await daemon.supervisor.stop(spec.id, { graceMs: driver.stopGraceMs });
          quarantined.delete(spec.id);
          known.delete(spec.id);
        } catch (error) {
          quarantined.add(spec.id);
          known.set(spec.id, started);
          pending.push(failureOf(error, { action: "stop", subject: spec.id }));
        }
      })();
      return cleanup;
    };

    const section = withLock(
      registry,
      {
        space: POINTER_LOCK_SPACE,
        name: pointerLockName(action.project, action.env),
        holder,
        timeoutMs: lockTimeoutMs,
      },
      async (signal) => {
        let processStarted = false;
        try {
          await driver.activateVersion(fleetPrefix(action.project, action.env), version);
          signal.throwIfAborted();
          await daemon.supervisor.start(spec);
          processStarted = true;
          signal.throwIfAborted();
          /* THE MOMENT THE PROCESS EXISTS, and the one a held wake is waiting on:
             everything past here — the bookkeeping, the gate, the rest of the hold
             — runs beside it rather than in front of it. */
          observe?.emit({ type: "rollout.spawned", processId: spec.id, build: leg.build.id });
          spawned.resolve();
          /* The process is running and has not read the pointer yet. Held for it,
             because nothing here can observe the read itself. */
          await delay(holdMs, signal);
          signal.throwIfAborted();
        } catch (error) {
          if (processStarted) await stopStarted();
          throw error;
        }
      },
    );
    /* A section that failed BEFORE the spawn — a lock it could not take, an
       activation that raised, a spawn that did not happen — fails the wait below,
       so nothing is registered and nothing is gated. One that failed after finds
       this already settled, and is raised by the await further down instead. */
    section.catch((error: unknown) => {
      spawned.reject(error);
    });

    let gating: Promise<void> | undefined;
    let spawnFailed = false;
    await spawned.promise.catch(() => {
      spawnFailed = true;
    });

    if (!spawnFailed) {
      /* Both off the lock, and both the moment the spawn returned: this is what
         the wake surface holding a request for this process is waiting to see. */
      known.set(spec.id, started);
      gating = gateStarted(started, pending, () => cancelled, stopStarted);
      /* Awaited in every path below; this only keeps a gate that fails while the
         hold is still running from being read as unhandled. */
      gating.catch(() => {});
    }

    try {
      /* The rollout is not done until the hold it owes the spawned process has
         run out, and a lock lost during it is this rollout's failure exactly as
         it was when nothing overlapped it. */
      await section;
    } catch (error) {
      if (gating !== undefined) {
        /* A process that may have read a superseded pointer cannot survive this
           rollout. Stop is idempotent, so this also closes the narrow loss after
           the callback's final signal check. */
        await stopStarted();
        await gating.catch((failed: unknown) => {
          pending.push(failureOf(failed, { action: "await-ready", subject: spec.id }));
        });
      }
      throw error;
    }
    /* The hold is over and the environment's pointer lock is back. It may well
       land AFTER the gate below has already reported: the hold guards the
       POINTER, not the gate, and the two overlap on purpose. */
    observe?.emit({ type: "rollout.holdEnded", processId: spec.id });
    await gating;
  }

  /**
   * Gates the process a rollout has just spawned: the half of a rollout that
   * holds no lock, and therefore the half that runs while the pointer hold is
   * still counting down. Registering the process happens at the spawn itself,
   * because the wake surface reads it from there.
   */
  async function gateStarted(
    started: RuntimeProcess,
    pending: ReconcileFailure[],
    cancelled: () => boolean,
    stop: () => Promise<void>,
  ): Promise<void> {
    if (await gate(started)) {
      if (cancelled()) return;
      known.set(started.processId, { ...started, ready: true });
      return;
    }
    if (cancelled()) return;
    pending.push(noted(started.processId, "the process did not pass its readiness gate"));

    /*
     * A process this rollout started has never answered a request, so stopping
     * it costs nothing and frees its id for another attempt — whatever was
     * serving the environment before keeps serving it, and a split leg that
     * cannot come up leaves its share with the legs that are up.
     *
     * TODO: a build that never passes its gate is started and stopped once per
     * pass. Backing that off belongs with the failure accounting that reports it.
     */
    await stop();
  }

  /**
   * Gates a process that was ALREADY running when the pass began.
   *
   * Never stops it, whatever the probe says: it may be a live server having a
   * bad minute, and it is the only thing its environment has at that build. The
   * gate that may stop what it probed is the one inside {@link runRollout},
   * which only ever probes a process it has just started itself.
   */
  async function runGate(
    action: Extract<ReconcileAction, { type: "await-ready" }>,
    pending: ReconcileFailure[],
  ): Promise<void> {
    const process = known.get(action.processId);
    if (process === undefined) return;

    if (quarantined.has(action.processId)) {
      try {
        await daemon.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
        quarantined.delete(action.processId);
        known.delete(action.processId);
      } catch (error) {
        known.set(action.processId, { ...process, ready: false });
        pending.push(failureOf(error, { action: "stop", subject: action.processId }));
      }
      return;
    }

    if (process.port === UNKNOWN_PORT) {
      /* Nothing to send a probe to. Reported rather than waited on: a gate that
         ran anyway would spend its whole deadline failing to connect, and the
         next pass would not start until it gave up. */
      pending.push(
        noted(
          action.processId,
          "the process was not started by this daemon, so its listeners are unknown",
        ),
      );
      return;
    }

    if (await gate(process)) {
      known.set(action.processId, { ...process, ready: true });
      return;
    }
    pending.push(noted(action.processId, "the process did not pass its readiness gate"));
  }

  /**
   * The readiness gate, and the one place its outcome is reported from.
   *
   * THE ATTEMPTS COME FROM THE DRIVER AND THE DURATION FROM HERE, because a gate
   * that passed on the first attempt and one that passed on the twelfth both
   * answer the same `true` — and only the pair tells a build that is slow to come
   * up from one that is merely up. Per-attempt reporting would be noise: what is
   * worth knowing is how hard it had to try, not each try.
   *
   * The per-call probe options exist only while this node is observing; off, the
   * shared object is handed straight through and no gate allocates anything.
   */
  async function gate(started: RuntimeProcess): Promise<boolean> {
    if (observe === undefined) return driver.probeReady(started, probe);

    let attempts = 0;
    const startedMs = observe.nowMs();
    const passed = await driver.probeReady(started, {
      ...probe,
      onAttempt: (): void => {
        attempts++;
      },
    });

    observe.emit(
      passed
        ? {
            type: "gate.passed",
            processId: started.processId,
            attempts,
            durationMs: observe.nowMs() - startedMs,
          }
        : { type: "gate.failed", processId: started.processId, attempts },
    );
    return passed;
  }

  return {
    async execute(plan, desired, pending): Promise<void> {
      const wanted = new Map(
        desired.map((entry) => [placement(entry.project, entry.env.name), entry]),
      );

      for (const action of plan) {
        try {
          switch (action.type) {
            case "rollout": {
              await runRollout(action, wanted, pending);
              break;
            }
            case "await-ready": {
              await runGate(action, pending);
              break;
            }
            case "stop": {
              await daemon.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
              quarantined.delete(action.processId);
              known.delete(action.processId);
              break;
            }
          }
        } catch (error) {
          pending.push(failureOf(error, { action: action.type, subject: subjectOf(action) }));
        }
      }
      const actual = this.currentProcesses();
      const running = new Set(actual.map((process) => process.processId));
      const live = transitions.filter((entry) => running.has(entry.processId));
      const snapshot = actual.map((process) => ({
        owner: { namespace: "process", id: process.processId },
        mb: daemon.config.runtime.creditMb ?? DEFAULT_RUNTIME_CREDIT_MB,
      }));
      if (live.length > 0) {
        credits.settleTransitions(
          live.map((entry) => entry.hold),
          snapshot,
        );
      } else credits.replaceRuntime(snapshot);
      for (const entry of transitions) if (!running.has(entry.processId)) entry.hold.release();
      transitions.length = 0;
    },

    currentProcesses(): RuntimeProcess[] {
      const processes: RuntimeProcess[] = [];

      for (const status of daemon.supervisor.list()) {
        if (status.state !== "running") {
          quarantined.delete(status.id);
          known.delete(status.id);
          continue;
        }

        const bookkept = known.get(status.id);
        if (bookkept !== undefined) {
          processes.push(quarantined.has(status.id) ? { ...bookkept, ready: false } : bookkept);
          continue;
        }

        /*
         * A running process this node has no bookkeeping for: its id still says
         * what it serves, but not which ports it listens on, so its readiness
         * cannot be established. It is reported every pass and never stopped,
         * because it may well be the only thing serving its environment.
         *
         * TODO: this disappears once the daemon persists its process table
         * across restarts; today it can only happen under a supervisor that
         * outlives the daemon, since a supervised process is a child of this one.
         */
        const identity = parseProcessId(status.id);
        if (identity === null) continue;

        const adopted: RuntimeProcess = {
          processId: status.id,
          project: identity.project,
          env: identity.env,
          build: identity.build,
          port: UNKNOWN_PORT,
          internalPort: UNKNOWN_PORT,
          ready: false,
        };
        known.set(status.id, adopted);
        processes.push(adopted);
      }
      return processes;
    },
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const aborted = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Records a readiness failure against the process it concerns. */
function noted(processId: string, detail: string): ReconcileFailure {
  return { at: new Date().toISOString(), action: "await-ready", subject: processId, detail };
}

export function failureOf(
  error: unknown,
  about: { action?: ReconcileAction["type"]; subject?: string },
): ReconcileFailure {
  return {
    at: new Date().toISOString(),
    ...about,
    detail: describeError(error),
    ...(error instanceof ScafoError && error.code === "capacity-unavailable"
      ? { code: error.code }
      : {}),
  };
}

function placement(project: string, env: string): string {
  return `${project}/${env}`;
}

/**
 * What a failed action concerns. Always a process id — the one a rollout would
 * have produced, or the one the action names — so every failure of a pass points
 * at a project, an environment AND a build, which is what tells two legs of one
 * environment apart.
 */
function subjectOf(action: ReconcileAction): string {
  return action.type === "rollout"
    ? formatProcessId({ project: action.project, env: action.env, build: action.build })
    : action.processId;
}
