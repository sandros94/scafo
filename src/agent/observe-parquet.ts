/*
 * The COLUMNAR encoding of what a node writes about itself: one wide flat table
 * per flush, written with `tavolato` and queried where it lands.
 *
 * ONE WIDE TABLE, NOT THREE. The three record kinds share a file (see
 * `src/agent/observe-records.ts`), and Parquet has one schema per file — so they
 * share a SCHEMA too: every field of every kind is a column, every column but the
 * four each record carries is NULLABLE, and the `record` discriminant is what a
 * query filters on exactly as it filters a JSON-LINES read. A flush of one
 * header, forty events and three counter snapshots is one file with 44 rows and a
 * great many nulls, which is what a columnar format is cheap at: a null column
 * chunk is a definition-level bitmap and nothing else.
 *
 * FLAT, BECAUSE THE WRITER IS. `tavolato` writes named columns of `string`,
 * `f64`, `i64`, `bool` and `timestamp` and will never write a nested one — that
 * is its scope freeze rather than a gap — so the two nested fields are flattened
 * by hand and named after their path: a counters record's `status` object becomes
 * `status_2xx`…`status_other`, and its `durations` array becomes one column per
 * band, named after the band's own boundary. Nothing else nests, so nothing else
 * needs a JSON escape hatch.
 *
 * THE UNION IS CLOSED AND THE BUILD PROVES IT. {@link COLUMN_OF} is a `Record`
 * over the record union's own keys, so a field added to any record kind — a new
 * `ObservedEvent` variant, or one more field on an existing one — is a MISSING
 * PROPERTY there and the build stops. A field silently dropped at flush time is
 * the one failure a telemetry encoder must not have.
 *
 * WRITE-ONLY, ON PURPOSE. `tavolato` is a writer and never a reader, so
 * {@link PARQUET_CODEC.decode} refuses rather than pretends. Parquet telemetry is
 * queried where the data already is — `read_parquet` off the bucket — and that is
 * the whole answer the refusal carries.
 */

import { createWriter, defineSchema } from "tavolato";
import type { ParquetSchema, SchemaDefinition } from "tavolato";
import { ScafoError } from "../core/error.ts";
import { observePrefix } from "../core/registry/paths.ts";
import { DURATION_BANDS_MS, type StatusClassCounts } from "./access-counters.ts";
import type {
  ObserveCodec,
  ObserveDecoded,
  ObserveEncoded,
  ObserveRecord,
} from "./observe-records.ts";

/** Extension the Parquet codec files its objects under. */
export const OBSERVE_PARQUET_EXTENSION: string = "parquet";

/** What the footer's `created_by` says, so a reader knows both halves of the stack. */
export const OBSERVE_PARQUET_CREATED_BY: string = "scafo (tavolato)";

/**
 * The columns every record carries a value for, and every column that only one
 * record kind does.
 *
 * ORDER IS THE FILE'S COLUMN ORDER, and it is grouped by record kind so a
 * `DESCRIBE` reads like the record union does: what everything carries, then the
 * flush header's, then an event's, then a counter snapshot's. The two shared
 * names sit with the kind that reaches them first — `project` and `env` are a
 * `wake.admitted`'s and a counters record's alike.
 *
 * `status` is an i64 and NOT the counters object: an event's `status` is the HTTP
 * status a `wake.served` answered with, while a counters record's is the five
 * class totals, which flatten into the `status_*` columns below. Two fields, one
 * name in the record union, two columns here — see {@link COLUMN_OF}.
 */
const FIXED_COLUMNS = {
  /* Every record. */
  v: { type: "i64" },
  record: { type: "string" },
  node: { type: "string" },
  at: { type: "timestamp" },

  /* ObserveFlushRecord. */
  events: { type: "i64", optional: true },
  counters: { type: "i64", optional: true },
  ringDropped: { type: "i64", optional: true },
  pendingDropped: { type: "i64", optional: true },
  lines: { type: "i64", optional: true },
  malformed: { type: "i64", optional: true },
  unattributed: { type: "i64", optional: true },

  /* ObserveEventRecord: the flattened ObservedEvent union. */
  type: { type: "string", optional: true },
  id: { type: "string", optional: true },
  host: { type: "string", optional: true },
  kind: { type: "string", optional: true },
  project: { type: "string", optional: true },
  env: { type: "string", optional: true },
  build: { type: "string", optional: true },
  inFlight: { type: "i64", optional: true },
  storeOps: { type: "i64", optional: true },
  listOps: { type: "i64", optional: true },
  port: { type: "i64", optional: true },
  status: { type: "i64", optional: true },
  reason: { type: "string", optional: true },
  kicked: { type: "bool", optional: true },
  actions: { type: "i64", optional: true },
  failures: { type: "i64", optional: true },
  durationMs: { type: "i64", optional: true },
  processId: { type: "string", optional: true },
  attempts: { type: "i64", optional: true },

  /* ObserveCountersRecord, `status` and `durations` excepted. */
  since: { type: "timestamp", optional: true },
  requests: { type: "i64", optional: true },
  bytes: { type: "i64", optional: true },
  status_2xx: { type: "i64", optional: true },
  status_3xx: { type: "i64", optional: true },
  status_4xx: { type: "i64", optional: true },
  status_5xx: { type: "i64", optional: true },
  status_other: { type: "i64", optional: true },
} as const satisfies SchemaDefinition;

