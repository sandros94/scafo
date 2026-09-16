/* Internal: carrying out one reconcile plan against this node. */

import { describeError, isScafoError, ScafoError } from "../core/error.ts";
import { formatProcessId, parseProcessId } from "../core/placement/ids.ts";
import type { DesiredEnvironment, ReconcileAction } from "../core/placement/reconcile.ts";
import { servingKey } from "../core/placement/serving.ts";
import { findVersionSkew, versionSkewError } from "../core/placement/version-skew.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { listNodeRecords } from "../core/registry/nodes.ts";
import type { NodeRecord } from "../core/types/registry.ts";
import type { RuntimeDriver, RuntimeProcess, RuntimeSpecInput } from "../core/types/runtime.ts";
import type { DaemonContext } from "./app.ts";
import { advertisedAddress } from "./config.ts";

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
  driver: RuntimeDriver;
  baseEnv: Record<string, string>;
  known: Map<string, RuntimeProcess>;
  /** Registry the pass reads through, so its reads are counted with the pass's. */
  registry: RegistryContext;
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
  const { daemon, driver, baseEnv, known, registry } = deps;
  const observe = daemon.observability;
  const quarantined = new Set<string>();

  async function runStart(
    action: Extract<ReconcileAction, { type: "start" }>,
    wanted: Map<string, DesiredEnvironment>,
    pending: ReconcileFailure[],
    fleet: () => Promise<NodeRecord[]>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const env = servingKey(action.project, action.env);
    const entry = wanted.get(env);
    if (entry === undefined || entry.env.deployment === null) return;

    const processId = formatProcessId({ project: action.project, env: action.env });

    /*
     * ASKED HERE, AS LATE AS THE ANSWER IS STILL USEFUL: the environment's Celld
     * fleet takes one version, and the node that would break that is the one
     * about to start a second binary over it. Refused rather than raised, so the
     * rest of the plan still runs and the next pass tries again — the other node
     * stopping is all it takes.
     */
    const about = { env, celld: daemon.versions.celld };
    const skew = findVersionSkew(await fleet(), {
      ...about,
      selfId: daemon.nodeId,
      now: nowDate(registry),
    });
    if (skew.length > 0) {
      pending.push(
        failureOf(versionSkewError(skew, about), { action: "start", subject: processId }),
      );
      return;
    }

    const spec = driver.processSpec(runtimeInput(entry, action.ports));
    if (spec.id !== processId) {
      throw new ScafoError("invalid-input", "Runtime process id does not match environment");
    }
    const started: RuntimeProcess = {
      processId,
      project: entry.project,
      env: entry.env.name,
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

  function runtimeInput(
    entry: DesiredEnvironment,
    ports: { public: number; internal: number },
  ): RuntimeSpecInput {
    return {
      project: entry.project,
      env: entry.env,
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
      baseEnv,
    };
  }

  return {
    async execute(plan, desired, pending, signal): Promise<void> {
      const wanted = new Map(
        desired.map((entry) => [servingKey(entry.project, entry.env.name), entry]),
      );
      /* The fleet is read once per pass, and only by a pass that starts
         something: a steady state costs nothing, and a pass held back by
         another node's version asks about it once, not once per environment. */
      let fleet: Promise<NodeRecord[]> | undefined;
      const readFleet = (): Promise<NodeRecord[]> => (fleet ??= listNodeRecords(registry));
      for (const action of plan) {
        if (signal?.aborted === true) break;
        try {
          if (action.type === "start") await runStart(action, wanted, pending, readFleet, signal);
          else await runStop(action);
        } catch (error) {
          pending.push(failureOf(error, { action: action.type, subject: subjectOf(action) }));
        }
      }
    },

    currentProcesses(): RuntimeProcess[] {
      const processes: RuntimeProcess[] = [];
      for (const status of daemon.supervisor.list()) {
        if (status.state !== "running") {
          /* The exit is read here and nowhere else, so this is the pass that
             owes the supervisor the word that it may drop the id. */
          quarantined.delete(status.id);
          known.delete(status.id);
          daemon.supervisor.forget(status.id);
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
    /* Carried when there is one: the code is the stable half of a failure, and
       a reader deciding what to do about a pass acts on it rather than on the
       sentence beside it. */
    ...(isScafoError(error) ? { code: error.code } : {}),
    detail: describeError(error),
  };
}

function subjectOf(action: ReconcileAction): string {
  return action.type === "start"
    ? formatProcessId({ project: action.project, env: action.env })
    : action.processId;
}
