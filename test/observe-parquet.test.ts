/*
 * The columnar encoding of a flush: the wide schema it declares, the row every
 * record kind becomes, and the file that comes out.
 *
 * TWO LAYERS, AND THE SECOND IS THE DECISIVE ONE. The mapping is checked through
 * `observeParquetRow` and against the schema `tavolato` validates every row
 * against — so a column renamed, retyped or made required fails here rather than
 * in a query months later. Then, WHERE A DuckDB IS INSTALLED, one case writes a
 * real encode to a file and reads it back with the DuckDB CLI: that is the only
 * check that says the bytes are Parquet rather than that they look like it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DURATION_BANDS_MS } from "../src/agent/access-counters.ts";
import {
  durationBandColumn,
  OBSERVE_PARQUET_CREATED_BY,
  OBSERVE_PARQUET_EXTENSION,
  OBSERVE_PARQUET_READ_HINT,
  OBSERVE_PARQUET_SCHEMA,
  observeParquetRow,
  PARQUET_CODEC,
  parquetReadHint,
} from "../src/agent/observe-parquet.ts";
import type {
  ObserveCountersRecord,
  ObserveEventRecord,
  ObserveFlushRecord,
  ObserveRecord,
} from "../src/agent/observe-records.ts";
import { OBSERVE_RECORD_VERSION } from "../src/agent/observe-records.ts";
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
    project: "shop",
    env: "production",
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

/** One of every event variant the seam can emit, in the order they are declared. */
const EVERY_EVENT: ObserveEventRecord[] = [
  event({
    type: "wake.admitted",
    id: "w1",
    host: "shop.apps.test",
    kind: "environment",
    project: "shop",
    env: "production",
    inFlight: 3,
  }),
  event({
    type: "wake.admitted",
    id: "w2",
    host: "b1b1b1b1.apps.test",
    kind: "build",
    project: "shop",
    env: "production",
    build: "b1b1b1b1",
    inFlight: 1,
  }),
  event({ type: "wake.refused", id: "w3", host: "shop.apps.test" }),
  event({ type: "wake.resolved", id: "w1", storeOps: 4 }),
  event({ type: "wake.resolved", id: "w2" }),
  event({ type: "wake.stamped", id: "w1" }),
  event({ type: "wake.kicked", id: "w1" }),
  event({ type: "wake.served", id: "w1", port: 41_001, status: 200 }),
  event({ type: "wake.failed", id: "w3", reason: "deadline" }),
  event({ type: "reconcile.pass.start", kicked: true }),
  event({
    type: "reconcile.pass.end",
    actions: 2,
    failures: 0,
    storeOps: 11,
    listOps: 3,
    durationMs: 412,
  }),
  event({ type: "rollout.spawned", processId: "shop--prod--b1b1b1b1", build: "b1b1b1b1" }),
  event({ type: "rollout.holdEnded", processId: "shop--prod--b1b1b1b1" }),
  event({ type: "gate.passed", processId: "shop--prod--b1b1b1b1", attempts: 3, durationMs: 900 }),
  event({ type: "gate.failed", processId: "shop--prod--b1b1b1b1", attempts: 5 }),
];

/** The whole file's columns, as name/type/nullability triples. */
function columns(): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const column of OBSERVE_PARQUET_SCHEMA.columns) {
    shape[column.name] = `${column.type}${column.optional ? "?" : ""}`;
  }
  return shape;
}

