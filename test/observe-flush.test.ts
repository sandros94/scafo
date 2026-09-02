/*
 * What a node writes about itself: what a flush carries, where it lands, what a failed one keeps,
 * and what a retention sweep is allowed to delete.
 */

import { readParquet } from "tavolato";
import { beforeEach, describe, expect, it } from "vitest";
import { createIngressCounters, DURATION_BANDS_MS } from "../src/daemon/access-counters.ts";
import {
  createObserveFlusher,
  OBSERVE_FLUSH_INTERVAL_MS,
  type ObserveFlusher,
  OBSERVE_RETENTION_DAYS,
} from "../src/daemon/observe-flush.ts";
import {
  counterRecords,
  eventRecords,
  flushRecords,
  type ObserveRecord,
  OBSERVE_RECORD_VERSION,
} from "../src/daemon/observe-records.ts";
import {
  OBSERVE_PARQUET_COMPRESSION,
  OBSERVE_PARQUET_EXTENSION,
  PARQUET_CODEC,
} from "../src/daemon/observe-parquet.ts";
import { createObservability, type Observability } from "../src/daemon/observe.ts";
import { parseObserveKey } from "../src/core/registry/paths.ts";
import type { CasStore } from "../src/core/types/store.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { CLOCK_START_MS, ctxWith, FaultStore, type ManualClock } from "./_helpers.ts";

const NODE = "node-a";
const DOMAIN = "apps.test";
const DAY_MS = 86_400_000;

let store: MemoryCasStore;
let clock: ManualClock;
let observe: Observability;

beforeEach(() => {
  store = new MemoryCasStore();
  clock = ctxWith(store);
  observe = createObservability({ enabled: true, now: (): Date => new Date(clock.nowMs()) });
});

/** A flusher over the case's clock and store, with the cadence it wants. */
function flusherWith(
  overrides: Partial<Parameters<typeof createObserveFlusher>[1]> = {},
  ctxStore?: CasStore,
): ObserveFlusher {
  return createObserveFlusher(
    { store: ctxStore ?? store, now: (): Date => new Date(clock.nowMs()) },
    { nodeId: NODE, observability: observe, log: (): void => {}, ...overrides },
  );
}

/** Every record in the bucket, oldest key first. */
async function written(from: CasStore = store): Promise<ObserveRecord[]> {
  const records: ObserveRecord[] = [];
  for (const key of await from.list("_scafo/observe/")) {
    const bytes = await from.getBytes(key);
    if (bytes !== null) records.push(...PARQUET_CODEC.decode(bytes).records);
  }
  return records;
}

