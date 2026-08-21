/* Internal: carrying out one reconcile plan against this node. */

import { isScafoError, ScafoError } from "../core/error.ts";
import { formatProcessId, parseProcessId } from "../core/placement/ids.ts";
import type { DesiredEnvironment, ReconcileAction } from "../core/placement/reconcile.ts";
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
import type { AgentContext } from "./app.ts";
import { advertisedAddress } from "./config.ts";

/** Stands in for the listeners of a process this agent did not start itself. */
const UNKNOWN_PORT = 0;

/** Something one pass could not do. */
export interface ReconcileFailure {
  /** When it was recorded. */
  at: string;
  /** The kind of action that failed, when one was being executed. */
  action?: ReconcileAction["type"];
  /** What it concerned: a process id, or a `project/environment` pair. */
  subject?: string;
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
  agent: AgentContext;
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
  const { agent, driver, probe, baseEnv, known } = deps;
  const holdMs = deps.pointerLock?.holdMs ?? POINTER_READ_HOLD_MS;
  const lockTimeoutMs = deps.pointerLock?.timeoutMs ?? ROLLOUT_LOCK_TIMEOUT_MS;
  const holder = lockHolder(agent.nodeId);

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
      vars: await openEnvironmentVars(agent.registry, entry, agent.varsetKey),
      ports: action.ports,
      node: {
        endpoint: agent.config.bucket.endpoint,
        region: agent.config.bucket.region,
        bucket: agent.config.bucket.bucket,
        keyPrefix: agent.config.bucket.prefix,
        accessKey: agent.config.bucket.accessKey,
        secretKey: agent.config.bucket.secretKey,
        advertiseHost: advertisedAddress(agent.config.node).host,
        bindHost: agent.config.runtime.bindHost,
      },
      capacity: agent.capacity,
      baseEnv,
    };

    /* Built before the lock is taken, and deliberately: opening a varset is a
       bucket read that may refuse the whole rollout, and the section below is
       only the three steps that must not be interleaved with another writer. */
    const spec = driver.processSpec(input);

    await withLock(
      agent.registry,
      {
        space: POINTER_LOCK_SPACE,
        name: pointerLockName(action.project, action.env),
        holder,
        timeoutMs: lockTimeoutMs,
      },
      async () => {
        await driver.activateVersion(fleetPrefix(action.project, action.env), version);
        await agent.supervisor.start(spec);
        /* The process is running and has not read the pointer yet. Held for it,
           because nothing here can observe the read itself. */
        await delay(holdMs);
      },
    );

    const started: RuntimeProcess = {
      processId: spec.id,
      project: entry.project,
      env: entry.env.name,
      build: leg.build.id,
      port: action.ports.public,
      internalPort: action.ports.internal,
      ready: false,
    };
    known.set(spec.id, started);

    if (await driver.probeReady(started, probe)) {
      known.set(spec.id, { ...started, ready: true });
      return;
    }
    pending.push(noted(spec.id, "the process did not pass its readiness gate"));

    /*
     * A process this rollout started has never answered a request, so stopping
     * it costs nothing and frees its id for another attempt — whatever was
     * serving the environment before keeps serving it, and a split leg that
     * cannot come up leaves its share with the legs that are up.
     *
     * TODO: a build that never passes its gate is started and stopped once per
     * pass. Backing that off belongs with the failure accounting that reports it.
     */
    await agent.supervisor.stop(spec.id, { graceMs: driver.stopGraceMs });
    known.delete(spec.id);
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

    if (process.port === UNKNOWN_PORT) {
      /* Nothing to send a probe to. Reported rather than waited on: a gate that
         ran anyway would spend its whole deadline failing to connect, and the
         next pass would not start until it gave up. */
      pending.push(
        noted(
          action.processId,
          "the process was not started by this agent, so its listeners are unknown",
        ),
      );
      return;
    }

    if (await driver.probeReady(process, probe)) {
      known.set(action.processId, { ...process, ready: true });
      return;
    }
    pending.push(noted(action.processId, "the process did not pass its readiness gate"));
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
              await agent.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
              known.delete(action.processId);
              break;
            }
          }
        } catch (error) {
          pending.push(failureOf(error, { action: action.type, subject: subjectOf(action) }));
        }
      }
    },

    currentProcesses(): RuntimeProcess[] {
      const processes: RuntimeProcess[] = [];

      for (const status of agent.supervisor.list()) {
        if (status.state !== "running") {
          known.delete(status.id);
          continue;
        }

        const bookkept = known.get(status.id);
        if (bookkept !== undefined) {
          processes.push(bookkept);
          continue;
        }

        /*
         * A running process this node has no bookkeeping for: its id still says
         * what it serves, but not which ports it listens on, so its readiness
         * cannot be established. It is reported every pass and never stopped,
         * because it may well be the only thing serving its environment.
         *
         * TODO: this disappears once the agent persists its process table across
         * restarts; today it can only happen under a supervisor that outlives
         * the agent, since a supervised process is a child of this one.
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Records a readiness failure against the process it concerns. */
function noted(processId: string, detail: string): ReconcileFailure {
  return { at: new Date().toISOString(), action: "await-ready", subject: processId, detail };
}

export function failureOf(
  error: unknown,
  about: { action?: ReconcileAction["type"]; subject?: string },
): ReconcileFailure {
  return { at: new Date().toISOString(), ...about, detail: describe(error) };
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

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
