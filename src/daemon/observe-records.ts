/*
 * What a node writes about itself, and the ONE seam its bytes are produced and
 * read back through.
 *
 * ONE FILE PER FLUSH, THREE RECORD KINDS IN IT. A flush is one object in the
 * bucket carrying a `flush` header, one `event` per thing the daemon observed,
 * and one `counters` per {project, environment} the ingress served. They share a
 * file rather than sitting at sibling keys because a flush is one decision and
 * has to land as one write: a bucket charges per request, and two objects per
 * flush can land half of themselves — leaving a window in which a node's events
 * exist and its counters do not, which is exactly the disagreement a reader
 * cannot recover from. Every record therefore carries a `record` discriminant,
 * and a reader filters on it. It is not called `type` because an EVENT already
 * carries its own `type`, and a discriminant that collided with it would be a
 * record shape that cannot be written down.
 *
 * COUNTER RECORDS ARE MONOTONIC TOTALS, NOT WINDOWS. They are the counters as
 * they stood at the flush, counted since {@link ObserveCountersRecord.since} —
 * the moment that node's adapter was made, which is that node's boot. A window
 * is DERIVED AT READ TIME by subtracting two snapshots of the same node, the
 * same {project, env} and the same `since`; a `since` that changed means the
 * node restarted and its totals went back to zero, so the later run's snapshot
 * is taken whole rather than subtracted from anything.
 *
 * THE CODEC IS THE SEAM AND IT IS THE ONLY ONE. Nothing outside this seam knows
 * how a record becomes bytes: the flusher hands records to
 * {@link ObserveCodec.encode} and puts what comes back at the key its
 * `extension` names, and a reader picks a codec by the extension it read off the
 * key. Swapping the encoding is therefore one object plus its extension, and
 * nothing else moves. The INTERFACE and the registry that names the
 * implementations live here; the one implementation is dense enough to need its
 * own header comment and lives next door (`src/daemon/observe-parquet.ts`), named
 * from {@link observeCodecFor}.
 */

import { PARQUET_CODEC } from "./observe-parquet.ts";
import type { StatusClassCounts } from "./access-counters.ts";
import type { ObservedEvent } from "./observe.ts";

/** Version every record carries, so a reader can tell an old file from a new shape. */
export const OBSERVE_RECORD_VERSION: number = 1;

/**
 * The header of one flush: what the file carries, and what was lost getting it
 * here. Exactly one per file, and it is the only record that reports a LOSS —
 * both counters are since the previous flush, so a reader adds them up over a
 * window rather than differencing them.
 */
export interface ObserveFlushRecord {
  v: number;
  record: "flush";
  node: string;
  /** When the flush was written, from the node's own clock. */
  at: string;
  /** Event records in this file. */
  events: number;
  /** Counter records in this file: one per {project, environment}. */
  counters: number;
  /** Events the ring dropped before the flusher could drain them. */
  ringDropped: number;
  /** Records dropped from the pending buffer while flushes were failing. */
  pendingDropped: number;
  /** Access-log lines read since `since`; absent on a node counting nothing. */
  lines?: number;
  /** Lines no format could be read out of, since `since`. */
  malformed?: number;
  /** Requests whose Host resolved to nothing, since `since`. */
  unattributed?: number;
}

/**
 * One thing the daemon observed, exactly as the ring held it, with the node that
 * saw it. The event is FLATTENED rather than nested so a line is one row: `at`
 * and `type` sit beside `record`, and each variant's own fields beside those.
 */
export type ObserveEventRecord = { v: number; record: "event"; node: string } & ObservedEvent;

/**
 * What one environment had been served on one node, in TOTAL since `since`. See
 * the file header: windows are differences between two of these, never a value
 * read out of one.
 */
export interface ObserveCountersRecord {
  v: number;
  record: "counters";
  node: string;
  /** When the snapshot was taken. */
  at: string;
  /** When this node's counters were made; every total below is from then. */
  since: string;
  project: string;
  env: string;
  requests: number;
  bytes: number;
  status: StatusClassCounts;
  /** One count per duration band, plus one for everything past the last. */
  durations: number[];
}

/** One line of a flushed file. */
export type ObserveRecord = ObserveFlushRecord | ObserveEventRecord | ObserveCountersRecord;

/** Bytes one encoding produced, and the extension they are filed under. */
export interface ObserveEncoded {
  bytes: Uint8Array;
  /** Filename extension, without the dot. */
  extension: string;
}

/** What one file read back into, and what could not be read out of it. */
export interface ObserveDecoded {
  records: ObserveRecord[];
  /** Rows that were not a record. Skipped and counted, never thrown over. */
  malformed: number;
}

/** How records become bytes and bytes become records again. */
export interface ObserveCodec {
  /** Extension the bytes are filed under, and what a reader selects this by. */
  readonly extension: string;
  encode(records: ObserveRecord[]): ObserveEncoded;
  decode(bytes: Uint8Array): ObserveDecoded;
}

/**
 * The codec that reads an extension, or null when nothing here does.
 *
 * A KEY IS WHAT SELECTS AN ENCODING, and this is the whole lookup. Anything else
 * a bucket holds under the observation prefix — an older daemon's encoding, or one
 * a newer daemon invents — answers null here, and a reader counts and skips it
 * rather than failing the whole command over one object.
 */
export function observeCodecFor(extension: string): ObserveCodec | null {
  return extension === PARQUET_CODEC.extension ? PARQUET_CODEC : null;
}

/** The event records of a set, in the order they were read. */
export function eventRecords(records: readonly ObserveRecord[]): ObserveEventRecord[] {
  return records.filter((record): record is ObserveEventRecord => record.record === "event");
}

/** The counter records of a set, in the order they were read. */
export function counterRecords(records: readonly ObserveRecord[]): ObserveCountersRecord[] {
  return records.filter((record): record is ObserveCountersRecord => record.record === "counters");
}

/** The flush headers of a set, in the order they were read. */
export function flushRecords(records: readonly ObserveRecord[]): ObserveFlushRecord[] {
  return records.filter((record): record is ObserveFlushRecord => record.record === "flush");
}