describe("what a flush carries", () => {
  it("writes the drained events, one record each, under the node that saw them", async () => {
    observe.emit({ type: "runtime.started", processId: "archive--old" });
    clock.tick(10);
    observe.emit({
      type: "runtime.started",
      processId: "shop--prod",
    });

    expect(await flusherWith().flush()).toBe(true);

    expect(eventRecords(await written())).toEqual([
      {
        v: OBSERVE_RECORD_VERSION,
        record: "event",
        node: NODE,
        at: new Date(CLOCK_START_MS).toISOString(),
        type: "runtime.started",
        processId: "archive--old",
      },
      {
        v: OBSERVE_RECORD_VERSION,
        record: "event",
        node: NODE,
        at: new Date(CLOCK_START_MS + 10).toISOString(),
        type: "runtime.started",
        processId: "shop--prod",
      },
    ]);
  });

  it("heads the file with what it carried and what it lost", async () => {
    observe.emit({ type: "runtime.started", processId: "shop--prod" });

    await flusherWith().flush();

    expect(flushRecords(await written())).toEqual([
      {
        v: OBSERVE_RECORD_VERSION,
        record: "flush",
        node: NODE,
        at: new Date(CLOCK_START_MS).toISOString(),
        events: 1,
        counters: 0,
        ringDropped: 0,
        pendingDropped: 0,
      },
    ]);
  });

  it("reports the events the ring dropped before a drain could reach them", async () => {
    observe = createObservability({
      enabled: true,
      ringSize: 2,
      now: (): Date => new Date(clock.nowMs()),
    });
    for (let index = 0; index < 5; index++)
      observe.emit({ type: "runtime.started", processId: `shop--env-${String(index)}` });

    await flusherWith().flush();

    const header = flushRecords(await written())[0];
    expect({ events: header.events, ringDropped: header.ringDropped }).toEqual({
      events: 2,
      ringDropped: 3,
    });
  });

  it("takes a counters snapshot beside them, one record per environment", async () => {
    const counters = createIngressCounters({
      platformDomains: [DOMAIN],
      now: (): Date => new Date(clock.nowMs()),
    });
    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 1200, 0.02));
    counters.ingest(caddyLine(`shop.${DOMAIN}`, 500, 30, 2.5));
    counters.ingest(caddyLine(`shop--preview.${DOMAIN}`, 200, 90, 0.005));

    await flusherWith({ counters }).flush();

    const records = counterRecords(await written());
    expect(records.map((record) => [record.project, record.env, record.requests])).toEqual([
      ["shop", "preview", 1],
      ["shop", "production", 2],
    ]);
    expect(records[1].since).toBe(new Date(CLOCK_START_MS).toISOString());
    expect(records[1].status).toEqual({ "2xx": 1, "3xx": 0, "4xx": 0, "5xx": 1, "other": 0 });
    expect(records[1].durations).toHaveLength(DURATION_BANDS_MS.length + 1);
    expect(records[1].bytes).toBe(1230);
  });

  it("puts the adapter's own totals on the header rather than on every bucket", async () => {
    const counters = createIngressCounters({
      platformDomains: [DOMAIN],
      now: (): Date => new Date(clock.nowMs()),
    });
    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 10, 0.01));
    counters.ingest("this is not a log line");
    counters.ingest(caddyLine("nothing.example.invalid", 404, 0, 0.001));

    await flusherWith({ counters }).flush();

    const header = flushRecords(await written())[0];
    expect({
      lines: header.lines,
      malformed: header.malformed,
      unattributed: header.unattributed,
    }).toEqual({ lines: 3, malformed: 1, unattributed: 1 });
  });

  it("writes nothing at all when there is nothing new to say", async () => {
    const flusher = flusherWith();

    expect(await flusher.flush()).toBe(false);
    expect(await store.list("_scafo/observe/")).toEqual([]);
  });

  it("stops rewriting identical counter snapshots on an idle node", async () => {
    const counters = createIngressCounters({
      platformDomains: [DOMAIN],
      now: (): Date => new Date(clock.nowMs()),
    });
    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 10, 0.01));
    const flusher = flusherWith({ counters });

    expect(await flusher.flush()).toBe(true);
    clock.tick(OBSERVE_FLUSH_INTERVAL_MS);
    expect(await flusher.flush()).toBe(false);

    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 10, 0.01));
    expect(await flusher.flush()).toBe(true);
  });
});

describe("where a flush lands", () => {
  it("files it under the node, the UTC calendar and the moment it was written", async () => {
    clock = ctxWith(store, Date.parse("2026-03-04T05:06:07.008Z"));
    observe = createObservability({ enabled: true, now: (): Date => new Date(clock.nowMs()) });
    observe.emit({ type: "runtime.started", processId: "shop--prod" });

    await flusherWith().flush();

    const [key] = await store.list("_scafo/observe/");
    expect(key).toBe(
      `_scafo/observe/${NODE}/2026/03/04/05/${String(Date.parse("2026-03-04T05:06:07.008Z"))}-000001.parquet`,
    );
    expect(parseObserveKey(key)).toEqual({
      node: NODE,
      atMs: Date.parse("2026-03-04T05:06:07.008Z"),
      seq: 1,
      extension: OBSERVE_PARQUET_EXTENSION,
    });
  });

  it("never writes two flushes to one key, even in the same millisecond", async () => {
    const flusher = flusherWith();
    observe.emit({ type: "runtime.started", processId: "shop--one" });
    await flusher.flush();
    observe.emit({ type: "runtime.started", processId: "shop--two" });
    await flusher.flush();

    expect(await store.list("_scafo/observe/")).toHaveLength(2);
    expect(eventRecords(await written())).toHaveLength(2);
  });
});

