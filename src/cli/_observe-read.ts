/* Reads persisted observations directly from the bucket. File timestamps narrow
   reads with lower slack; record timestamps enforce the exact window. */

import { observePrefix, parseObserveKey } from "../core/registry/paths.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { ScafoError } from "../core/error.ts";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "../core/utils/concurrency.ts";
import { type ObserveRecord, observeCodecFor } from "../daemon/observe-records.ts";

/** Lower key-timestamp slack; records are filtered against the exact window. */
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
  /** Unsupported-codec or invalid-encoding files, reported but skipped. */
  unreadable: string[];
}

export interface ObserveReadOptions {
  window: ObserveWindow;
  /** Nodes to read; every node that has written anything when absent. */
  nodes?: string[];
  /** Files read at once. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
}

/** Reads window observations ordered by record time then node. */
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
        /* One unreadable file must not fail the window. */
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

/** Parses `--since` as duration or ISO instant; invalid input is refused. */
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
