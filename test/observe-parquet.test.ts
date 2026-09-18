/*
 * The columnar encoding of a flush: the wide schema it declares, the row every record kind
 * becomes, the file that comes out, and the records that come back.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriter, defineSchema, readParquet } from "tavolato";
import type { SyncParquetWriter } from "tavolato";
import { afterAll, describe, expect, it } from "vitest";
import { DURATION_BANDS_MS } from "../src/daemon/access-counters.ts";
import {
  durationBandColumn,
  OBSERVE_PARQUET_COMPRESSION,
  OBSERVE_PARQUET_CREATED_BY,
  OBSERVE_PARQUET_EXTENSION,
  OBSERVE_PARQUET_SCHEMA,
  OBSERVE_PARQUET_WRITER_CODEC,
  type ObserveParquetRow,
  observeParquetRow,
  PARQUET_CODEC,
  parquetReadHint,
} from "../src/daemon/observe-parquet.ts";
import type {
  ObserveCountersRecord,
  ObserveEventRecord,
  ObserveFlushRecord,
  ObserveRecord,
} from "../src/daemon/observe-records.ts";
import { OBSERVE_RECORD_VERSION } from "../src/daemon/observe-records.ts";
import { CLOCK_START_MS, rejectsWith } from "./_helpers.ts";

const NODE = "node-a";
const AT = new Date(CLOCK_START_MS).toISOString();
const SINCE = new Date(CLOCK_START_MS - 3_600_000).toISOString();

/** `PAR1`, which opens and closes every Parquet file. */
const MAGIC = "PAR1";

function flush(overrides: Partial<ObserveFlushRecord> = {}): ObserveFlushRecord {
  return {
    v: OBSERVE_RECORD_VERSION,
    record: "flush",
    node: NODE,
    at: AT,
    events: 2,
    counters: 1,
    ringDropped: 0,
    pendingDropped: 0,
    ...overrides,
  };
}

function counters(overrides: Partial<ObserveCountersRecord> = {}): ObserveCountersRecord {
  return {
    v: OBSERVE_RECORD_VERSION,
    record: "counters",
    node: NODE,
    at: AT,
    since: SINCE,
    application: "shop",
    requests: 41,
    bytes: 90_210,
    status: { "2xx": 35, "3xx": 2, "4xx": 3, "5xx": 1, "other": 0 },
    durations: [10, 9, 8, 7, 4, 2, 1],
    ...overrides,
  };
}

function event(body: Record<string, unknown>): ObserveEventRecord {
  return {
    v: OBSERVE_RECORD_VERSION,
    record: "event",
    node: NODE,
    at: AT,
    ...body,
  } as ObserveEventRecord;
}

/** Representative events in the order the seam declares them. */
const EVERY_EVENT: ObserveEventRecord[] = [
  event({ type: "reconcile.pass.start", kicked: true }),
  event({
    type: "placement.pending",
    application: "shop",
    reason: "placement-unavailable",
  }),
  event({
    type: "reconcile.pass.end",
    actions: 2,
    failures: 0,
    storeOps: 11,
    listOps: 3,
    durationMs: 412,
  }),
  event({ type: "runtime.started", application: "shop-prod" }),
  event({
    type: "operator.trusted",
    actor: "op-aaaa1111",
    subject: "op-bbbb2222",
    role: "operator",
  }),
  event({
    type: "operator.revoked",
    actor: "op-aaaa1111",
    subject: "op-bbbb2222",
    role: "operator",
  }),
  event({ type: "application.blocked", actor: "op-aaaa1111", application: "shop" }),
  event({ type: "application.unblocked", actor: "op-aaaa1111", application: "shop" }),
];

/** Rows written straight through the wide schema, bypassing the record mapping. */
function writeRows(rows: ObserveParquetRow[]): Uint8Array {
  const writer = createWriter(OBSERVE_PARQUET_SCHEMA, {
    createdBy: OBSERVE_PARQUET_CREATED_BY,
    codec: OBSERVE_PARQUET_WRITER_CODEC,
  }) as SyncParquetWriter;
  writer.appendAll(rows);
  return writer.finish();
}

