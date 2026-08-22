/*
 * What takes a node's own observations off the ring and puts them in the bucket,
 * and what takes them out again when they are old enough.
 *
 * ONE OWNER, ONE DRAIN. The flusher is the only caller of
 * {@link Observability.drain}: it moves the ring's high-water mark, so a second
 * one would take half the events and neither would know it. The agent builds
 * exactly one, and only while `observability.enabled` is on.
 *
 * WHAT A FLUSH IS: everything drained since the last one, plus a fresh snapshot
 * of the ingress counters when this node counts any, encoded through the codec
 * seam (`src/agent/observe-records.ts`) and written as ONE plain put at
 * `_scafo/observe/<node>/<YYYY>/<MM>/<DD>/<HH>/<epochMs>-<seq>.<ext>`. Plain,
 * because a flush is this node's own account of its own past: nothing else
 * writes that key, so there is nothing to serialize against.
 *
 * A FAILED FLUSH LOSES NOTHING IT CAN KEEP. The drained events stay in a pending
 * buffer and go out with the next attempt, at the flush cadence rather than at
 * the drain one — a bucket that is down must not be retried every few seconds.
 * The buffer is BOUNDED ({@link OBSERVE_PENDING_MAX_RECORDS}): past it the oldest
 * records are dropped and counted, because a node whose bucket never comes back
 * must not fill its memory with what it cannot write. The counters are NOT kept
 * across a failure — they are monotonic totals, so the next snapshot supersedes
 * the lost one entirely and only the sample resolution is gone.
 *
 * RETENTION IS THIS NODE'S OWN PREFIX AND NOTHING ELSE. Every so many flushes
 * ({@link OBSERVE_SWEEP_EVERY_FLUSHES}) the sweep lists `_scafo/observe/<node>/`,
 * deletes what is older than {@link OBSERVE_RETENTION_DAYS}, and stops at
 * {@link OBSERVE_SWEEP_MAX_DELETES} — the rest goes next sweep. It never lists or
 * deletes outside its own node segment, so a node cannot take another's history
 * with it, and the listing is what the slow cadence is for: it is one paginated
 * listing of everything that node has kept.
 */

import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { observeKey, observeNodePrefix, parseObserveKey } from "../core/registry/paths.ts";
import type { CasStore } from "../core/types/store.ts";
import { isScafoError } from "../core/error.ts";
import { stableStringify } from "../core/utils/json.ts";
import type { IngressCounters } from "./access-counters.ts";
import type { Observability } from "./observe.ts";
import {
  JSONL_CODEC,
  observeBody,
  type ObserveCodec,
  type ObserveCountersRecord,
  type ObserveEventRecord,
  type ObserveFlushRecord,
  type ObserveRecord,
  OBSERVE_RECORD_VERSION,
} from "./observe-records.ts";

/** Time between flushes, when nothing else has already triggered one. */
export const OBSERVE_FLUSH_INTERVAL_MS: number = 60_000;

/**
 * Time between drains of the ring.
 *
 * Shorter than the flush interval on purpose, and it is not a second cadence:
 * the ring holds a fixed number of events, and a node that emitted more than
 * that between two flushes would drop the difference. Draining often keeps the
 * ring empty and the pending buffer — which is bounded far higher — is where the
 * events wait. It is also what makes the size trigger below timely.
 */
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

/** Where a node's observations go, and what takes the old ones away. */
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
  /** Stops the cadence. Anything pending stays pending; {@link ObserveFlusher.flush} still writes it. */
  stop(): void;
}

