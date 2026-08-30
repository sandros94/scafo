/* Internal: carrying out one reconcile plan against this node. */

import { describeError, ScafoError } from "../core/error.ts";
import { formatProcessId, parseProcessId } from "../core/placement/ids.ts";
import type { DesiredEnvironment, ReconcileAction } from "../core/placement/reconcile.ts";
import type { RegistryContext } from "../core/registry/context.ts";
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
  probe: ProbeOptions;
  baseEnv: Record<string, string>;
  known: Map<string, RuntimeProcess>;
}

export interface Executor {
  execute(
    plan: ReconcileAction[],
    desired: DesiredEnvironment[],
    pending: ReconcileFailure[],
    signal?: AbortSignal,
    beforeAdopt?: (processId: string) => Promise<void>,
  ): Promise<void>;
  currentProcesses(): RuntimeProcess[];
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { daemon, registry, driver, probe, baseEnv, known } = deps;
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
    if (entry === undefined || entry.env.deployment?.revision !== action.revision) return;

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

    const input: RuntimeSpecInput = {
      project: entry.project,
      env: entry.env,
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
    const spec = driver.processSpec(input);
    if (spec.id !== processId) {
      throw new ScafoError("invalid-input", "Runtime process id does not match credit owner");
    }
    const started: RuntimeProcess = {
      processId,
      project: entry.project,
      env: entry.env.name,
      attemptedRevision: 0,
      appliedRevision: 0,
      port: action.ports.public,
      internalPort: action.ports.internal,
      ready: false,
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
      observe?.emit({ type: "runtime.started", processId, revision: action.revision });

      if (await gate(started)) {
        signal?.throwIfAborted();
        const deployment = await driver.currentDeployment(
          started,
          signal === undefined ? undefined : { signal },
        );
        signal?.throwIfAborted();
        known.set(processId, {
          ...started,
          attemptedRevision: action.revision,
          appliedRevision: action.revision,
          deployment,
          ready: true,
        });
        return;
      }
      pending.push(noted(processId, "the process did not pass its readiness gate"));
      await stopStarted();
    } catch (error) {
      if (processStarted) await stopStarted();
      if (signal?.aborted !== true) throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function runAdopt(
    action: Extract<ReconcileAction, { type: "adopt" }>,
    pending: ReconcileFailure[],
    signal?: AbortSignal,
    beforeAdopt?: (processId: string) => Promise<void>,
  ): Promise<void> {
    signal?.throwIfAborted();
    const process = known.get(action.processId);
    if (process === undefined) return;
    if (process.internalPort === UNKNOWN_PORT) {
      throw new ScafoError("capability-missing", "Runtime listener is unknown", {
        detail: `the internal listener of "${action.processId}" is not available to this daemon`,
      });
    }
    const creditMb = daemon.config.runtime.creditMb ?? DEFAULT_RUNTIME_CREDIT_MB;
    const hold = credits.tryReserveTransition({
      owner: {
        namespace: "deployment-adoption",
        id: `${action.processId}@${String(action.revision)}`,
      },
      mb: creditMb,
    });
    if (hold === undefined) {
      throw new ScafoError("capacity-unavailable", "Adoption credit is unavailable", {
        detail:
          `this node cannot admit ${String(creditMb)}MiB to adopt deployment revision ` +
          `${String(action.revision)} for "${action.processId}" yet`,
      });
    }
    try {
      await beforeAdopt?.(action.processId);
      signal?.throwIfAborted();
      const adoption = await driver.adoptCurrent(
        process,
        signal === undefined ? undefined : { signal },
      );
      signal?.throwIfAborted();
      if (adoption.outcome === "rejected") {
        known.set(action.processId, { ...process, attemptedRevision: action.revision });
        throw new ScafoError("capability-missing", "Runtime rejected its deployment", {
          status: 502,
          detail: `celld rejected version "${adoption.version}": ${adoption.error}`,
        });
      }
      const adopted: RuntimeProcess = {
        ...process,
        attemptedRevision: action.revision,
        appliedRevision: action.revision,
        deployment: adoption.deployment,
        ready: false,
      };
      known.set(action.processId, adopted);
      observe?.emit({
        type: "runtime.adopted",
        processId: action.processId,
        revision: action.revision,
      });
      if (await gate(adopted)) {
        signal?.throwIfAborted();
        known.set(action.processId, { ...adopted, ready: true });
      } else {
        signal?.throwIfAborted();
        pending.push(
          noted(action.processId, "the adopted deployment did not pass its readiness gate"),
        );
      }
    } finally {
      hold.release();
    }
  }

  async function runGate(
    action: Extract<ReconcileAction, { type: "await-ready" }>,
    pending: ReconcileFailure[],
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
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
      pending.push(
        noted(
          action.processId,
          "the process was not started by this daemon, so its listeners are unknown",
        ),
      );
      return;
    }
    if (await gate(process)) {
      signal?.throwIfAborted();
      known.set(action.processId, { ...process, ready: true });
      return;
    }
    signal?.throwIfAborted();
    pending.push(noted(action.processId, "the process did not pass its readiness gate"));
  }

  async function gate(process: RuntimeProcess): Promise<boolean> {
    if (observe === undefined) return driver.probeReady(process, probe);
    let attempts = 0;
    const startedMs = observe.nowMs();
    const passed = await driver.probeReady(process, {
      ...probe,
      onAttempt: (): void => {
        attempts++;
      },
    });
    observe.emit(
      passed
        ? {
            type: "gate.passed",
            processId: process.processId,
            attempts,
            durationMs: observe.nowMs() - startedMs,
          }
        : { type: "gate.failed", processId: process.processId, attempts },
    );
    return passed;
  }

  return {
    async execute(plan, desired, pending, signal, beforeAdopt): Promise<void> {
      const wanted = new Map(
        desired.map((entry) => [placement(entry.project, entry.env.name), entry]),
      );
      for (const action of plan) {
        if (signal?.aborted === true) break;
        try {
          switch (action.type) {
            case "start":
              await runStart(action, wanted, pending, signal);
              break;
            case "adopt":
              await runAdopt(action, pending, signal, beforeAdopt);
              break;
            case "await-ready":
              await runGate(action, pending, signal);
              break;
            case "stop":
              await daemon.supervisor.stop(action.processId, { graceMs: driver.stopGraceMs });
              quarantined.delete(action.processId);
              known.delete(action.processId);
              break;
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
          processes.push(
            quarantined.has(status.id)
              ? { ...bookkept, ready: false, teardownPending: true }
              : bookkept,
          );
          continue;
        }
        const identity = parseProcessId(status.id);
        if (identity === null) continue;
        const adopted: RuntimeProcess = {
          processId: status.id,
          project: identity.project,
          env: identity.env,
          attemptedRevision: 0,
          appliedRevision: 0,
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

function subjectOf(action: ReconcileAction): string {
  return action.type === "start"
    ? formatProcessId({ project: action.project, env: action.env })
    : action.processId;
}