/**
 * The whole file's columns, as name/type/nullability triples.
 *
 * A column's type is a built-in name or a logical adapter; this schema uses only
 * the former, and naming the latter is what keeps that a statement rather than an
 * assumption — an adapter would read as its own name here instead of as an object.
 */
function columns(): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const column of OBSERVE_PARQUET_SCHEMA.columns) {
    const type = typeof column.type === "string" ? column.type : column.type.name;
    shape[column.name] = `${type}${column.optional ? "?" : ""}`;
  }
  return shape;
}

describe("the wide schema a flush declares", () => {
  it("is one flat column per field of every record kind, and no others", () => {
    expect(columns()).toEqual({
      v: "i64",
      record: "string",
      node: "string",
      at: "timestamp",

      events: "i64?",
      counters: "i64?",
      ringDropped: "i64?",
      pendingDropped: "i64?",
      lines: "i64?",
      malformed: "i64?",
      unattributed: "i64?",

      type: "string?",
      application: "string?",
      storeOps: "i64?",
      listOps: "i64?",
      reason: "string?",
      kicked: "bool?",
      actions: "i64?",
      failures: "i64?",
      durationMs: "i64?",
      actor: "string?",
      subject: "string?",
      role: "string?",

      since: "timestamp?",
      requests: "i64?",
      bytes: "i64?",
      status_2xx: "i64?",
      status_3xx: "i64?",
      status_4xx: "i64?",
      status_5xx: "i64?",
      status_other: "i64?",
      durations_le_10ms: "i64?",
      durations_le_50ms: "i64?",
      durations_le_100ms: "i64?",
      durations_le_300ms: "i64?",
      durations_le_1000ms: "i64?",
      durations_le_3000ms: "i64?",
      durations_gt_3000ms: "i64?",
    });
  });

  it("names a duration column after the band's own boundary, one past the last", () => {
    expect(DURATION_BANDS_MS.map((_, index) => durationBandColumn(index))).toEqual([
      "durations_le_10ms",
      "durations_le_50ms",
      "durations_le_100ms",
      "durations_le_300ms",
      "durations_le_1000ms",
      "durations_le_3000ms",
    ]);
    expect(durationBandColumn(DURATION_BANDS_MS.length)).toBe("durations_gt_3000ms");
  });

  it("declares one duration column per band the fleet counts, and cannot drift from it", () => {
    const bands = OBSERVE_PARQUET_SCHEMA.columns.filter((column) =>
      column.name.startsWith("durations_"),
    );
    expect(bands).toHaveLength(DURATION_BANDS_MS.length + 1);
  });
});