export interface ObserveFlusherOptions {
  /** Node whose segment of the keyspace this writes and sweeps, and nothing else. */
  nodeId: string;
  /** The seam being drained. A disabled one is legal and simply yields nothing. */
  observability: Observability;
  /** What the ingress served, when this node counts it at all. */
  counters?: IngressCounters;
  /** How records become bytes. Defaults to {@link JSONL_CODEC}. */
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

/**
 * Builds the flusher. Nothing is written until {@link ObserveFlusher.start} is
 * called or {@link ObserveFlusher.flush} is awaited.
 *
 * The clock is the registry's, so the key a flush lands at and the `at` inside
 * it can never come from two different ones.
 */
export function createObserveFlusher(
  registry: RegistryContext,
  opts: ObserveFlusherOptions,
): ObserveFlusher {
  const store: CasStore = registry.store;
  const codec = opts.codec ?? JSONL_CODEC;
  const intervalMs = opts.intervalMs ?? OBSERVE_FLUSH_INTERVAL_MS;
  const drainIntervalMs = opts.drainIntervalMs ?? OBSERVE_DRAIN_INTERVAL_MS;
  const maxRecords = Math.max(1, opts.maxRecords ?? OBSERVE_FLUSH_MAX_RECORDS);
  const pendingMax = Math.max(1, opts.pendingMax ?? OBSERVE_PENDING_MAX_RECORDS);
  const retentionDays = Math.max(0, opts.retentionDays ?? OBSERVE_RETENTION_DAYS);
  const sweepEvery = Math.max(1, opts.sweepEveryFlushes ?? OBSERVE_SWEEP_EVERY_FLUSHES);
  const sweepMax = Math.max(1, opts.sweepMaxDeletes ?? OBSERVE_SWEEP_MAX_DELETES);
  const log = opts.log ?? ((message: string): void => console.error(message));

  /* Only ever event records: the flush header and the counters are built at
     write time, and a failed attempt discards both rather than retrying them. */
  let pending: ObserveEventRecord[] = [];
  let ringDropped = 0;
  let pendingDropped = 0;
  let totalRingDropped = 0;
  let totalPendingDropped = 0;
  /* Counted apart from the flushes that landed, so two attempts in the same
     millisecond can never be handed the same key. */
  let writes = 0;
  let flushes = 0;
  let swept = 0;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let lastFlushAt: string | null = null;
  let lastFailure: string | null = null;
  /* What the counters last said, so an idle node stops writing identical
     snapshots once a minute forever. */
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
    /* The oldest go first: what is still in the buffer is what a reader has the
       best chance of correlating with something else that is still around. */
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
      /* Listed under this node's own segment, and every key checked again
         against it: a sweep must not be able to reach another node's history
         even if a store answered a listing it was not asked for. */
      for (const key of await store.list(observeNodePrefix(opts.nodeId))) {
        if (deleted.length >= sweepMax) break;

        const parts = parseObserveKey(key);
        if (parts === null || parts.node !== opts.nodeId || parts.atMs >= cutoffMs) continue;

        await store.del(key);
        deleted.push(key);
      }
      swept += deleted.length;
    } catch (error) {
      /* Reported and dropped: retention is housekeeping, and a sweep that could
         not run costs disk rather than correctness. The next one tries again. */
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
      await store.put(observeKey(opts.nodeId, at, writes, encoded.extension), observeBody(encoded));
    } catch (error) {
      const failure = describe(error);
      /* Said when the state CHANGES rather than on every attempt: a bucket that
         is gone would otherwise print a line a minute for as long as it is. */
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

    /* After the write rather than before it: a node that cannot write must not
       spend its round trips deleting either, and the first flush sweeps so a
       node coming back from a long stop cleans up without waiting an hour. */
    if ((flushes - 1) % sweepEvery === 0) await sweep();
    return true;
  };

  const tick = async (): Promise<void> => {
    /* Never overlapping: a slow bucket would otherwise have two attempts writing
       the same pending records under two keys. */
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
      /* Counted from the start rather than from the epoch, so the first flush is
         one interval in rather than on the first tick. */
      lastAttemptMs = nowDate(registry).getTime();

      timer = setInterval(() => void tick(), drainIntervalMs);
      /* The loop must never be the reason the process stays alive. */
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

/**
 * What makes two counter snapshots comparable: everything but the moment they
 * were taken. `at` moves on every flush; the rest only moves when the ingress
 * served something, which is the whole question an idle node is asking.
 */
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