/**
 * A column of the wide table that is not one of the duration bands.
 *
 * Not exported: the column list a reader wants is
 * {@link OBSERVE_PARQUET_SCHEMA}`.columns`, which carries the types and the
 * nullability too, and is the same list a file declares.
 */
type ObserveParquetColumn = keyof typeof FIXED_COLUMNS;

/**
 * The column one duration band lands in, named after the band's own boundary in
 * milliseconds — `durations_le_10ms` through `durations_le_3000ms`, and
 * `durations_gt_3000ms` for everything past the last one.
 *
 * The SAME semantics the JSON-LINES `durations` array carries, spelled out
 * instead of positional: index `i` counts the requests that did not exceed
 * `DURATION_BANDS_MS[i]`, and the extra index past the end counts the rest. It is
 * derived from that constant rather than written down beside it, so a band added
 * to the fleet's histogram adds a column here and cannot drift from it. It is the
 * SQL-safe spelling of `bandLabel` in `src/cli/_metrics.ts`, which says the same
 * thing to a human (`<=10ms`, `>3s`).
 */
export function durationBandColumn(index: number): string {
  const bound = DURATION_BANDS_MS[index];
  return bound === undefined
    ? `durations_gt_${String(DURATION_BANDS_MS.at(-1) ?? 0)}ms`
    : `durations_le_${String(bound)}ms`;
}

/** One column per duration band, plus the one past the last boundary. */
const DURATION_COLUMNS: SchemaDefinition = Object.fromEntries(
  Array.from({ length: DURATION_BANDS_MS.length + 1 }, (_, index) => [
    durationBandColumn(index),
    { type: "i64", optional: true },
  ]),
);

/**
 * The one schema every flushed Parquet file declares.
 *
 * Exported because it is the contract: a reader wanting the column list asks this
 * rather than a file, and a test pins the names and types against it.
 */
export const OBSERVE_PARQUET_SCHEMA: ParquetSchema = defineSchema({
  ...FIXED_COLUMNS,
  ...DURATION_COLUMNS,
});

/** One record as the wide row it becomes: the columns it has a value for, and no others. */
export type ObserveParquetRow = Record<string, string | number | boolean>;

/**
 * Every field the record union can carry, and the column it lands in.
 *
 * Written as a `Record` over the union's OWN KEYS so the build proves the schema
 * covers it: a field added to any record kind is a missing property here, and a
 * column added without a field is a key that does not exist. {@link SPREAD} marks
 * the two that do not land in one column of their own — see {@link putField}.
 */
const SPREAD = null;

const COLUMN_OF: Record<ObserveField, ObserveParquetColumn | typeof SPREAD> = {
  /* Every record. */
  v: "v",
  record: "record",
  node: "node",
  at: "at",

  /* ObserveFlushRecord. */
  events: "events",
  counters: "counters",
  ringDropped: "ringDropped",
  pendingDropped: "pendingDropped",
  lines: "lines",
  malformed: "malformed",
  unattributed: "unattributed",

  /* ObserveEventRecord. */
  type: "type",
  id: "id",
  host: "host",
  kind: "kind",
  project: "project",
  env: "env",
  build: "build",
  inFlight: "inFlight",
  storeOps: "storeOps",
  listOps: "listOps",
  port: "port",
  reason: "reason",
  kicked: "kicked",
  actions: "actions",
  failures: "failures",
  durationMs: "durationMs",
  processId: "processId",
  attempts: "attempts",

  /* ObserveCountersRecord. */
  since: "since",
  requests: "requests",
  bytes: "bytes",

  /* One name, two fields: an event's HTTP status keeps the `status` column, and a
     counters record's class object flattens into the five `status_*` ones. */
  status: SPREAD,
  /* One array, one column per band. */
  durations: SPREAD,
};