describe("what one record becomes", () => {
  it("maps a flush header, leaving the adapter's totals absent when it counts nothing", () => {
    expect(observeParquetRow(flush({ ringDropped: 7, pendingDropped: 2 }))).toEqual({
      v: OBSERVE_RECORD_VERSION,
      record: "flush",
      node: NODE,
      at: CLOCK_START_MS,
      events: 2,
      counters: 1,
      ringDropped: 7,
      pendingDropped: 2,
    });
  });

  it("carries the access-log totals when the node counts requests", () => {
    const row = observeParquetRow(flush({ lines: 900, malformed: 3, unattributed: 12 }));

    expect(row.lines).toBe(900);
    expect(row.malformed).toBe(3);
    expect(row.unattributed).toBe(12);
  });

  it("flattens a counter snapshot's status object and duration array by their own names", () => {
    expect(observeParquetRow(counters())).toEqual({
      v: OBSERVE_RECORD_VERSION,
      record: "counters",
      node: NODE,
      at: CLOCK_START_MS,
      since: CLOCK_START_MS - 3_600_000,
      application: "shop",
      requests: 41,
      bytes: 90_210,
      status_2xx: 35,
      status_3xx: 2,
      status_4xx: 3,
      status_5xx: 1,
      status_other: 0,
      durations_le_10ms: 10,
      durations_le_50ms: 9,
      durations_le_100ms: 8,
      durations_le_300ms: 7,
      durations_le_1000ms: 4,
      durations_le_3000ms: 2,
      durations_gt_3000ms: 1,
    });
  });

  it("reads both timestamps as instants rather than as the strings they were written as", () => {
    const row = observeParquetRow(counters());

    expect(row.at).toBe(Date.parse(AT));
    expect(row.since).toBe(Date.parse(SINCE));
  });

  it("leaves a column the record says nothing about ABSENT, which is a real null", () => {
    const row = observeParquetRow(event({ type: "runtime.started", application: "shop-prod" }));

    expect(row).toEqual({
      v: OBSERVE_RECORD_VERSION,
      record: "event",
      node: NODE,
      at: CLOCK_START_MS,
      type: "runtime.started",
      application: "shop-prod",
    });
    expect(Object.hasOwn(row, "requests")).toBe(false);
  });

  it("maps every event variant, each carrying only its own fields", () => {
    const rows = EVERY_EVENT.map((record) => observeParquetRow(record));

    expect(rows.every((row) => row.record === "event" && row.at === CLOCK_START_MS)).toBe(true);
    expect(new Set(rows.map((row) => row.type))).toEqual(
      new Set([
        "reconcile.pass.start",
        "placement.pending",
        "reconcile.pass.end",
        "runtime.started",
        "operator.trusted",
        "operator.revoked",
        "application.blocked",
        "application.unblocked",
      ]),
    );

    expect(rows[0].kicked).toBe(true);
    expect(rows[2].storeOps).toBe(11);
  });

  it("files an event's subject and a counter snapshot's in the one application column", () => {
    /* An operational event and a request total name the same thing, so they name
       it in the same column and a query can group the two together. */
    const blocked = observeParquetRow(
      event({ type: "application.blocked", actor: "op-aaaa1111", application: "shop" }),
    );

    expect(blocked.application).toBe("shop");
    expect(blocked.actor).toBe("op-aaaa1111");
    expect(observeParquetRow(counters()).application).toBe("shop");
    expect(
      OBSERVE_PARQUET_SCHEMA.columns.filter((column) => column.name === "application"),
    ).toEqual([{ name: "application", type: "string", optional: true }]);
  });

  it("refuses a record whose timestamp is not an instant rather than writing a guess", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(observeParquetRow(flush({ at: "the other day" }))),
      "invalid-input",
    );

    expect(error.detail).toContain("ISO-8601");
  });

  it("drops a field a newer daemon added, because the schema is this build's", () => {
    const record = { ...flush(), invented: "by a later version" } as unknown as ObserveRecord;

    expect(Object.hasOwn(observeParquetRow(record), "invented")).toBe(false);
  });
});

describe("the file a flush encodes to", () => {
  it("is a Parquet file, opened and closed by its magic", () => {
    const { bytes, extension } = PARQUET_CODEC.encode([flush(), ...EVERY_EVENT, counters()]);
    const text = new TextDecoder("utf-8", { fatal: false });

    expect(extension).toBe(OBSERVE_PARQUET_EXTENSION);
    expect(text.decode(bytes.subarray(0, 4))).toBe(MAGIC);
    expect(text.decode(bytes.subarray(-4))).toBe(MAGIC);
  });

  it("is a size a flush of that shape can plausibly be", () => {
    const records: ObserveRecord[] = [flush(), ...EVERY_EVENT, counters()];
    const { bytes } = PARQUET_CODEC.encode(records);

    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.length).toBeLessThan(65_536);
    expect(records).toHaveLength(10);
  });

  it("compresses every data page, and says in the file which codec it used", () => {
    const bytes = PARQUET_CODEC.encode([flush(), ...EVERY_EVENT, counters()]).bytes;

    expect(() => readParquet(bytes)).toThrow(new RegExp(OBSERVE_PARQUET_COMPRESSION));
    expect(OBSERVE_PARQUET_WRITER_CODEC.name).toBe(OBSERVE_PARQUET_COMPRESSION);
  });

  it("writes a whole file for a flush of nothing, rather than no file", () => {
    const { bytes } = PARQUET_CODEC.encode([]);

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe(MAGIC);
    expect(bytes.length).toBeGreaterThan(8);
  });

  it("is validated row by row by the writer's own schema", () => {
    expect(() =>
      PARQUET_CODEC.encode([{ ...counters(), requests: "many" } as unknown as ObserveRecord]),
    ).toThrow(/requests/);
  });
});