describe("the encoder seam", () => {
  const records: ObserveRecord[] = [
    {
      v: OBSERVE_RECORD_VERSION,
      record: "flush",
      node: NODE,
      at: new Date(CLOCK_START_MS).toISOString(),
      events: 1,
      counters: 1,
      ringDropped: 0,
      pendingDropped: 0,
    },
    {
      v: OBSERVE_RECORD_VERSION,
      record: "event",
      node: NODE,
      at: new Date(CLOCK_START_MS).toISOString(),
      type: "runtime.started",
      processId: "shop--production",
    },
    {
      v: OBSERVE_RECORD_VERSION,
      record: "counters",
      node: NODE,
      at: new Date(CLOCK_START_MS).toISOString(),
      since: new Date(CLOCK_START_MS).toISOString(),
      project: "shop",
      env: "production",
      requests: 2,
      bytes: 30,
      status: { "2xx": 2, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0 },
      durations: [2, 0, 0, 0, 0, 0, 0],
    },
  ];

  it("round-trips every record kind through the codec that writes them", () => {
    const encoded = PARQUET_CODEC.encode(records);

    expect(encoded.extension).toBe(OBSERVE_PARQUET_EXTENSION);
    expect(PARQUET_CODEC.decode(encoded.bytes)).toEqual({ records, malformed: 0 });
  });

  it("encodes an empty set as a whole file that reads back as no records", () => {
    const encoded = PARQUET_CODEC.encode([]);

    expect(encoded.bytes.length).toBeGreaterThan(8);
    expect(PARQUET_CODEC.decode(encoded.bytes)).toEqual({ records: [], malformed: 0 });
  });

  it("puts the codec's bytes at the codec's extension, and puts them WHOLE", async () => {
    observe.emit({ type: "runtime.started", processId: "shop--prod" });
    const counters = createIngressCounters({
      platformDomains: [DOMAIN],
      now: (): Date => new Date(clock.nowMs()),
    });
    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 1234, 0.02));

    expect(await flusherWith({ counters }).flush()).toBe(true);

    const [key] = await store.list("_scafo/observe/");
    expect(parseObserveKey(key)?.extension).toBe(OBSERVE_PARQUET_EXTENSION);

    const bytes = await store.getBytes(key);
    expect(bytes).not.toBeNull();
    const magic = new TextDecoder();
    expect(magic.decode((bytes as Uint8Array).subarray(0, 4))).toBe("PAR1");
    expect(magic.decode((bytes as Uint8Array).subarray(-4))).toBe("PAR1");

    const decoded = PARQUET_CODEC.decode(bytes as Uint8Array);
    expect(decoded.malformed).toBe(0);
    expect(decoded.records.map((record) => record.record)).toEqual(["flush", "event", "counters"]);
  });

  it("compresses the flush, and reads it back only because the codec is registered", async () => {
    observe.emit({ type: "runtime.started", processId: "shop--prod" });

    await flusherWith().flush();

    const [key] = await store.list("_scafo/observe/");
    const bytes = (await store.getBytes(key)) as Uint8Array;

    expect(() => readParquet(bytes)).toThrow(new RegExp(OBSERVE_PARQUET_COMPRESSION));
    expect(PARQUET_CODEC.decode(bytes).records).toHaveLength(2);
  });
});

