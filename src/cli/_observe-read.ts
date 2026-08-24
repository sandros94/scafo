/*
 * Internal: reading a fleet's own observations back out of the bucket.
 *
 * STRAIGHT THROUGH THE BUCKET, NEVER THROUGH A NODE. What a node holds in memory
 * is one node's recent past; what is in the bucket is every node's, including the
 * ones that have since been replaced. So `scafo metrics` and `scafo traces` take
 * the same `SCAFO_S3_*` configuration every other registry-reading command does,
 * and no daemon has to be running for them to answer.
 *
 * ONE LISTING, THEN ONLY THE FILES THAT COULD MATTER. The keyspace is calendar
 * ordered under each node, so a key's own timestamp says whether the file can
 * hold anything inside the window — with {@link OBSERVE_READ_SLACK_MS} of slack
 * BELOW it and none above. The slack is one-directional on purpose: a file is
 * written when its records are flushed, so it can be much NEWER than the records
 * in it (a flush that had to be retried carries old events) and is never
 * meaningfully older. Records are then filtered exactly, by their own `at`.
 *
 * NOTHING IN THE WINDOW IS AN ANSWER, NOT A FAILURE. A file whose extension no
 * codec here reads is counted and skipped, so is one whose bytes turn out not to
 * be that encoding at all, a row that is not a record is counted and skipped, and
 * a run that found nothing at all says so in the one way that is actually useful
 * — by naming the switch that would have recorded it.
 *
 * THE OBJECTS ARE READ AS BYTES, because the encoding is columnar. That is what
 * `CasStore.getBytes` is for: `get` applies the UTF-8 decode every record in the
 * registry wants and every observation file would be destroyed by.
 */

import { observePrefix, parseObserveKey } from "../core/registry/paths.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { ScafoError } from "../core/error.ts";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "../core/utils/concurrency.ts";
import { type ObserveRecord, observeCodecFor } from "../daemon/observe-records.ts";

/**
 * How far before the window a file may have been written and still be read.
 *
 * Sized well past the flush interval, because that is the ordinary lag between a
 * record and the file carrying it. It bounds a listing rather than an answer:
 * every record read is checked against the window itself.
 */
export const OBSERVE_READ_SLACK_MS: number = 900_000;

/** Window a reader asks about, in epoch milliseconds. */
export interface ObserveWindow {
  /** Inclusive lower bound. */
  sinceMs: number;
  /** Inclusive upper bound; `now` for the ordinary `--since` case. */
  untilMs: number;
}

/** What one read of the bucket found. */
export interface ObserveReadResult {
  /** Every record inside the window, oldest first. */
  records: ObserveRecord[];
  /** Nodes that had written anything at all, whatever the window says. */
  nodes: string[];
  /** Files read. */
  files: number;
  /** Rows no record could be read out of. Skipped, never thrown over. */
  malformed: number;
  /**
   * Keys nothing here could read: an extension no codec claims, or bytes that
   * were not the encoding the extension promised. A newer daemon's file, or a
   * truncated one — either way it is reported rather than failed over.
   */
  unreadable: string[];
}

