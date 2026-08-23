/*
 * What a node writes about itself, and the ONE seam its bytes are produced and
 * read back through.
 *
 * ONE FILE PER FLUSH, THREE RECORD KINDS IN IT. A flush is one object in the
 * bucket carrying a `flush` header, one `event` per thing the agent observed,
 * and one `counters` per {project, environment} the ingress served. They share a
 * file rather than sitting at sibling keys because a flush is one decision and
 * has to land as one write: a bucket charges per request, and two objects per
 * flush can land half of themselves — leaving a window in which a node's events
 * exist and its counters do not, which is exactly the disagreement a reader
 * cannot recover from. Every record therefore carries a `record` discriminant,
 * and a reader filters on it. It is not called `kind` or `type` because an EVENT
 * already carries both — `type` is the event's own, and `kind` is what a
 * `wake.admitted` calls the thing its Host resolved to — and a discriminant that
 * collided with either would be a record shape that cannot be written down.
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
 * key. Swapping JSON-LINES for a columnar encoding is therefore one object plus
 * its extension, and nothing else moves — which is what the Parquet codec next
 * door (`src/agent/observe-parquet.ts`) is. The INTERFACE and the registry that
 * names the implementations live here; a codec dense enough to need its own
 * header comment lives in its own file and is named by {@link observeCodecFor}.
 */

import { assertNodeId } from "../core/registry/paths.ts";
import type { StatusClassCounts } from "./access-counters.ts";
import type { ObservedEvent } from "./observe.ts";

/** Version every record carries, so a reader can tell an old file from a new shape. */
export const OBSERVE_RECORD_VERSION: number = 1;

/** Extension the JSON-LINES codec files its objects under. */
export const OBSERVE_JSONL_EXTENSION: string = "jsonl";

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
 * One thing the agent observed, exactly as the ring held it, with the node that
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
  /** Lines that were not a record. Skipped and counted, never thrown over. */
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
 * JSON-LINES: one record per line, no framing, no header.
 *
 * Chosen because it needs nothing to read it — `JSON.parse` per line, or
 * DuckDB's `read_json_auto` straight off the bucket — and because a truncated
 * file loses its last line rather than all of them.
 */
export const JSONL_CODEC: ObserveCodec = {
  extension: OBSERVE_JSONL_EXTENSION,

  encode(records: ObserveRecord[]): ObserveEncoded {
    const text = records.map((record) => JSON.stringify(record)).join("\n");
    return {
      /* Trailing newline: a file that is appended to or concatenated with
         another must not merge its last record into the next one's first. */
      bytes: new TextEncoder().encode(records.length === 0 ? "" : `${text}\n`),
      extension: OBSERVE_JSONL_EXTENSION,
    };
  },

  decode(bytes: Uint8Array): ObserveDecoded {
    const records: ObserveRecord[] = [];
    let malformed = 0;

    for (const line of new TextDecoder().decode(bytes).split("\n")) {
      /* Blank lines are framing rather than data: the trailing newline above
         makes one at the end of every file. */
      if (line.trim() === "") continue;

      const record = readRecord(line);
      if (record === null) malformed++;
      else records.push(record);
    }
    return { records, malformed };
  },
};

/**
 * The codec that READS an extension, or null when nothing here does.
 *
 * A codec that can only write is deliberately not named here. `PARQUET_CODEC`
 * (`src/agent/observe-parquet.ts`) writes files this build cannot read back, and
 * answering it from a lookup a READER calls would turn "a file I cannot read"
 * into a thrown command — so `.parquet` keys stay unrecognized until the reader
 * that handles them lands, and a reader counts and skips them exactly as it does
 * any encoding a newer agent invented.
 */
export function observeCodecFor(extension: string): ObserveCodec | null {
  return extension === JSONL_CODEC.extension ? JSONL_CODEC : null;
}

/**
 * The store body an encoding lands in, and the inverse.
 *
 * THE ONE PLACE THE BYTES MEET THE STORE, which is why it is a function rather
 * than a `decode` at the call site. `CasStore` bodies are text OR bytes, and this
 * hands it whichever the encoding actually produced: a UTF-8 encoding — JSON-LINES
 * — goes as the string it already is, and a columnar one goes as bytes, because a
 * Parquet file put through a `TextDecoder` comes back out full of replacement
 * characters and is no longer a Parquet file.
 *
 * The test is the bytes themselves rather than a flag a codec sets, so it cannot
 * be wrong in either direction: a STRICT decode succeeds exactly when the bytes
 * are valid UTF-8, and bytes that are valid UTF-8 re-encode to themselves.
 */
export function observeBody(encoded: ObserveEncoded): string | Uint8Array {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes);
  } catch {
    return encoded.bytes;
  }
}

/** Inverse of {@link observeBody}: a stored body as the bytes a codec decodes. */
export function observeBytes(body: string): Uint8Array {
  return new TextEncoder().encode(body);
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

/* ------------------------------------------------------------------ internal */

/**
 * One line read as a record, or null when it is not one.
 *
 * Deliberately shallow: the discriminant, the node and the timestamp are what every
 * reader here dispatches on, so those are checked and everything else is taken
 * as written. A stricter reader would reject records a later version of the
 * agent added a field to, which is the opposite of what a log format is for.
 */
function readRecord(line: string): ObserveRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Partial<ObserveRecord>;
  if (typeof record.at !== "string" || typeof record.node !== "string") return null;
  if (Number.isNaN(Date.parse(record.at))) return null;
  try {
    assertNodeId(record.node);
  } catch {
    return null;
  }

  switch (record.record) {
    case "flush":
    case "event":
    case "counters": {
      return record as ObserveRecord;
    }
    default: {
      return null;
    }
  }
}