/**
 * One record as a row of the wide table.
 *
 * A column the record says nothing about is ABSENT rather than zero, which
 * `tavolato` writes as a real Parquet null: a `requests` of 0 and a record that
 * counts no requests at all are different answers, and a reader that could not
 * tell them apart would report an idle environment as a busy one serving nothing.
 *
 * @throws {ScafoError} `invalid-input` when a timestamp is not an instant, which
 * is a record that cannot be written down rather than one worth guessing at.
 */
export function observeParquetRow(record: ObserveRecord): ObserveParquetRow {
  const row: ObserveParquetRow = {};
  for (const [field, value] of Object.entries(record)) {
    /* Absent and null are the same answer, and a field this build does not know
       is a newer agent's: the schema is this build's, and a column nobody
       declared cannot be written. */
    if (value === undefined || value === null) continue;
    if (!Object.hasOwn(COLUMN_OF, field)) continue;

    putField(row, field as ObserveField, value);
  }
  return row;
}

/**
 * The one line that says how a Parquet flush is read, given the prefix to read
 * under. Said by the codec's refusal below, and by whatever tells an operator
 * what their node is writing.
 */
export function parquetReadHint(prefix: string): string {
  return `query them with DuckDB: read_parquet('s3://<bucket>/${prefix}**/*.parquet')`;
}

/** {@link parquetReadHint} for no node in particular, which is what a refusal can say. */
export const OBSERVE_PARQUET_READ_HINT: string = parquetReadHint(`${observePrefix()}<node>/`);

/**
 * JSON-LINES' counterpart in a columnar encoding: one wide flat table per flush.
 *
 * WRITE-ONLY BY DESIGN. `tavolato`'s scope freeze is that it writes Parquet and
 * never reads it, so {@link ObserveCodec.decode} refuses and says where the data
 * IS read. A flat-schema reader is landing in a later `tavolato`, and it replaces
 * the refusal below — the CLI decodes these files itself from then on, and this
 * comment is the marker for that change.
 */
export const PARQUET_CODEC: ObserveCodec = {
  extension: OBSERVE_PARQUET_EXTENSION,

  encode(records: ObserveRecord[]): ObserveEncoded {
    const writer = createWriter(OBSERVE_PARQUET_SCHEMA, { createdBy: OBSERVE_PARQUET_CREATED_BY });
    /* A flush of nothing still writes a whole file: schema present, no row
       groups, `num_rows = 0` — which reads as an empty table rather than as a
       truncated one. */
    for (const record of records) writer.append(observeParquetRow(record));
    return { bytes: writer.finish(), extension: OBSERVE_PARQUET_EXTENSION };
  },

  decode(): ObserveDecoded {
    throw new ScafoError("capability-missing", "Parquet observations are not read here", {
      detail:
        `the writer behind them reads nothing back, by design. Parquet telemetry is queried ` +
        `where it already is: ${OBSERVE_PARQUET_READ_HINT}`,
    });
  },
};

/* ------------------------------------------------------------------ internal */

/** Distributes over a union, so each member keeps its own keys. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Every field name any record kind can carry. */
type ObserveField = KeysOfUnion<ObserveRecord>;

/** Columns whose value is an ISO-8601 instant in the record and an epoch in the file. */
const INSTANTS = new Set<ObserveParquetColumn>(["at", "since"]);

/** Writes one field into the row, flattening the two that do not fit one column. */
function putField(row: ObserveParquetRow, field: ObserveField, value: unknown): void {
  const column = COLUMN_OF[field];
  if (column !== SPREAD) {
    row[column] = INSTANTS.has(column)
      ? instant(column, value)
      : (value as string | number | boolean);
    return;
  }

  if (field === "durations") {
    (value as number[]).forEach((count, index) => {
      row[durationBandColumn(index)] = count;
    });
    return;
  }

  /* The event's own HTTP status is a number and keeps the bare column; the
     counters record's is the class object and spreads across five. */
  if (typeof value === "number") {
    row.status = value;
    return;
  }
  for (const [name, count] of Object.entries(value as StatusClassCounts)) {
    row[`status_${name}`] = count;
  }
}

/** An ISO-8601 instant as the epoch milliseconds a `timestamp` column takes. */
function instant(column: string, value: unknown): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new ScafoError("invalid-input", "Unwritable observation record", {
      detail: `"${column}" is ${JSON.stringify(value)}, which is not an ISO-8601 instant`,
    });
  }
  return ms;
}