export interface ObserveReadOptions {
  window: ObserveWindow;
  /** Nodes to read; every node that has written anything when absent. */
  nodes?: string[];
  /** Files read at once. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
}

/**
 * Reads every observation inside a window.
 *
 * Ordered by the record's OWN timestamp and then by the node that wrote it, so
 * two nodes' accounts of the same second interleave the way they happened rather
 * than the way they were listed.
 */
export async function readObservations(
  registry: RegistryContext,
  opts: ObserveReadOptions,
): Promise<ObserveReadResult> {
  const wanted = opts.nodes === undefined ? null : new Set(opts.nodes);
  const floorMs = opts.window.sinceMs - OBSERVE_READ_SLACK_MS;

  const nodes = new Set<string>();
  const keys: string[] = [];
  const unreadable: string[] = [];

  for (const key of await registry.store.list(observePrefix())) {
    const parts = parseObserveKey(key);
    if (parts === null) continue;

    nodes.add(parts.node);
    if (wanted !== null && !wanted.has(parts.node)) continue;
    if (parts.atMs < floorMs) continue;

    if (observeCodecFor(parts.extension) === null) unreadable.push(key);
    else keys.push(key);
  }

  let malformed = 0;
  const unread: string[] = [];
  const perFile = await mapConcurrent(
    keys,
    opts.concurrency ?? DEFAULT_CONCURRENCY,
    async (key): Promise<ObserveRecord[]> => {
      const parts = parseObserveKey(key);
      const codec = parts === null ? null : observeCodecFor(parts.extension);
      const bytes = await registry.store.getBytes(key);
      if (codec === null || bytes === null) return [];

      let decoded;
      try {
        decoded = codec.decode(bytes);
      } catch {
        /* The extension promised an encoding the bytes are not: a half-written
           object, or one something else put there. One unreadable file must not
           take the whole window with it. */
        unread.push(key);
        return [];
      }
      malformed += decoded.malformed;
      return decoded.records.filter((record) => inWindow(record, opts.window));
    },
  );

  const records = perFile.flat().sort(byTime);
  return {
    records,
    nodes: [...nodes].sort(),
    files: keys.length - unread.length,
    malformed,
    unreadable: [...unreadable, ...unread].sort(),
  };
}

/**
 * What `--since` meant, in epoch milliseconds.
 *
 * Two forms, because the two questions are different: a DURATION back from now
 * (`90s`, `15m`, `1h`, `7d`) is what an operator looking at right now writes,
 * and an ISO-8601 INSTANT is what someone correlating with an incident writes.
 * Absent means {@link DEFAULT_SINCE_MS} back.
 *
 * Throws `ScafoError("invalid-input")` naming both forms rather than guessing: a
 * `--since` that silently fell back to the default would answer a question
 * nobody asked, and read as if the window were empty.
 */
export function parseSince(value: string | undefined, nowMs: number): number {
  if (value === undefined || value === "") return nowMs - DEFAULT_SINCE_MS;

  const duration = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (duration !== null) return nowMs - Number(duration[1]) * DURATION_UNITS_MS[duration[2]];

  const instant = Date.parse(value.trim());
  if (!Number.isNaN(instant)) return instant;

  throw new ScafoError("invalid-input", "Invalid --since", {
    detail:
      `"${value}" is neither a duration back from now (90s, 15m, 1h, 7d) nor an ISO-8601 ` +
      `instant (2026-08-22T09:00:00Z)`,
  });
}

/** How far back a reader looks when it was told nothing. */
export const DEFAULT_SINCE_MS: number = 3_600_000;

/** The window a `--since` and the current moment describe. */
export function windowFrom(since: string | undefined, nowMs: number): ObserveWindow {
  return { sinceMs: parseSince(since, nowMs), untilMs: nowMs };
}

/**
 * What a reader says when the window held nothing.
 *
 * It names the switch rather than the absence, because "no data" has exactly one
 * likely cause and the operator cannot see it from here: a fleet nobody turned
 * observability on for records nothing, and looks identical to a quiet one.
 */
export function nothingRecorded(result: ObserveReadResult, window: ObserveWindow): string {
  const from = new Date(window.sinceMs).toISOString();
  if (result.nodes.length === 0) {
    return (
      `scafo: nothing recorded — no node has ever written to "${observePrefix()}" in this ` +
      `bucket. Is "observability.enabled" on (--observability, SCAFO_OBSERVABILITY=1)?`
    );
  }
  return (
    `scafo: nothing recorded since ${from}, though ${String(result.nodes.length)} node(s) have ` +
    `written before — ${result.nodes.join(", ")}. Widen --since, or check that ` +
    `"observability.enabled" is still on for the nodes serving this traffic`
  );
}

/* ------------------------------------------------------------------ internal */

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function inWindow(record: ObserveRecord, window: ObserveWindow): boolean {
  const at = Date.parse(record.at);
  return at >= window.sinceMs && at <= window.untilMs;
}

function byTime(a: ObserveRecord, b: ObserveRecord): number {
  const difference = Date.parse(a.at) - Date.parse(b.at);
  if (difference !== 0) return difference;
  if (a.node === b.node) return 0;
  return a.node < b.node ? -1 : 1;
}