describe("reading it back", () => {
  it("round-trips every record kind, field for field", () => {
    const records: ObserveRecord[] = [flush(), ...EVERY_EVENT, counters()];

    expect(PARQUET_CODEC.decode(PARQUET_CODEC.encode(records).bytes)).toEqual({
      records,
      malformed: 0,
    });
  });

  it("keeps a null column absent rather than reading it back as a zero", () => {
    const started = event({ type: "runtime.started", application: "shop-prod" });

    const [read] = PARQUET_CODEC.decode(PARQUET_CODEC.encode([started]).bytes).records;

    expect(Object.keys(read).sort()).toEqual(["application", "at", "node", "record", "type", "v"]);
  });

  it("reads the flush header's optional totals back only when the node counted", () => {
    const counted = flush({ lines: 900, malformed: 3, unattributed: 12 });
    const uncounted = flush();

    const read = PARQUET_CODEC.decode(PARQUET_CODEC.encode([counted, uncounted]).bytes).records;

    expect(read[0]).toEqual(counted);
    expect(Object.hasOwn(read[1], "lines")).toBe(false);
  });

  it("skips and counts a row that is not a record, keeping the file's good ones", () => {
    const bytes = writeRows([
      observeParquetRow(event({ type: "runtime.started", application: "shop-kept" })),
      { v: 1, record: "invented", node: NODE, at: CLOCK_START_MS },
      { v: 1, record: "event", node: "not a node id", at: CLOCK_START_MS },
    ]);

    const decoded = PARQUET_CODEC.decode(bytes);

    expect(decoded.records).toHaveLength(1);
    expect(decoded.malformed).toBe(2);
  });

  it("skips a column a newer daemon added rather than refusing the row", () => {
    const schema = defineSchema({
      v: { type: "i64" },
      record: { type: "string" },
      node: { type: "string" },
      at: { type: "timestamp" },
      invented: { type: "string", optional: true },
    });
    const writer = createWriter(schema, {
      codec: OBSERVE_PARQUET_WRITER_CODEC,
    }) as SyncParquetWriter;
    writer.appendAll([
      { v: 1, record: "event", node: NODE, at: CLOCK_START_MS, invented: "by a later version" },
    ]);

    const decoded = PARQUET_CODEC.decode(writer.finish());

    expect(decoded.malformed).toBe(0);
    expect(decoded.records[0]).toEqual({ v: 1, record: "event", node: NODE, at: AT });
  });

  it("refuses bytes that are not a Parquet file at all", () => {
    expect(() => PARQUET_CODEC.decode(new Uint8Array([0]))).toThrow(/Parquet file/);
  });

  it("names the node's own prefix for whatever queries these without scafo", () => {
    expect(parquetReadHint("_scafo/observe/node-a/")).toBe(
      "query them with DuckDB: read_parquet('s3://<bucket>/_scafo/observe/node-a/**/*.parquet')",
    );
  });
});

const DUCKDB = [
  join(process.env.HOME ?? "", ".local/bin/duckdb"),
  "/usr/local/bin/duckdb",
  "/usr/bin/duckdb",
].find((path) => existsSync(path));

let workspace: string | undefined;

afterAll(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
});