describe("the cadence", () => {
  it("flushes on the interval and not before it", async () => {
    const flusher = flusherWith({ intervalMs: 60_000, drainIntervalMs: 5_000 });
    flusher.start();
    observe.emit({ type: "runtime.started", processId: "shop--prod" });

    clock.tick(30_000);
    await flusher.tick();
    expect(await store.list("_scafo/observe/")).toEqual([]);

    clock.tick(30_000);
    await flusher.tick();
    expect(await store.list("_scafo/observe/")).toHaveLength(1);
    flusher.stop();
  });

  it("flushes early once the pending buffer crosses its bound", async () => {
    const flusher = flusherWith({ intervalMs: 60_000, drainIntervalMs: 5_000, maxRecords: 3 });
    flusher.start();

    for (let index = 0; index < 3; index++)
      observe.emit({ type: "runtime.started", processId: `shop--${String(index)}` });
    clock.tick(5_000);
    await flusher.tick();

    expect(eventRecords(await written())).toHaveLength(3);
    flusher.stop();
  });

  it("keeps draining between flushes, so the ring cannot overflow waiting for one", async () => {
    observe = createObservability({
      enabled: true,
      ringSize: 2,
      now: (): Date => new Date(clock.nowMs()),
    });
    const flusher = flusherWith({ intervalMs: 60_000, drainIntervalMs: 5_000 });
    flusher.start();

    for (let round = 0; round < 4; round++) {
      observe.emit({ type: "runtime.started", processId: `shop--round-${String(round)}` });
      clock.tick(5_000);
      await flusher.tick();
    }
    clock.tick(60_000);
    await flusher.tick();

    expect(eventRecords(await written())).toHaveLength(4);
    expect(flushRecords(await written())[0].ringDropped).toBe(0);
  });

  it("does not keep the process alive", () => {
    const flusher = flusherWith();
    flusher.start();
    expect(() => flusher.stop()).not.toThrow();
  });
});

describe("a flush that does not land", () => {
  it("keeps the events for the next attempt rather than losing them", async () => {
    const faults = new FaultStore(store);
    const flusher = flusherWith({}, faults);
    observe.emit({ type: "runtime.started", processId: "shop--one" });

    faults.failAfter(0);
    expect(await flusher.flush()).toBe(false);
    expect(flusher.status().pending).toBe(1);

    observe.emit({ type: "runtime.started", processId: "shop--two" });
    faults.clearFaults();
    expect(await flusher.flush()).toBe(true);

    expect(eventRecords(await written()).map((record) => record.at)).toHaveLength(2);
    expect(flusher.status().pending).toBe(0);
    expect(flusher.status().lastFailure).toBeNull();
  });

  it("retries at the flush cadence, never at the drain one", async () => {
    const faults = new FaultStore(store);
    let attempts = 0;
    faults.onBeforePut = (): void => {
      attempts++;
    };
    const flusher = flusherWith({ intervalMs: 60_000, drainIntervalMs: 5_000 }, faults);
    flusher.start();
    faults.failAfter(0);
    observe.emit({ type: "runtime.started", processId: "shop--one" });

    clock.tick(60_000);
    await flusher.tick();
    expect(attempts).toBe(1);

    clock.tick(5_000);
    await flusher.tick();
    clock.tick(5_000);
    await flusher.tick();
    expect(attempts).toBe(1);

    clock.tick(50_000);
    await flusher.tick();
    expect(attempts).toBe(2);
    flusher.stop();
  });

  it("bounds what it holds, dropping the oldest and counting them", async () => {
    const faults = new FaultStore(store);
    const flusher = flusherWith({ pendingMax: 3 }, faults);
    faults.failAfter(0);

    for (let index = 0; index < 6; index++) {
      observe.emit({ type: "runtime.started", processId: `shop--id-${String(index)}` });
      await flusher.flush();
    }

    expect(flusher.status().pending).toBe(3);
    expect(flusher.status().pendingDropped).toBe(3);

    faults.clearFaults();
    await flusher.flush();

    const records = eventRecords(await written());
    expect(records.map((record) => ("processId" in record ? record.processId : ""))).toEqual([
      "shop--id-3",
      "shop--id-4",
      "shop--id-5",
    ]);
    expect(flushRecords(await written())[0].pendingDropped).toBe(3);
  });

  it("takes a fresh counters snapshot on the retry rather than replaying the lost one", async () => {
    const counters = createIngressCounters({
      platformDomains: [DOMAIN],
      now: (): Date => new Date(clock.nowMs()),
    });
    const faults = new FaultStore(store);
    const flusher = flusherWith({ counters }, faults);

    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 10, 0.01));
    faults.failAfter(0);
    await flusher.flush();

    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 10, 0.01));
    faults.clearFaults();
    await flusher.flush();

    const records = counterRecords(await written());
    expect(records).toHaveLength(1);
    expect(records[0].requests).toBe(2);
  });
});

