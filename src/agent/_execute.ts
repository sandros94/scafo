/* Internal: carrying out one reconcile plan against this node. */

import { isScaloError, ScaloError } from "../core/error.ts";
import { parseProcessId } from "../core/placement/ids.ts";
import type { DesiredEnvironment, ReconcileAction } from "../core/placement/reconcile.ts";
import { fleetPrefix } from "../core/registry/paths.ts";
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

/** Everything the executor acts through. */
export interface ExecutorDeps {
  agent: AgentContext;
  driver: RuntimeDriver;
  /** Readiness gate settings applied to every process this executor gates. */
  probe: ProbeOptions;
  /** Environment every process starts from; must carry a usable `PATH`. */
  baseEnv: Record<string, string>;
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

  async function runActivate(
    action: Extract<ReconcileAction, { type: "activate" }>,
    wanted: Map<string, DesiredEnvironment>,
    blocked: Set<string>,
  ): Promise<void> {
    const key = placement(action.project, action.env);
    try {
      const version = wanted.get(key)?.build.celldVersionId;
      if (version === undefined) {
        throw new ScaloError("invalid-input", "Build has no runtime version", {
          detail:
            `build "${action.build}" of "${key}" carries no runtime version id, ` +
            `so the fleet cannot be pointed at it`,
        });
      }
      await driver.activateVersion(fleetPrefix(action.project, action.env), version);
    } catch (error) {
      blocked.add(key);
      throw error;
    }
  }

  async function runStart(
    action: Extract<ReconcileAction, { type: "start" }>,
    wanted: Map<string, DesiredEnvironment>,
    blocked: Set<string>,
    startedNow: Set<string>,
  ): Promise<void> {
    const key = placement(action.project, action.env);
    const entry = wanted.get(key);
    /* The activation that should have preceded this failed, and its own failure
       is already recorded; starting anyway would serve the wrong build. */
    if (entry === undefined || blocked.has(key)) return;

    const input: RuntimeSpecInput = {
      project: entry.project,
      env: entry.env,
      build: entry.build,
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
      },
      capacity: agent.capacity,
      baseEnv,
    };

    const spec = driver.processSpec(input);
    await agent.supervisor.start(spec);
    known.set(spec.id, {
      processId: spec.id,
      project: entry.project,
      env: entry.env.name,
      build: entry.build.id,
      port: action.ports.public,
      internalPort: action.ports.internal,
      ready: false,
    });
    startedNow.add(spec.id);
  }

  async function runGate(
    action: Extract<ReconcileAction, { type: "await-ready" }>,
    startedNow: Set<string>,
    pending: ReconcileFailure[],
  ): Promise<void> {
    const process = known.get(action.processId);
    /* Never started, because its activation failed earlier in this same plan. */
    if (process === undefined) return;

    if (process.port === UNKNOWN_PORT) {
      /* Nothing to send a probe to. Reported rather than waited on: a gate that
         ran anyway would spend its whole deadline failing to connect, and the
         next pass would not start until it gave up. */
      pending.push(
        noted(action, "the process was not started by this agent, so its listeners are unknown"),
      );
      return;
    }

    if (await driver.probeReady(process, probe)) {
      known.set(action.processId, { ...process, ready: true });
      return;
    }
    pending.push(noted(action, "the process did not pass its readiness gate"));

    /*
     * A process this pass started has never answered a request, so stopping it
     * costs nothing and frees its id for another attempt — whatever was serving
     * the environment before keeps serving it. A process that was already
     * running is left alone: it may be a live server having a bad minute, and it
     * is the only one its environment has.
     *
     * TODO: a build that never passes its gate is started and stopped once per
     * pass. Backing that off belongs with the failure accounting that reports it.
     */
    if (!startedNow.has(action.processId)) return;
    await agent.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
    known.delete(action.processId);
  }

  return {
    async execute(plan, desired, pending): Promise<void> {
      const wanted = new Map(
        desired.map((entry) => [placement(entry.project, entry.env.name), entry]),
      );
      /* Environments whose fleet pointer could not be moved: starting a process
         for one of them would serve whatever the pointer still names. */
      const blocked = new Set<string>();
      /* Processes this pass started, and which have therefore never served a
         request — the only ones a failed readiness gate may stop. */
      const startedNow = new Set<string>();

      for (const action of plan) {
        try {
          switch (action.type) {
            case "activate": {
              await runActivate(action, wanted, blocked);
              break;
            }
            case "start": {
              await runStart(action, wanted, blocked, startedNow);
              break;
            }
            case "await-ready": {
              await runGate(action, startedNow, pending);
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

/** Records a failure against the process an action names. */
function noted(
  action: Extract<ReconcileAction, { type: "await-ready" }>,
  detail: string,
): ReconcileFailure {
  return { at: new Date().toISOString(), action: action.type, subject: action.processId, detail };
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

function subjectOf(action: ReconcileAction): string {
  return action.type === "activate" || action.type === "start"
    ? placement(action.project, action.env)
    : action.processId;
}

/** The specifics a scalo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScaloError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