/** One DuckDB query over a file, as its CSV answer. */
function query(file: string, sql: string): string {
  return execFileSync(DUCKDB as string, ["-csv", "-noheader", "-c", sql.replace("$FILE", file)], {
    encoding: "utf8",
  }).trim();
}

describe.skipIf(DUCKDB === undefined)("what DuckDB makes of a flush", () => {
  it("describes the wide schema and answers questions over every record kind", () => {
    workspace = mkdtempSync(join(tmpdir(), "scafo-parquet-"));
    const file = join(workspace, "flush.parquet");
    writeFileSync(file, PARQUET_CODEC.encode([flush(), ...EVERY_EVENT, counters()]).bytes);

    const declared = query(
      file,
      "SELECT name || ' ' || type || ' ' || repetition_type || ' ' || " +
        "coalesce(converted_type, '-') FROM parquet_schema('$FILE') " +
        "WHERE repetition_type IS NOT NULL",
    ).split("\n");

    expect(declared).toContain("v INT64 REQUIRED -");
    expect(declared).toContain("record BYTE_ARRAY REQUIRED UTF8");
    expect(declared).toContain("node BYTE_ARRAY REQUIRED UTF8");
    expect(declared).toContain("at INT64 REQUIRED TIMESTAMP_MILLIS");
    expect(declared).toContain("since INT64 OPTIONAL TIMESTAMP_MILLIS");
    expect(declared).toContain("kicked BOOLEAN OPTIONAL -");
    expect(declared).toContain("status_2xx INT64 OPTIONAL -");
    expect(declared).toContain("durations_gt_3000ms INT64 OPTIONAL -");
    expect(declared).toContain("reason BYTE_ARRAY OPTIONAL UTF8");
    expect(declared.filter((line) => line.includes(" REQUIRED "))).toHaveLength(4);
    expect(declared).toHaveLength(OBSERVE_PARQUET_SCHEMA.columns.length);

    const described = query(
      file,
      "SELECT column_name || ' ' || column_type FROM (DESCRIBE SELECT * FROM read_parquet('$FILE'))",
    ).split("\n");

    expect(described).toContain("at TIMESTAMP WITH TIME ZONE");
    expect(described).toContain("since TIMESTAMP WITH TIME ZONE");
    expect(described).toContain("node VARCHAR");
    expect(described).toContain("kicked BOOLEAN");
    expect(described).toContain("durations_le_10ms BIGINT");

    expect(query(file, "SELECT count(*) FROM read_parquet('$FILE')")).toBe("10");
    expect(
      query(
        file,
        `SELECT "record", count(*) FROM read_parquet('$FILE') GROUP BY "record" ORDER BY "record"`,
      ),
    ).toBe(["counters,1", "event,8", "flush,1"].join("\n"));

    expect(
      query(
        file,
        `SELECT "application", "requests", "bytes", "status_2xx", "durations_le_10ms", ` +
          `"durations_gt_3000ms", epoch_ms("at"), epoch_ms("since") ` +
          `FROM read_parquet('$FILE') WHERE "record" = 'counters'`,
      ),
    ).toBe(["shop", 41, 90_210, 35, 10, 1, CLOCK_START_MS, Date.parse(SINCE)].join(","));

    expect(
      query(
        file,
        `SELECT count(*) FROM read_parquet('$FILE') WHERE "record" = 'event' ` +
          `AND "requests" IS NULL`,
      ),
    ).toBe("8");
    expect(
      query(file, `SELECT count(*) FROM read_parquet('$FILE') WHERE "type" = 'runtime.started'`),
    ).toBe("1");

    expect(query(file, "SELECT created_by FROM parquet_file_metadata('$FILE')")).toBe(
      OBSERVE_PARQUET_CREATED_BY,
    );
    expect(query(file, "SELECT DISTINCT compression FROM parquet_metadata('$FILE')")).toBe(
      OBSERVE_PARQUET_COMPRESSION,
    );
  });
});