describe("retention", () => {
  beforeEach(async () => {
    for (const node of [NODE, "node-b"]) {
      for (const age of [0, 10, 31, 400]) {
        const at = new Date(CLOCK_START_MS - age * DAY_MS);
        await store.put(observeKeyFor(node, at), "");
      }
    }
  });

  it("deletes only what is older than the retention, and only this node's", async () => {
    const flusher = flusherWith({ retentionDays: OBSERVE_RETENTION_DAYS });

    const deleted = await flusher.sweep();

    expect(deleted).toHaveLength(2);
    expect(deleted.every((key) => key.startsWith(`_scafo/observe/${NODE}/`))).toBe(true);
    expect(await store.list("_scafo/observe/node-b/")).toHaveLength(4);
    expect(await store.list(`_scafo/observe/${NODE}/`)).toHaveLength(2);
  });

  it("stops at the cap and leaves the rest for the next sweep", async () => {
    const flusher = flusherWith({ retentionDays: OBSERVE_RETENTION_DAYS, sweepMaxDeletes: 1 });

    expect(await flusher.sweep()).toHaveLength(1);
    expect(await store.list(`_scafo/observe/${NODE}/`)).toHaveLength(3);

    expect(await flusher.sweep()).toHaveLength(1);
    expect(await store.list(`_scafo/observe/${NODE}/`)).toHaveLength(2);
    expect(await flusher.sweep()).toEqual([]);
  });

  it("runs on the flush cadence rather than on every flush", async () => {
    const flusher = flusherWith({ sweepEveryFlushes: 3 });

    observe.emit({ type: "runtime.started", processId: "shop--one" });
    await flusher.flush();
    expect(flusher.status().swept).toBe(2);

    for (const id of ["two", "three"]) {
      observe.emit({ type: "runtime.started", processId: `shop--${id}` });
      clock.tick(1);
      await flusher.flush();
    }
    expect(flusher.status().swept).toBe(2);
  });

  it("never throws a sweep out at the caller", async () => {
    const faults = new FaultStore(store);
    faults.failAfter(0);
    const flusher = flusherWith({}, faults);

    await expect(flusher.sweep()).resolves.toEqual([]);
  });
});

/** The key a flush of `node` at `at` would have landed at. */
function observeKeyFor(node: string, at: Date): string {
  const day = [
    String(at.getUTCFullYear()).padStart(4, "0"),
    String(at.getUTCMonth() + 1).padStart(2, "0"),
    String(at.getUTCDate()).padStart(2, "0"),
    String(at.getUTCHours()).padStart(2, "0"),
  ].join("/");
  return `_scafo/observe/${node}/${day}/${String(at.getTime())}-000001.${OBSERVE_PARQUET_EXTENSION}`;
}

/** One line of a Caddy JSON access log, as the tailer would hand it over. */
function caddyLine(host: string, status: number, size: number, durationS: number): string {
  return JSON.stringify({
    request: { host, method: "GET" },
    status,
    size,
    duration: durationS,
  });
}
