/* ZSTD Parquet encoding for observation records. A shared flat nullable schema
   represents all record kinds; closed field mapping keeps read/write aligned. */

import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createWriter, defineSchema, readParquet } from "tavolato";
import type {
  CodecName,
  ParquetFile,
  ParquetSchema,
  ReaderCodec,
  ReadRow,
  SchemaDefinition,
  SyncParquetWriter,
  WriterCodec,
} from "tavolato";
import { ScafoError } from "../core/error.ts";
import { assertNodeId } from "../core/registry/paths.ts";
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

/** The compression stamped into every column chunk of a flush. */
export const OBSERVE_PARQUET_COMPRESSION: CodecName = "ZSTD";

/** Synchronous ZSTD codecs for the synchronous observation codec. */
export const OBSERVE_PARQUET_WRITER_CODEC: WriterCodec = {
  name: OBSERVE_PARQUET_COMPRESSION,
  compress: (page: Uint8Array): Uint8Array => zstdCompressSync(page),
};

export const OBSERVE_PARQUET_READER_CODECS: Partial<Record<CodecName, ReaderCodec>> = {
  [OBSERVE_PARQUET_COMPRESSION]: {
    decompress: (page: Uint8Array): Uint8Array => zstdDecompressSync(page),
  },
};

/**
 * The columns every record carries a value for, and every column that only one
 * record kind does.
 *
 * ORDER IS THE FILE'S COLUMN ORDER, and it is grouped by record kind so a
 * `DESCRIBE` reads like the record union does: what everything carries, then the
 * flush header's, then an event's, then a counter snapshot's. The two shared
 * names sit with the kind that reaches them first — `project` and `env` are an
 * operational event's and a counters record's alike.
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
  project: { type: "string", optional: true },
  env: { type: "string", optional: true },
  storeOps: { type: "i64", optional: true },
  listOps: { type: "i64", optional: true },
  reason: { type: "string", optional: true },
  kicked: { type: "bool", optional: true },
  actions: { type: "i64", optional: true },
  failures: { type: "i64", optional: true },
  durationMs: { type: "i64", optional: true },
  processId: { type: "string", optional: true },
  /* The operator audit pair: who acted, on whom, at what tier. */
  actor: { type: "string", optional: true },
  subject: { type: "string", optional: true },
  role: { type: "string", optional: true },

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

/** SQL-safe column for a duration upper-bound band or final overflow band. */
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

/** Closed record-field mapping. Spread fields flatten into status/band columns. */
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
  project: "project",
  env: "env",
  storeOps: "storeOps",
  listOps: "listOps",
  reason: "reason",
  kicked: "kicked",
  actions: "actions",
  failures: "failures",
  durationMs: "durationMs",
  processId: "processId",
  actor: "actor",
  subject: "subject",
  role: "role",

  /* ObserveCountersRecord. */
  since: "since",
  requests: "requests",
  bytes: "bytes",

  /* The class object flattens into the five `status_*` columns. */
  status: SPREAD,
  /* One array, one column per band. */
  durations: SPREAD,
};

/** Maps one record to nullable columns. Omitted differs from an observed zero. */
export function observeParquetRow(record: ObserveRecord): ObserveParquetRow {
  const row: ObserveParquetRow = {};
  for (const [field, value] of Object.entries(record)) {
    /* Unknown/newer fields and nulls have no declared column in this schema. */
    if (value === undefined || value === null) continue;
    if (!Object.hasOwn(COLUMN_OF, field)) continue;

    putField(row, field as ObserveField, value);
  }
  return row;
}

/** Returns a DuckDB read hint for externally querying flushed observations. */
export function parquetReadHint(prefix: string): string {
  return `query them with DuckDB: read_parquet('s3://<bucket>/${prefix}**/*.parquet')`;
}

/** Synchronous wide-table ZSTD Parquet codec. */
export const PARQUET_CODEC: ObserveCodec = {
  extension: OBSERVE_PARQUET_EXTENSION,

  encode(records: ObserveRecord[]): ObserveEncoded {
    /* The writer a synchronous codec produces: see the note above. */
    const writer = createWriter(OBSERVE_PARQUET_SCHEMA, {
      createdBy: OBSERVE_PARQUET_CREATED_BY,
      codec: OBSERVE_PARQUET_WRITER_CODEC,
    }) as SyncParquetWriter;
    /* Empty flushes remain valid schema-bearing Parquet files. */
    writer.appendAll(records.map((record) => observeParquetRow(record)));
    return { bytes: writer.finish(), extension: OBSERVE_PARQUET_EXTENSION };
  },

  decode(bytes: Uint8Array): ObserveDecoded {
    /* Invalid files throw; invalid rows are counted below. */
    const file = readParquet(bytes, { codecs: OBSERVE_PARQUET_READER_CODECS }) as ParquetFile;

    const records: ObserveRecord[] = [];
    let malformed = 0;
    for (const row of file.rows) {
      const record = observeRecordOf(row);
      if (record === null) malformed++;
      else records.push(record);
    }
    return { records, malformed };
  },
};

