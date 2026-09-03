/* Lease-elected coordinator for assignment and reaping. */

import { isScafoError, ScafoError } from "../core/error.ts";
import { nowDate } from "../core/registry/context.ts";
import {
  acquireLease,
  DEFAULT_LEASE_TTL_MS,
  type LeaseHandle,
  releaseLease,
  renewLease,
} from "../core/registry/lease.ts";
import { executeReap, planReap, type ReapOptions } from "../core/registry/reaper.ts";
import type { CoordinatorLease } from "../core/types/registry.ts";
import { type AssignmentResult, runAssignment } from "./_assign.ts";
import type { DaemonContext } from "./app.ts";

/** Time between two reaps when none is configured. */
export const DEFAULT_REAP_INTERVAL_MS: number = 60_000;

/** What the loop is doing, as reported by the node API. */
export interface CoordinatorStatus {
  /** True while this node holds the lease and may do coordinator-only work. */
  holding: boolean;
  /** The lease this node holds; null whenever it holds none. */
  lease: CoordinatorLease | null;
  /** ISO time the last reap finished, successfully or not; null before the first. */
  lastReapAt: string | null;
  /** Why the last reap failed; null when it went through. The lease is kept either way. */
  lastReapFailure: string | null;
  /** ISO time the last assignment pass finished; null before the first. */
  lastAssignAt: string | null;
  /** What that pass decided; null before the first one, or when it refused. */
  lastAssignment: AssignmentResult | null;
  /** Why the last assignment did nothing; null when it went through. */
  lastAssignFailure: string | null;
}

/** The loop, and the handle to run it once or on a timer. */
export interface Coordinator {
  start(): void;
  /** Stops and best-effort releases the lease; TTL handles a failed release. */
  stop(): Promise<void>;
  /**
   * Runs one iteration: take or renew the lease, assign every environment to
   * the nodes that should serve it, then reap when a reap is due.
   *
   * Resolves once an iteration has finished. A caller arriving while one is
   * already running joins THAT one rather than starting a second — see
   * `runOnce` for why a second would be unsafe — so it never returns having done
   * nothing while the lease question is still open.
   */
  runOnce(): Promise<void>;
  status(): CoordinatorStatus;
  /** Current fenced lease handle; callers must not replace it with a fresh read. */
  handle(): LeaseHandle | null;
}

export interface CoordinatorOptions {
  /** Lifetime written into the lease. Defaults to {@link DEFAULT_LEASE_TTL_MS}. */
  ttlMs?: number;
  /** Time between reaps while holding. Defaults to {@link DEFAULT_REAP_INTERVAL_MS}. */
  reapIntervalMs?: number;
  /** Unreferenced build retention. Omitted disables build reaping. */
  buildRetentionMs?: number;
  /** How long a node counts as live for placement; defaults to three heartbeats. */
  livenessWindowMs?: number;
}

