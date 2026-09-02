/* Flushes one node's observation records and optional counters to its bucket
   prefix. Failed writes retain a bounded event buffer; retention only sweeps
   that node's prefix. */

import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { observeKey, observeNodePrefix, parseObserveKey } from "../core/registry/paths.ts";
import type { CasStore } from "../core/types/store.ts";
import { isScafoError } from "../core/error.ts";
import { stableStringify } from "../core/utils/json.ts";
import type { IngressCounters } from "./access-counters.ts";
import type { Observability } from "./observe.ts";
import { PARQUET_CODEC } from "./observe-parquet.ts";
import {
  type ObserveCodec,
  type ObserveCountersRecord,
  type ObserveEventRecord,
  type ObserveFlushRecord,
  type ObserveRecord,
  OBSERVE_RECORD_VERSION,
} from "./observe-records.ts";

/** Time between flushes, when nothing else has already triggered one. */
export const OBSERVE_FLUSH_INTERVAL_MS: number = 60_000;

/** Ring-drain cadence; the pending buffer prevents ring overflow between flushes. */
export const OBSERVE_DRAIN_INTERVAL_MS: number = 5_000;

/** Pending records that trigger a flush of their own, ahead of the interval. */
export const OBSERVE_FLUSH_MAX_RECORDS: number = 2_000;

/** Records held while flushes are failing; past it the oldest are dropped and counted. */
export const OBSERVE_PENDING_MAX_RECORDS: number = 20_000;

/** Days a node keeps its own observations before sweeping them away. */
export const OBSERVE_RETENTION_DAYS: number = 30;

/** Flushes between retention sweeps: at the default cadence, one sweep an hour. */
export const OBSERVE_SWEEP_EVERY_FLUSHES: number = 60;

/** Keys one sweep may delete; whatever is left over goes on the next one. */
export const OBSERVE_SWEEP_MAX_DELETES: number = 500;

const DAY_MS = 86_400_000;

/** What the flusher has done since this node booted. */
export interface ObserveFlushStatus {
  /** Flushes that landed. */
  flushes: number;
  /** Records waiting to go out; nonzero means the last attempt did not land. */
  pending: number;
  /** Events the ring dropped before a drain reached them. */
  ringDropped: number;
  /** Records the pending buffer dropped because flushes were failing. */
  pendingDropped: number;
  /** When the last flush landed; null while none has. */
  lastFlushAt: string | null;
  /** Why the last attempt did not land; null while they are landing. */
  lastFailure: string | null;
  /** Keys the retention sweeps have deleted. */
  swept: number;
}

/** Bounded observation flushing and retention for one node. */
export interface ObserveFlusher {
  /**
   * One cycle: drain the ring, and flush when the interval has run or the
   * pending buffer has crossed its bound. Never throws.
   */
  tick(): Promise<void>;
  /**
   * Drains and writes whatever is pending, whatever the cadence says. Answers
   * whether anything was written — a node with nothing new to say writes no
   * object at all. Never throws.
   */
  flush(): Promise<boolean>;
  /** One retention sweep, bounded. Answers the keys it deleted. Never throws. */
  sweep(): Promise<string[]>;
  status(): ObserveFlushStatus;
  /** Begins draining and flushing on the cadences above. */
  start(): void;
  /** Stops scheduled work; {@link ObserveFlusher.flush} can still write pending records. */
  stop(): void;
}