/** Reconstructs a record row. Required identity columns validate the row; newer
 * columns are skipped, and flattened status/duration fields are restored. */
export function observeRecordOf(row: ReadRow): ObserveRecord | null {
  const kind = row.record;
  if (kind !== "flush" && kind !== "event" && kind !== "counters") return null;

  const node = row.node;
  if (typeof node !== "string") return null;
  try {
    assertNodeId(node);
  } catch {
    return null;
  }

  const at = row.at;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;

  const record: Record<string, unknown> = { record: kind, node, at: at.toISOString() };
  const status: Partial<StatusClassCounts> = {};
  const durations = new Map<number, number>();

  for (const [column, value] of Object.entries(row)) {
    /* Null means this record kind has no value for the column. */
    if (value === null || SHARED_COLUMNS.has(column)) continue;

    const klass = STATUS_CLASS_OF.get(column);
    if (klass !== undefined) {
      status[klass] = scalar(value);
      continue;
    }

    const band = DURATION_BAND_OF.get(column);
    if (band !== undefined) {
      durations.set(band, scalar(value));
      continue;
    }

    const field = FIELD_OF.get(column);
    if (field === undefined) continue;
    record[field] = value instanceof Date ? value.toISOString() : scalar(value);
  }

  /* Flattened counter columns win for malformed hand-written duplicate fields. */
  if (Object.keys(status).length > 0) record.status = { ...EMPTY_STATUS, ...status };
  if (durations.size > 0) {
    record.durations = Array.from(
      { length: DURATION_BANDS_MS.length + 1 },
      (_unused, index) => durations.get(index) ?? 0,
    );
  }
  return record as ObserveRecord;
}

/* ------------------------------------------------------------------ internal */

/** Distributes over a union, so each member keeps its own keys. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Every field name any record kind can carry. */
type ObserveField = KeysOfUnion<ObserveRecord>;

/** Columns whose value is an ISO-8601 instant in the record and an epoch in the file. */
const INSTANTS = new Set<ObserveParquetColumn>(["at", "since"]);

/**
 * The column one status class flattens into.
 *
 * A `Record` over the class names for the same reason {@link COLUMN_OF} is one
 * over the record fields: a class added to `StatusClassCounts` is a missing
 * property here and the build stops, rather than a column silently going
 * unwritten. It is also the inverse the read side walks.
 */
const STATUS_COLUMN_OF: Record<keyof StatusClassCounts, ObserveParquetColumn> = {
  "2xx": "status_2xx",
  "3xx": "status_3xx",
  "4xx": "status_4xx",
  "5xx": "status_5xx",
  "other": "status_other",
};

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

  for (const [name, count] of Object.entries(value as StatusClassCounts)) {
    row[STATUS_COLUMN_OF[name as keyof StatusClassCounts]] = count;
  }
}

/* ------------------------------------------------------- reading a row back */

/** The three columns {@link observeRecordOf} places before it walks the rest. */
const SHARED_COLUMNS = new Set<string>(["record", "node", "at"]);

/**
 * Every column that is one field's own, and the field it came from.
 *
 * Derived from {@link COLUMN_OF} rather than written down beside it, so the two
 * directions cannot drift: a column the write side stops producing stops being
 * read, and one it starts producing is read without a second edit.
 */
const FIELD_OF: Map<string, ObserveField> = new Map(
  Object.entries(COLUMN_OF)
    .filter(([, column]) => column !== SPREAD)
    .map(([field, column]) => [column as ObserveParquetColumn, field as ObserveField]),
);

/** The class one `status_*` column carries: {@link STATUS_COLUMN_OF}, inverted. */
const STATUS_CLASS_OF: Map<string, keyof StatusClassCounts> = new Map(
  Object.entries(STATUS_COLUMN_OF).map(([klass, column]) => [
    column,
    klass as keyof StatusClassCounts,
  ]),
);

/** The band index one duration column carries: {@link durationBandColumn}, inverted. */
const DURATION_BAND_OF: Map<string, number> = new Map(
  Array.from({ length: DURATION_BANDS_MS.length + 1 }, (_unused, index) => [
    durationBandColumn(index),
    index,
  ]),
);

/** Every class at zero, so a snapshot missing a column reads as counting none of it. */
const EMPTY_STATUS: StatusClassCounts = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0 };

/**
 * One read value as the record holds it.
 *
 * The only conversion is `bigint` to `number`: every `i64` column here counts
 * something a node did in a minute — requests, bytes or milliseconds —
 * and none of them can reach `Number.MAX_SAFE_INTEGER`, while a record whose
 * counts were bigints would no longer be the record that was written.
 */
function scalar<T>(value: unknown): T {
  return (typeof value === "bigint" ? Number(value) : value) as T;
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
