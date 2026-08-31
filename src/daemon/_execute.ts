/* Internal: carrying out one reconcile plan against this node. */

import { describeError, ScafoError } from "../core/error.ts";
import { formatProcessId, parseProcessId } from "../core/placement/ids.ts";
import type { DesiredEnvironment, ReconcileAction } from "../core/placement/reconcile.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import type { RuntimeDriver, RuntimeProcess, RuntimeSpecInput } from "../core/types/runtime.ts";
import { openEnvironmentVars } from "./_desired.ts";
import type { DaemonContext } from "./app.ts";
import { advertisedAddress } from "./config.ts";
import { DEFAULT_RUNTIME_CREDIT_MB } from "./_credit-controller.ts";

const UNKNOWN_PORT = 0;

export interface ReconcileFailure {
  at: string;
  action?: ReconcileAction["type"];
  subject?: string;
  code?: ScafoError["code"];
  detail: string;
}

export interface ExecutorDeps {
  daemon: DaemonContext;
  registry: RegistryContext;
  driver: RuntimeDriver;
  baseEnv: Record<string, string>;
  known: Map<string, RuntimeProcess>;
}

export interface Executor {
  execute(
    plan: ReconcileAction[],
    desired: DesiredEnvironment[],
    pending: ReconcileFailure[],
    signal?: AbortSignal,
  ): Promise<void>;
  currentProcesses(): RuntimeProcess[];
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { daemon, registry, driver, baseEnv, known } = deps;
  const observe = daemon.observability;
  if (daemon.credits === undefined) {
    throw new ScafoError("invalid-input", "Missing node credit controller");
  }
  const credits = daemon.credits;
  const quarantined = new Set<string>();
  const transitions: {
    hold: import("./_credit-controller.ts").CreditHold;
    processId: string;
  }[] = [];

  async function runStart(
    action: Extract<ReconcileAction, { type: "start" }>,
    wanted: Map<string, DesiredEnvironment>,
    pending: ReconcileFailure[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const entry = wanted.get(placement(action.project, action.env));
    if (entry === undefined || entry.env.deployment === null) return;

    const processId = formatProcessId({ project: action.project, env: action.env });
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
    transitions.push({ hold: transition, processId });

    const input = await runtimeInput(entry, action.ports);
    const spec = driver.processSpec(input);
    if (spec.id !== processId) {
      throw new ScafoError("invalid-input", "Runtime process id does not match credit owner");
    }
    const started: RuntimeProcess = {
      processId,
      project: entry.project,
      env: entry.env.name,
      configuredVarset: entry.varsetId ?? null,
      port: action.ports.public,
      internalPort: action.ports.internal,
    };

    let processStarted = false;
    let cleanup: Promise<void> | undefined;
    const stopStarted = (): Promise<void> => {
      if (cleanup !== undefined) return cleanup;
      if (!processStarted) return Promise.resolve();
      known.set(processId, started);
      cleanup = (async (): Promise<void> => {
        try {
          await daemon.supervisor.stop(processId, { graceMs: driver.stopGraceMs });
          quarantined.delete(processId);
          known.delete(processId);
        } catch (error) {
          quarantined.add(processId);
          known.set(processId, started);
          pending.push(failureOf(error, { action: "stop", subject: processId }));
        }
      })();
      return cleanup;
    };
    const cancel = (): void => void stopStarted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await daemon.supervisor.start(spec);
      processStarted = true;
      signal?.throwIfAborted();
      known.set(processId, started);
      observe?.emit({ type: "runtime.started", processId });
    } catch (error) {
      if (processStarted) await stopStarted();
      if (signal?.aborted !== true) throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function runStop(action: Extract<ReconcileAction, { type: "stop" }>): Promise<void> {
    try {
      await daemon.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
      quarantined.delete(action.processId);
      known.delete(action.processId);
    } catch (error) {
      quarantined.add(action.processId);
      throw error;
    }
  }

  async function runRestart(
    action: Extract<ReconcileAction, { type: "restart" }>,
    wanted: Map<string, DesiredEnvironment>,
    pending: ReconcileFailure[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const entry = wanted.get(placement(action.project, action.env));
    const process = known.get(action.processId);
    if (entry === undefined || process === undefined || entry.env.deployment === null) return;

    /* Decrypt and materialize the replacement before touching the process that
       still serves the environment. A bad varset therefore cannot turn a
       configuration error into downtime. */
    const input = await runtimeInput(entry, action.ports);
    const spec = driver.processSpec(input);
    if (spec.id !== action.processId) {
      throw new ScafoError("invalid-input", "Runtime process id does not match restart target");
    }
    const replacement: RuntimeProcess = {
      processId: action.processId,
      project: entry.project,
      env: entry.env.name,
      configuredVarset: entry.varsetId ?? null,
      port: action.ports.public,
      internalPort: action.ports.internal,
    };

    await runStop({ type: "stop", processId: action.processId, reason: "runtime restart" });
    signal?.throwIfAborted();
    let processStarted = false;
    let cleanup: Promise<void> | undefined;
    const stopReplacement = (): Promise<void> => {
      if (cleanup !== undefined) return cleanup;
      if (!processStarted) return Promise.resolve();
      known.set(action.processId, replacement);
      cleanup = (async (): Promise<void> => {
        try {
          await daemon.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
          quarantined.delete(action.processId);
          known.delete(action.processId);
        } catch (error) {
          quarantined.add(action.processId);
          pending.push(failureOf(error, { action: "stop", subject: action.processId }));
        }
      })();
      return cleanup;
    };
    const cancel = (): void => void stopReplacement();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await daemon.supervisor.start(spec);
      processStarted = true;
      signal?.throwIfAborted();
      known.set(action.processId, replacement);
      observe?.emit({ type: "runtime.started", processId: action.processId });
    } catch (error) {
      if (processStarted) await stopReplacement();
      if (signal?.aborted !== true) throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function runtimeInput(
    entry: DesiredEnvironment,
    ports: { public: number; internal: number },
  ): Promise<RuntimeSpecInput> {
    return {
      project: entry.project,
      env: entry.env,
      vars: await openEnvironmentVars(registry, entry, daemon.varsetKey),
      ports,
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
      maxRssMb: daemon.config.runtime.creditMb ?? DEFAULT_RUNTIME_CREDIT_MB,
      baseEnv,
    };
  }

  return {
    async execute(plan, desired, pending, signal): Promise<void> {
      const wanted = new Map(
        desired.map((entry) => [placement(entry.project, entry.env.name), entry]),
      );
      for (const action of plan) {
        if (signal?.aborted === true) break;
        try {
          if (action.type === "start") await runStart(action, wanted, pending, signal);
          else if (action.type === "restart") await runRestart(action, wanted, pending, signal);
          else await runStop(action);
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
          processes.push(
            quarantined.has(status.id) ? { ...bookkept, teardownPending: true } : bookkept,
          );
          continue;
        }
        const identity = parseProcessId(status.id);
        if (identity === null) continue;
        const adopted: RuntimeProcess = {
          processId: status.id,
          project: identity.project,
          env: identity.env,
          port: UNKNOWN_PORT,
          internalPort: UNKNOWN_PORT,
        };
        known.set(status.id, adopted);
        processes.push(adopted);
      }
      return processes;
    },
  };
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

function subjectOf(action: ReconcileAction): string {
  return action.type === "start"
    ? formatProcessId({ project: action.project, env: action.env })
    : action.processId;
}
