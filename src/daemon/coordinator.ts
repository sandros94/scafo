/*
 * The coordinator loop: the one node that runs the work the registry can only
 * have one writer for — assigning environments to nodes, and reaping.
 *
 * There is no consensus protocol behind this — the lease in the bucket is the
 * whole election. A node takes it when it is free, renews it while it holds it,
 * and the moment a renewal is refused it stops being the coordinator, before it
 * finds out who replaced it.
 */

import { isScafoError } from "../core/error.ts";
import { nowDate } from "../core/registry/context.ts";
import {
  acquireLease,
  DEFAULT_LEASE_TTL_MS,
  type LeaseHandle,
  releaseLease,
  renewLease,
} from "../core/registry/lease.ts";
import {
  type ActivitySource,
  executeReap,
  planReap,
  type ReapOptions,
} from "../core/registry/reaper.ts";
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
  /**
   * Stops the loop and gives the lease up, so the next node takes it at once
   * rather than waiting out the TTL. Best effort: a release that fails changes
   * nothing, because the TTL expires the lease anyway.
   */
  stop(): Promise<void>;
  /**
   * Runs one iteration: take or renew the lease, assign every environment to
   * the nodes that should serve it, then reap when a reap is due.
   */
  runOnce(): Promise<void>;
  status(): CoordinatorStatus;
  /**
   * The fenced handle that lease-gated registry calls take, or null when this
   * node is not the coordinator. Callers must pass it rather than re-reading the
   * lease: it carries the ETag that separates this holder from its successor.
   */
  handle(): LeaseHandle | null;
}

export interface CoordinatorOptions {
  /** Lifetime written into the lease. Defaults to {@link DEFAULT_LEASE_TTL_MS}. */
  ttlMs?: number;
  /** Time between reaps while holding. Defaults to {@link DEFAULT_REAP_INTERVAL_MS}. */
  reapIntervalMs?: number;
  /**
   * Age past which an unreferenced build may be reaped. Absent reaps no build at
   * all: an installation that has never said how long it keeps builds is not one
   * whose builds should start disappearing.
   */
  buildRetentionMs?: number;
  /** Where the reaper reads last-request times; absent falls back to record timestamps. */
  activity?: ActivitySource;
  /** How long a node counts as live for placement; defaults to three heartbeats. */
  livenessWindowMs?: number;
}

/**
 * Builds the coordinator loop for this node.
 *
 * Nothing runs until {@link Coordinator.start} is called, or
 * {@link Coordinator.runOnce} is awaited. Every node may run one: they compete
 * for the same lease, and all but one of them stay candidates.
 */
export function createCoordinator(daemon: DaemonContext, opts?: CoordinatorOptions): Coordinator {
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  /* Three attempts inside one lifetime: two renewals may be lost to a slow
     bucket before the lease this node holds is allowed to go stale under it. */
  const tickMs = Math.max(1, Math.floor(ttlMs / 3));
  const reapIntervalMs = opts?.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const assignOptions =
    opts?.livenessWindowMs === undefined ? {} : { livenessWindowMs: opts.livenessWindowMs };
  const reapOptions: ReapOptions = {
    ...(opts?.activity === undefined ? {} : { activity: opts.activity }),
    ...(opts?.buildRetentionMs === undefined
      ? {}
      : { buildRetention: { maxAgeMs: opts.buildRetentionMs } }),
  };

  let held: LeaseHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  /* Epoch milliseconds of the last reap, on the registry's clock; null until one
     has run, so the node that has just become coordinator reaps straight away. */
  let lastReapMs: number | null = null;
  let lastReapAt: string | null = null;
  let lastReapFailure: string | null = null;
  let lastAssignAt: string | null = null;
  let lastAssignment: AssignmentResult | null = null;
  let lastAssignFailure: string | null = null;

  /** Drops to candidate. Nothing lease-gated may run again until it is retaken. */
  function drop(lease: LeaseHandle): void {
    held = null;
    console.log(
      `scafo: coordinator lease lost at fence ${String(lease.lease.fence)}, this node is no longer the coordinator`,
    );
  }

  async function takeOrKeep(): Promise<void> {
    const current = held;
    if (current === null) {
      const taken = await acquireLease(daemon.registry, daemon.nodeId, { ttlMs });
      if (taken === null) return;
      held = taken;
      console.log(`scafo: coordinator lease taken at fence ${String(taken.lease.fence)}`);
      return;
    }

    try {
      held = await renewLease(daemon.registry, current);
    } catch {
      /*
       * FENCING RULE: a renewal this node did not complete means it is not the
       * coordinator any more, whether the lease was taken from it or the bucket
       * merely could not be reached. Either way it stops here, on this tick,
       * BEFORE any coordinator-only work — the node that replaced it is already
       * acting, and two reapers deleting against one registry is exactly what
       * the lease exists to prevent. Re-acquiring on a later tick is allowed;
       * carrying on with a lease that was refused is not.
       */
      drop(current);
    }
  }

  /**
   * Decides which nodes serve what, every tick this node holds the lease.
   *
   * Not on the reap's interval: a reap is housekeeping that can wait a minute,
   * while an assignment is what puts an environment back on a node after the one
   * running it went away. A failure is recorded and the lease kept — the last
   * decision stands, and the nodes keep serving what it gave them.
   */
  async function assign(lease: LeaseHandle): Promise<void> {
    try {
      lastAssignment = await runAssignment(daemon.registry, lease, assignOptions);
      lastAssignFailure = null;
    } catch (error) {
      if (isScafoError(error) && error.code === "lease-lost") drop(lease);
      lastAssignment = null;
      lastAssignFailure = describe(error);
    } finally {
      lastAssignAt = new Date().toISOString();
    }
  }

  async function reap(lease: LeaseHandle): Promise<void> {
    try {
      const plan = await planReap(daemon.registry, reapOptions);
      await executeReap(daemon.registry, plan, lease, reapOptions);
      lastReapFailure = null;
    } catch (error) {
      /* A reap that failed is recorded and nothing more: the lease is kept and
         the next tick plans again from fresh state. The exception is a lost
         lease, which says this node is no longer the one doing this work. */
      if (isScafoError(error) && error.code === "lease-lost") drop(lease);
      lastReapFailure = describe(error);
    } finally {
      lastReapMs = nowDate(daemon.registry).getTime();
      lastReapAt = new Date().toISOString();
    }
  }

  async function runOnce(): Promise<void> {
    /* Ticks must not overlap: a renewal racing its own predecessor would write
       the lease twice from one holder, and the second write loses to the first. */
    if (inFlight) return;
    inFlight = true;

    try {
      await takeOrKeep();

      const lease = held;
      if (lease === null) return;

      await assign(lease);
      /* The same fencing rule the renewal obeys: an assignment that found the
         lease gone has already dropped this node to candidate, and nothing
         lease-gated may follow it on this tick. */
      if (held === null) return;

      if (lastReapMs !== null && nowDate(daemon.registry).getTime() - lastReapMs < reapIntervalMs) {
        return;
      }
      await reap(lease);
    } finally {
      inFlight = false;
    }
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
