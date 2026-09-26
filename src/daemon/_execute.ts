/* Internal: carrying out one reconcile plan against this node. */

import { describeError, isScafoError, ScafoError } from "../core/error.ts";
import { planLocalStateRemoval } from "../core/placement/local-state.ts";
import type { PortPair } from "../core/placement/ports.ts";
import type { ReconcileAction } from "../core/placement/reconcile.ts";
import { findVersionSkew, versionSkewError } from "../core/placement/version-skew.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { listNodeRecords } from "../core/registry/nodes.ts";
import { isSlug } from "../core/utils/slug.ts";
import type { ApplicationRecord, NodeRecord } from "../core/types/registry.ts";
import type { RuntimeDriver, RuntimeProcess, RuntimeSpecInput } from "../core/types/runtime.ts";
import type { DaemonContext } from "./app.ts";
import { advertisedAddress } from "./config.ts";

const UNKNOWN_PORT = 0;

export interface ReconcileFailure {
  at: string;
  /** What the pass was doing. `discard` is removing a gone application's local state. */
  action?: ReconcileAction["type"] | "discard";
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
    desired: ApplicationRecord[],
    pending: ReconcileFailure[],
    signal?: AbortSignal,
  ): Promise<void>;
  currentProcesses(): RuntimeProcess[];
  /**
   * Removes what this node still holds locally for applications the registry no
   * longer has, leaving every other reason a process stopped alone.
   *
   * `registered` comes from a registry read that SUCCEEDED and from nothing
   * else: a pass whose read failed never calls this, because a registry that
   * could not be read is not an installation with no applications in it. What
   * cannot be removed is one failure of the pass, retried by the next.
   */
  discardLocalState(registered: ReadonlySet<string>, pending: ReconcileFailure[]): Promise<void>;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { daemon, driver, baseEnv, known, registry } = deps;
  const observe = daemon.observability;
  const quarantined = new Set<string>();

  async function runStart(
    action: Extract<ReconcileAction, { type: "start" }>,
    wanted: Map<string, ApplicationRecord>,
    pending: ReconcileFailure[],
    fleet: () => Promise<NodeRecord[]>,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const application = action.application;
    const entry = wanted.get(application);
    if (entry === undefined || entry.deployment === null) return;

    /*
     * BEFORE ANYTHING IS READ OR SPAWNED: a process that keeps exiting is
     * started again on a jittered backoff rather than on every pass. A start
     * costs a fleet listing, a runtime process and a bucket that process then
     * opens, and a wedged application would otherwise pay all three every five
     * seconds forever. Nothing is reported here — the pass has not failed, it
     * is waiting — and `GET /v1/state` carries the deadline it is waiting for.
     */
    if (daemon.processHealth?.mayStart(application) === false) return;

    /*
     * ASKED HERE, AS LATE AS THE ANSWER IS STILL USEFUL: the application's Celld
     * fleet takes one version, and the node that would break that is the one
     * about to start a second binary over it. Refused rather than raised, so the
     * rest of the plan still runs and the next pass tries again — the other node
     * stopping is all it takes.
     */
    const about = { application, celld: daemon.versions.celld };
    const skew = findVersionSkew(await fleet(), {
      ...about,
      selfId: daemon.nodeId,
      now: nowDate(registry),
    });
    if (skew.length > 0) {
      pending.push(
        failureOf(versionSkewError(skew, about), { action: "start", subject: application }),
      );
      return;
    }

    /* The ports this application holds here, read off its own local state. A
       pair it cannot be started on any more is replaced rather than retried, so
       a foreign listener on a port cannot wedge an application indefinitely. */
    const held = await driver.ports(application);
    if (held.replaced !== undefined) {
      console.error(
        `scafo: "${application}" no longer holds ${pairText(held.replaced)} on this node ` +
          `(something else is listening there) and now holds ${pairText(held.ports)}`,
      );
    }

    const spec = driver.processSpec(runtimeInput(entry, held.ports));
    if (spec.id !== application) {
      throw new ScafoError("invalid-input", "Runtime process id does not match the application");
    }
    const started: RuntimeProcess = {
      application,
      port: held.ports.public,
      internalPort: held.ports.internal,
    };

    let processStarted = false;
    let cleanup: Promise<void> | undefined;
    const stopStarted = (): Promise<void> => {
      if (cleanup !== undefined) return cleanup;
      if (!processStarted) return Promise.resolve();
      known.set(application, started);
      cleanup = (async (): Promise<void> => {
        try {
          await daemon.supervisor.stop(application, { graceMs: driver.stopGraceMs });
          daemon.processHealth?.stopped(application);
          quarantined.delete(application);
          known.delete(application);
        } catch (error) {
          quarantined.add(application);
          known.set(application, started);
          pending.push(failureOf(error, { action: "stop", subject: application }));
        }
      })();
      return cleanup;
    };
    const cancel = (): void => void stopStarted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      /* Before the process, because the process works out of them: a run that
         had to create its own would be one that started somewhere else. */
      await driver.prepareLocalState(application);
      signal?.throwIfAborted();
      await daemon.supervisor.start(spec);
      processStarted = true;
      daemon.processHealth?.started(application);
      signal?.throwIfAborted();
      known.set(application, started);
      observe?.emit({ type: "runtime.started", application });
    } catch (error) {
      if (processStarted) await stopStarted();
      if (signal?.aborted !== true) throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async function runStop(action: Extract<ReconcileAction, { type: "stop" }>): Promise<void> {
    try {
      await daemon.supervisor.stop(action.application, { graceMs: driver.stopGraceMs });
      /* A stop the daemon asked for ends this process's history: an application
         placed here again later starts fresh rather than inheriting the exits
         of the process that was retired. */
      daemon.processHealth?.stopped(action.application);
      quarantined.delete(action.application);
      known.delete(action.application);
    } catch (error) {
      quarantined.add(action.application);
      throw error;
    }
  }

  function runtimeInput(entry: ApplicationRecord, ports: PortPair): RuntimeSpecInput {
    return {
      application: entry,
      ports,
      node: {
        id: daemon.nodeId,
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

  function currentProcesses(): RuntimeProcess[] {
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
      /* A supervised id that is no application name is not one of ours. */
      if (!isSlug(status.id)) continue;
      const adopted: RuntimeProcess = {
        application: status.id,
        port: UNKNOWN_PORT,
        internalPort: UNKNOWN_PORT,
      };
      known.set(status.id, adopted);
      processes.push(adopted);
    }
    return processes;
  }

  return {
    async execute(plan, desired, pending, signal): Promise<void> {
      const wanted = new Map(desired.map((entry) => [entry.name, entry]));
      /* The fleet is read once per pass, and only by a pass that starts
         something: a steady state costs nothing, and a pass held back by
         another node's version asks about it once, not once per application. */
      let fleet: Promise<NodeRecord[]> | undefined;
      const readFleet = (): Promise<NodeRecord[]> => (fleet ??= listNodeRecords(registry));
      for (const action of plan) {
        if (signal?.aborted === true) break;
        try {
          if (action.type === "start") await runStart(action, wanted, pending, readFleet, signal);
          else await runStop(action);
        } catch (error) {
          pending.push(failureOf(error, { action: action.type, subject: action.application }));
        }
      }
    },

    async discardLocalState(registered, pending): Promise<void> {
      let held: string[];
      try {
        held = await driver.heldLocalState();
      } catch (error) {
        pending.push(failureOf(error, { action: "discard" }));
        return;
      }

      const running = new Set(currentProcesses().map((entry) => entry.application));
      for (const application of planLocalStateRemoval({ held, registered, running })) {
        try {
          await driver.removeLocalState(application);
        } catch (error) {
          pending.push(failureOf(error, { action: "discard", subject: application }));
        }
      }
    },

    currentProcesses,
  };
}

/** A pair as one line of a log names it: the public port, then the internal one. */
function pairText(pair: PortPair): string {
  return `${String(pair.public)}/${String(pair.internal)}`;
}

export function failureOf(
  error: unknown,
  about: { action?: ReconcileFailure["action"]; subject?: string },
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