/** Builds a candidate coordinator; work starts only on start or runOnce. */
export function createCoordinator(daemon: DaemonContext, opts?: CoordinatorOptions): Coordinator {
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  /* Renew at a third of the TTL: one renewal may fail or run late and the lease
     still holds; a second miss in the same TTL loses it. */
  const tickMs = Math.max(1, Math.floor(ttlMs / 3));
  const reapIntervalMs = opts?.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const assignOptions = {
    keepAlive,
    ...(opts?.livenessWindowMs === undefined ? {} : { livenessWindowMs: opts.livenessWindowMs }),
  };
  const reapOptions: ReapOptions = {
    keepAlive,
    ...(opts?.buildRetentionMs === undefined
      ? {}
      : { buildRetention: { maxAgeMs: opts.buildRetentionMs } }),
  };

  let held: LeaseHandle | null = null;
  /* When the lease was last written by this node, on the registry clock. */
  let renewedMs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /* The iteration currently running, shared by everyone who asks for one. */
  let inFlight: Promise<void> | null = null;
  /* Null permits an immediate reap after taking the lease. */
  let lastReapMs: number | null = null;
  let lastReapAt: string | null = null;
  let lastReapFailure: string | null = null;
  let lastAssignAt: string | null = null;
  let lastAssignment: AssignmentResult | null = null;
  let lastAssignFailure: string | null = null;
  let rememberedPending = new Map<string, string>();

  /** Drops to candidate. Nothing lease-gated may run again until it is retaken. */
  function drop(lease: LeaseHandle): void {
    if (held === null) return;
    held = null;
    console.log(
      `scafo: coordinator lease lost at fence ${String(lease.lease.fence)}, this node is no longer the coordinator`,
    );
  }

  /** Renews the held lease; a failed renewal loses authority until it is retaken. */
  async function renew(current: LeaseHandle): Promise<LeaseHandle | null> {
    try {
      held = await renewLease(daemon.registry, current);
    } catch {
      drop(current);
      return null;
    }
    renewedMs = nowDate(daemon.registry).getTime();
    return held;
  }

  async function takeOrKeep(): Promise<void> {
    const current = held;
    if (current !== null) {
      await renew(current);
      return;
    }
    const taken = await acquireLease(daemon.registry, daemon.nodeId, { ttlMs });
    if (taken === null) return;
    held = taken;
    renewedMs = nowDate(daemon.registry).getTime();
    console.log(`scafo: coordinator lease taken at fence ${String(taken.lease.fence)}`);
  }

  /**
   * What the assignment and the reap call between items. A pass over a large
   * installation, or a slow bucket, can outlast the TTL; renewing only at the
   * start of a tick would then hand the lease to another node mid-pass.
   */
  async function keepAlive(): Promise<LeaseHandle> {
    const current = held;
    if (current === null) throw new ScafoError("lease-lost", "Coordinator lease is no longer held");
    if (nowDate(daemon.registry).getTime() - renewedMs < tickMs) return current;

    const renewed = await renew(current);
    if (renewed === null) {
      throw new ScafoError("lease-lost", "Coordinator lease could not be renewed", {
        detail: `fence ${String(current.lease.fence)} was not renewed in time`,
      });
    }
    return renewed;
  }

  /** Runs assignment every held tick; failed assignments preserve the last decision. */
  async function assign(lease: LeaseHandle): Promise<void> {
    try {
      lastAssignment = await runAssignment(daemon.registry, lease, assignOptions);
      observePending(lastAssignment);
      lastAssignFailure = null;
    } catch (error) {
      if (isScafoError(error) && error.code === "lease-lost") drop(lease);
      lastAssignment = null;
      lastAssignFailure = describe(error);
    } finally {
      lastAssignAt = new Date().toISOString();
    }
  }

  /** Emits an operational transition once, not a five-second heartbeat forever. */
  function observePending(assignment: AssignmentResult): void {
    const observe = daemon.observability;
    if (observe === undefined) return;
    const next = new Map<string, string>();
    for (const failure of assignment.unplaced) {
      const fingerprint = JSON.stringify({ reason: failure.reason, detail: failure.detail });
      next.set(failure.target, fingerprint);
      if (rememberedPending.get(failure.target) === fingerprint) continue;
      const [project, env] = failure.target.split("/");
      if (project === undefined || env === undefined) continue;
      observe.emit({
        type: "placement.pending",
        project,
        env,
        reason: failure.reason,
      });
    }
    /* A resolution must forget the old state: recurrence is another real event. */
    rememberedPending = next;
  }

  async function reap(lease: LeaseHandle): Promise<void> {
    try {
      const plan = await planReap(daemon.registry, reapOptions);
      /* Planning reads the whole registry; the plan is executed under a lease
         that is fresh from here, not from the start of the tick. */
      await executeReap(daemon.registry, plan, await keepAlive(), reapOptions);
      lastReapFailure = null;
    } catch (error) {
      /* Retry failed reaps from fresh state; a lost lease also drops authority. */
      if (isScafoError(error) && error.code === "lease-lost") drop(lease);
      lastReapFailure = describe(error);
    } finally {
      lastReapMs = nowDate(daemon.registry).getTime();
      lastReapAt = new Date().toISOString();
    }
  }

  async function pass(): Promise<void> {
    await takeOrKeep();

    const lease = held;
    if (lease === null) return;

    await assign(lease);
    /* Assignment may lose the lease; skip remaining lease-gated work. */
    if (held === null) return;

    if (lastReapMs !== null && nowDate(daemon.registry).getTime() - lastReapMs < reapIntervalMs) {
      return;
    }
    await reap(lease);
  }

  /**
   * One iteration, and only ever one at a time: two passes would race their own
   * conditional lease writes, and the loser would read its own renewal as a
   * takeover and drop authority it never lost.
   *
   * A second caller therefore WAITS for the pass already running instead of
   * being told, silently, that nothing happened. It asked for the lease question
   * to be settled, and joining the running pass settles it.
   */
  function runOnce(): Promise<void> {
    inFlight ??= pass().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    runOnce,

    start(): void {
      if (timer !== null) return;

      timer = setInterval(() => void runOnce().catch(() => {}), tickMs);
      /* The loop must never be the reason the process stays alive. */
      const handle = timer as { unref?: () => void };
      handle.unref?.();
    },

    async stop(): Promise<void> {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }

      const lease = held;
      held = null;
      if (lease === null) return;
      try {
        await releaseLease(daemon.registry, lease);
      } catch {
        /* The TTL still expires it; a node on its way out waits for nothing. */
      }
    },

    status(): CoordinatorStatus {
      return {
        holding: held !== null,
        lease: held === null ? null : { ...held.lease },
        lastReapAt,
        lastReapFailure,
        lastAssignAt,
        lastAssignment: lastAssignment === null ? null : { ...lastAssignment },
        lastAssignFailure,
      };
    },

    handle(): LeaseHandle | null {
      return held;
    },
  };
}

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