describe("the wide schema a flush declares", () => {
  it("is one flat column per field of every record kind, and no others", () => {
    expect(columns()).toEqual({
      /* Every record carries these, so they are the only REQUIRED ones. */
      v: "i64",
      record: "string",
      node: "string",
      at: "timestamp",

      /* The flush header. */
      events: "i64?",
      counters: "i64?",
      ringDropped: "i64?",
      pendingDropped: "i64?",
      lines: "i64?",
      malformed: "i64?",
      unattributed: "i64?",

      /* The event union, flattened. */
      type: "string?",
      id: "string?",
      host: "string?",
      kind: "string?",
      project: "string?",
      env: "string?",
      build: "string?",
      inFlight: "i64?",
      storeOps: "i64?",
      listOps: "i64?",
      port: "i64?",
      status: "i64?",
      reason: "string?",
      kicked: "bool?",
      actions: "i64?",
      failures: "i64?",
      durationMs: "i64?",
      processId: "string?",
      attempts: "i64?",

      /* The counter snapshot, its two nested fields flattened. */
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
    /* Anything past the last boundary lands in a band of its own, exactly as the
       JSON-LINES array's extra entry does. */
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
      project: "shop",
      env: "production",
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

  it("keeps the bare `status` column for an event's HTTP status", () => {
    /* Two fields share the name `status` in the record union: the counters
       object, which flattens above, and a `wake.served`'s response code, which is
       already a number and keeps the column. */
    const row = observeParquetRow(
      event({ type: "wake.served", id: "w1", port: 41_001, status: 503 }),
    );

    expect(row.status).toBe(503);
    expect(row.status_2xx).toBeUndefined();
  });

  it("reads both timestamps as instants rather than as the strings they were written as", () => {
    const row = observeParquetRow(counters());

    expect(row.at).toBe(Date.parse(AT));
    expect(row.since).toBe(Date.parse(SINCE));
  });

  it("leaves a column the record says nothing about ABSENT, which is a real null", () => {
    /* Absent is not zero: a record that counts no requests and one that counted
       zero are different answers, and a reader must be able to tell them apart. */
    const row = observeParquetRow(event({ type: "wake.kicked", id: "w1" }));

    expect(row).toEqual({
      v: OBSERVE_RECORD_VERSION,
      record: "event",
      node: NODE,
      at: CLOCK_START_MS,
      type: "wake.kicked",
      id: "w1",
    });
    expect(Object.hasOwn(row, "requests")).toBe(false);
  });

  it("maps every event variant, each carrying only its own fields", () => {
    const rows = EVERY_EVENT.map((record) => observeParquetRow(record));

    /* Every one of them is an event of a known type, on the shared four columns. */
    expect(rows.every((row) => row.record === "event" && row.at === CLOCK_START_MS)).toBe(true);
    expect(new Set(rows.map((row) => row.type))).toEqual(
      new Set([
        "wake.admitted",
        "wake.refused",
        "wake.resolved",
        "wake.stamped",
        "wake.kicked",
        "wake.served",
        "wake.failed",
        "reconcile.pass.start",
        "reconcile.pass.end",
        "rollout.spawned",
        "rollout.holdEnded",
        "gate.passed",
        "gate.failed",
      ]),
    );

    /* The variants that differ within a type differ in the row too: an admitted
       build names its build, an admitted environment leaves the column null, and
       a `wake.resolved` that reported no cost leaves `storeOps` null. */
    expect(rows[0].build).toBeUndefined();
    expect(rows[1].build).toBe("b1b1b1b1");
    expect(rows[3].storeOps).toBe(4);
    expect(rows[4].storeOps).toBeUndefined();
    expect(rows[9].kicked).toBe(true);
  });

  it("refuses a record whose timestamp is not an instant rather than writing a guess", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(observeParquetRow(flush({ at: "the other day" }))),
      "invalid-input",
    );

    expect(error.detail).toContain("ISO-8601");
  });

  it("drops a field a newer agent added, because the schema is this build's", () => {
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

    /* A footer for 44 columns is the floor whatever the rows say, and 17 rows of
       mostly-null columns cannot reach 64 KiB. Loose on purpose: this is a sanity
       bound on the encoder, not a golden size to be updated on every change. */
    expect(bytes.length).toBeGreaterThan(2000);
    expect(bytes.length).toBeLessThan(65_536);
    expect(records).toHaveLength(17);
  });

  it("writes a whole file for a flush of nothing, rather than no file", () => {
    const { bytes } = PARQUET_CODEC.encode([]);

    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe(MAGIC);
    expect(bytes.length).toBeGreaterThan(8);
  });

  it("is validated row by row by the writer's own schema", () => {
    /* `tavolato` rejects a value of the wrong type for a column, so an encode
       that returns at all is a mapping every column agreed with. */
    expect(() =>
      PARQUET_CODEC.encode([{ ...counters(), requests: "many" } as unknown as ObserveRecord]),
    ).toThrow(/requests/);
  });
});

describe("reading it back", () => {
  it("refuses, and says where the data is actually queried", async () => {
    const error = await rejectsWith(
      () => Promise.resolve(PARQUET_CODEC.decode(new Uint8Array([0]))),
      "capability-missing",
    );

    expect(error.detail).toContain("DuckDB");
    expect(error.detail).toContain("read_parquet(");
  });

  it("names the node's own prefix when the caller knows one", () => {
    expect(parquetReadHint("_scafo/observe/node-a/")).toBe(
      "query them with DuckDB: read_parquet('s3://<bucket>/_scafo/observe/node-a/**/*.parquet')",
    );
    expect(OBSERVE_PARQUET_READ_HINT).toContain("_scafo/observe/<node>/**/*.parquet");
  });
});

/*
 * THE DECISIVE CHECK, AND IT ONLY RUNS WHERE A DuckDB IS. Everything above says
 * the encoder did what this repository asked of it; only a real Parquet reader
 * says the bytes are a Parquet file. Gated on the binary being present, the same
 * way the end-to-end suites are gated on being asked for, so a machine without
 * one runs a green suite rather than a red herring.
 */
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

    /* The columns as the FORMAT declares them, read out of the footer rather than
       inferred from the rows: physical type, real Parquet repetition, and the
       logical annotation that makes an INT64 an instant. */
    const declared = query(
      file,
      "SELECT name || ' ' || type || ' ' || repetition_type || ' ' || " +
        "coalesce(converted_type, '-') FROM parquet_schema('$FILE') " +
        "WHERE repetition_type IS NOT NULL",
    ).split("\n");

    /* The four every record carries are REQUIRED; every other column is OPTIONAL,
       which is what lets three record kinds share one table. */
    expect(declared).toContain("v INT64 REQUIRED -");
    expect(declared).toContain("record BYTE_ARRAY REQUIRED UTF8");
    expect(declared).toContain("node BYTE_ARRAY REQUIRED UTF8");
    expect(declared).toContain("at INT64 REQUIRED TIMESTAMP_MILLIS");
    expect(declared).toContain("since INT64 OPTIONAL TIMESTAMP_MILLIS");
    expect(declared).toContain("kicked BOOLEAN OPTIONAL -");
    expect(declared).toContain("status INT64 OPTIONAL -");
    expect(declared).toContain("status_2xx INT64 OPTIONAL -");
    expect(declared).toContain("durations_gt_3000ms INT64 OPTIONAL -");
    expect(declared).toContain("reason BYTE_ARRAY OPTIONAL UTF8");
    expect(declared.filter((line) => line.includes(" REQUIRED "))).toHaveLength(4);
    expect(declared).toHaveLength(OBSERVE_PARQUET_SCHEMA.columns.length);

    /* And what a querying human sees: the two instants are instants. */
    const described = query(
      file,
      "SELECT column_name || ' ' || column_type FROM (DESCRIBE SELECT * FROM read_parquet('$FILE'))",
    ).split("\n");

    expect(described).toContain("at TIMESTAMP WITH TIME ZONE");
    expect(described).toContain("since TIMESTAMP WITH TIME ZONE");
    expect(described).toContain("node VARCHAR");
    expect(described).toContain("kicked BOOLEAN");
    expect(described).toContain("durations_le_10ms BIGINT");

    /* The rows, filtered on the discriminant exactly as a reader of the
       JSON-LINES files filters on it. `at` and `type` are SQL keywords, so a
       query names them quoted — the column is the record's own field name and
       stays that, because a schema that renamed fields to please one reader would
       stop matching the records it encodes. */
    expect(query(file, "SELECT count(*) FROM read_parquet('$FILE')")).toBe("17");
    expect(
      query(
        file,
        `SELECT "record", count(*) FROM read_parquet('$FILE') GROUP BY "record" ORDER BY "record"`,
      ),
    ).toBe(["counters,1", "event,15", "flush,1"].join("\n"));

    /* A counter snapshot reads as the numbers it was written from, timestamp
       included — which is what makes these files answerable without scafo. */
    expect(
      query(
        file,
        `SELECT "project", "env", "requests", "bytes", "status_2xx", "durations_le_10ms", ` +
          `"durations_gt_3000ms", epoch_ms("at"), epoch_ms("since") ` +
          `FROM read_parquet('$FILE') WHERE "record" = 'counters'`,
      ),
      /* Compared as epochs rather than as rendered instants: a `timestamp` is
         UTC-normalised in the file, and `strftime` would render it in whatever
         zone the machine running the suite happens to be in. */
    ).toBe(
      ["shop", "production", 41, 90_210, 35, 10, 1, CLOCK_START_MS, Date.parse(SINCE)].join(","),
    );

    /* A column no record of a kind carries is a real null rather than a zero. */
    expect(
      query(
        file,
        `SELECT count(*) FROM read_parquet('$FILE') WHERE "record" = 'event' ` +
          `AND "requests" IS NULL`,
      ),
    ).toBe("15");
    expect(
      query(file, `SELECT "status" FROM read_parquet('$FILE') WHERE "type" = 'wake.served'`),
    ).toBe("200");
    expect(
      query(
        file,
        `SELECT count(*) FROM read_parquet('$FILE') WHERE "type" = 'wake.admitted' ` +
          `AND "build" IS NULL`,
      ),
    ).toBe("1");

    /* And the file says who wrote it. */
    expect(query(file, "SELECT created_by FROM parquet_file_metadata('$FILE')")).toBe(
      OBSERVE_PARQUET_CREATED_BY,
    );
  });
});