export interface ObserveFlusherOptions {
  /** Node whose segment of the keyspace this writes and sweeps, and nothing else. */
  nodeId: string;
  /** The seam being drained. A disabled one is legal and simply yields nothing. */
  observability: Observability;
  /** What the ingress served, when this node counts it at all. */
  counters?: IngressCounters;
  /** How records become bytes. Defaults to {@link PARQUET_CODEC}. */
  codec?: ObserveCodec;
  /** Time between flushes. Defaults to {@link OBSERVE_FLUSH_INTERVAL_MS}. */
  intervalMs?: number;
  /** Time between drains. Defaults to {@link OBSERVE_DRAIN_INTERVAL_MS}. */
  drainIntervalMs?: number;
  /** Pending records that trigger a flush. Defaults to {@link OBSERVE_FLUSH_MAX_RECORDS}. */
  maxRecords?: number;
  /** Pending records held at most. Defaults to {@link OBSERVE_PENDING_MAX_RECORDS}. */
  pendingMax?: number;
  /** Days kept. Defaults to {@link OBSERVE_RETENTION_DAYS}. */
  retentionDays?: number;
  /** Flushes between sweeps. Defaults to {@link OBSERVE_SWEEP_EVERY_FLUSHES}. */
  sweepEveryFlushes?: number;
  /** Keys one sweep deletes at most. Defaults to {@link OBSERVE_SWEEP_MAX_DELETES}. */
  sweepMaxDeletes?: number;
  /** Where a failure is reported. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/** Builds a flusher; registry clock timestamps both record and key. */
export function createObserveFlusher(
  registry: RegistryContext,
  opts: ObserveFlusherOptions,
): ObserveFlusher {
  const store: CasStore = registry.store;
  const codec = opts.codec ?? PARQUET_CODEC;
  const intervalMs = opts.intervalMs ?? OBSERVE_FLUSH_INTERVAL_MS;
  const drainIntervalMs = opts.drainIntervalMs ?? OBSERVE_DRAIN_INTERVAL_MS;
  const maxRecords = Math.max(1, opts.maxRecords ?? OBSERVE_FLUSH_MAX_RECORDS);
  const pendingMax = Math.max(1, opts.pendingMax ?? OBSERVE_PENDING_MAX_RECORDS);
  const retentionDays = Math.max(0, opts.retentionDays ?? OBSERVE_RETENTION_DAYS);
  const sweepEvery = Math.max(1, opts.sweepEveryFlushes ?? OBSERVE_SWEEP_EVERY_FLUSHES);
  const sweepMax = Math.max(1, opts.sweepMaxDeletes ?? OBSERVE_SWEEP_MAX_DELETES);
  const log = opts.log ?? ((message: string): void => console.error(message));

  /* Retry events only; headers and counters are recreated each attempt. */
  let pending: ObserveEventRecord[] = [];
  let ringDropped = 0;
  let pendingDropped = 0;
  let totalRingDropped = 0;
  let totalPendingDropped = 0;
  /* Separate sequence prevents same-millisecond key collisions. */
  let writes = 0;
  let flushes = 0;
  let swept = 0;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let lastFlushAt: string | null = null;
  let lastFailure: string | null = null;
  /* Avoid writing unchanged idle counter snapshots. */
  let lastCounters: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const drain = (): void => {
    const drained = opts.observability.drain();
    ringDropped += drained.dropped;
    totalRingDropped += drained.dropped;

    for (const event of drained.events) {
      pending.push({
        v: OBSERVE_RECORD_VERSION,
        record: "event",
        node: opts.nodeId,
        ...event,
      } as ObserveEventRecord);
    }
    /* Retain the most recent correlatable events. */
    if (pending.length > pendingMax) {
      const lost = pending.length - pendingMax;
      pending = pending.slice(lost);
      pendingDropped += lost;
      totalPendingDropped += lost;
    }
  };

  const sweep = async (): Promise<string[]> => {
    const cutoffMs = nowDate(registry).getTime() - retentionDays * DAY_MS;
    const deleted: string[] = [];

    try {
      /* Recheck node prefix even if the store returns unexpected keys. */
      for (const key of await store.list(observeNodePrefix(opts.nodeId))) {
        if (deleted.length >= sweepMax) break;

        const parts = parseObserveKey(key);
        if (parts === null || parts.node !== opts.nodeId || parts.atMs >= cutoffMs) continue;

        await store.del(key);
        deleted.push(key);
      }
      swept += deleted.length;
    } catch (error) {
      /* Retention failure is logged; the next sweep retries. */
      log(`scafo: observation sweep for node "${opts.nodeId}" failed (${describe(error)})`);
    }
    return deleted;
  };

  const flush = async (): Promise<boolean> => {
    lastAttemptMs = nowDate(registry).getTime();
    drain();

    const at = nowDate(registry);
    const snapshot = opts.counters?.snapshot();
    const counters: ObserveCountersRecord[] = (snapshot?.buckets ?? []).map((bucket) => ({
      v: OBSERVE_RECORD_VERSION,
      record: "counters",
      node: opts.nodeId,
      at: at.toISOString(),
      since: snapshot?.since ?? at.toISOString(),
      project: bucket.project,
      env: bucket.env,
      requests: bucket.requests,
      bytes: bucket.bytes,
      status: { ...bucket.status },
      durations: [...bucket.durations],
    }));

    /* Nothing new to say: no events, nothing lost, and counters that have not
       moved since the last flush. Writing it anyway would put an object an hour
       in the bucket for every node that is simply idle, and every one of them
       would difference to zero. */
    const stated = snapshot === undefined ? null : stableStringify(counters.map(countersShape));
    if (
      pending.length === 0 &&
      ringDropped === 0 &&
      pendingDropped === 0 &&
      (stated === null || stated === lastCounters)
    ) {
      return false;
    }

    const header: ObserveFlushRecord = {
      v: OBSERVE_RECORD_VERSION,
      record: "flush",
      node: opts.nodeId,
      at: at.toISOString(),
      events: pending.length,
      counters: counters.length,
      ringDropped,
      pendingDropped,
      ...(snapshot === undefined
        ? {}
        : {
            lines: snapshot.lines,
            malformed: snapshot.malformed,
            unattributed: snapshot.unattributed,
          }),
    };
    const records: ObserveRecord[] = [header, ...pending, ...counters];

    writes++;
    try {
      const encoded = codec.encode(records);
      /* Persist binary codec output verbatim. */
      await store.put(observeKey(opts.nodeId, at, writes, encoded.extension), encoded.bytes);
    } catch (error) {
      const failure = describe(error);
      /* Log failure and recovery once per state transition. */
      if (lastFailure === null) {
        log(
          `scafo: observations could not be written (${failure}); ${String(pending.length)} ` +
            `record(s) are held for the next attempt`,
        );
      }
      lastFailure = failure;
      return false;
    }

    if (lastFailure !== null) log(`scafo: observations are being written again`);
    lastFailure = null;
    lastFlushAt = header.at;
    lastCounters = stated;
    pending = [];
    ringDropped = 0;
    pendingDropped = 0;
    flushes++;

    /* Sweep only after successful writes; the initial flush sweeps immediately. */
    if ((flushes - 1) % sweepEvery === 0) await sweep();
    return true;
  };

  const tick = async (): Promise<void> => {
    /* Single flight prevents duplicate pending records under distinct keys. */
    if (inFlight) return;
    inFlight = true;

    try {
      drain();
      const due = nowDate(registry).getTime() - lastAttemptMs >= intervalMs;
      if (due || pending.length >= maxRecords) await flush();
    } finally {
      inFlight = false;
    }
  };

  return {
    tick,
    sweep,

    async flush(): Promise<boolean> {
      if (inFlight) return false;
      inFlight = true;
      try {
        return await flush();
      } finally {
        inFlight = false;
      }
    },

    status(): ObserveFlushStatus {
      return {
        flushes,
        pending: pending.length,
        ringDropped: totalRingDropped,
        pendingDropped: totalPendingDropped,
        lastFlushAt,
        lastFailure,
        swept,
      };
    },

    start(): void {
      if (timer !== null) return;
      /* Start flush cadence after one full interval. */
      lastAttemptMs = nowDate(registry).getTime();

      timer = setInterval(() => void tick(), drainIntervalMs);
      /* Timers must not keep the process alive. */
      const handle = timer as { unref?: () => void };
      handle.unref?.();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

/* ------------------------------------------------------------------ internal */

/** Counter fields comparable across flush timestamps. */
function countersShape(record: ObserveCountersRecord): unknown {
  return {
    since: record.since,
    project: record.project,
    env: record.env,
    requests: record.requests,
    bytes: record.bytes,
    status: record.status,
    durations: record.durations,
  };
}

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
