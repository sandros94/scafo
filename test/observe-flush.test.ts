/*
 * What a node writes about itself: what a flush carries, where it lands, what a
 * failed one keeps, and what a retention sweep is allowed to delete.
 *
 * The clock is injected everywhere, so every key and every `at` is a value the
 * case chose. Nothing here reaches a real bucket — `MemoryCasStore` honours the
 * same contract, and a flush is a plain put.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createIngressCounters, DURATION_BANDS_MS } from "../src/agent/access-counters.ts";
import {
  createObserveFlusher,
  OBSERVE_FLUSH_INTERVAL_MS,
  type ObserveFlusher,
  OBSERVE_RETENTION_DAYS,
} from "../src/agent/observe-flush.ts";
import {
  counterRecords,
  eventRecords,
  flushRecords,
  JSONL_CODEC,
  observeBytes,
  type ObserveRecord,
  OBSERVE_RECORD_VERSION,
} from "../src/agent/observe-records.ts";
import { createObservability, type Observability } from "../src/agent/observe.ts";
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
    const object = await from.get(key);
    if (object !== null) records.push(...JSONL_CODEC.decode(observeBytes(object.body)).records);
  }
  return records;
}

describe("what a flush carries", () => {
  it("writes the drained events, one record each, under the node that saw them", async () => {
    observe.emit({ type: "wake.kicked", id: "aaaa" });
    clock.tick(10);
    observe.emit({
      type: "gate.passed",
      processId: "shop--prod--b1b1b1b1",
      attempts: 3,
      durationMs: 900,
    });

    expect(await flusherWith().flush()).toBe(true);

    expect(eventRecords(await written())).toEqual([
      {
        v: OBSERVE_RECORD_VERSION,
        record: "event",
        node: NODE,
        at: new Date(CLOCK_START_MS).toISOString(),
        type: "wake.kicked",
        id: "aaaa",
      },
      {
        v: OBSERVE_RECORD_VERSION,
        record: "event",
        node: NODE,
        at: new Date(CLOCK_START_MS + 10).toISOString(),
        type: "gate.passed",
        processId: "shop--prod--b1b1b1b1",
        attempts: 3,
        durationMs: 900,
      },
    ]);
  });

  it("heads the file with what it carried and what it lost", async () => {
    observe.emit({ type: "wake.kicked", id: "aaaa" });

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
    /* A ring of two under a node emitting five: the flusher's own loss, which is
       the only place it is ever admitted. */
    observe = createObservability({
      enabled: true,
      ringSize: 2,
      now: (): Date => new Date(clock.nowMs()),
    });
    for (let index = 0; index < 5; index++)
      observe.emit({ type: "wake.kicked", id: `id-${String(index)}` });

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
    /* Monotonic TOTALS since the adapter was made, not a window: the reader
       differences two of these, and the `since` is what makes that possible. */
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
    /* Nothing served in between: an object an hour per idle node, every one of
       them differencing to zero, is what this avoids. */
    expect(await flusher.flush()).toBe(false);

    counters.ingest(caddyLine(`shop.${DOMAIN}`, 200, 10, 0.01));
    expect(await flusher.flush()).toBe(true);
  });
});

describe("where a flush lands", () => {
  it("files it under the node, the UTC calendar and the moment it was written", async () => {
    /* 2026-03-04T05:06:07.008Z, so every segment is one a padding bug would
       show up in. */
    clock = ctxWith(store, Date.parse("2026-03-04T05:06:07.008Z"));
    observe = createObservability({ enabled: true, now: (): Date => new Date(clock.nowMs()) });
    observe.emit({ type: "wake.kicked", id: "aaaa" });

    await flusherWith().flush();

    const [key] = await store.list("_scafo/observe/");
    expect(key).toBe(
      `_scafo/observe/${NODE}/2026/03/04/05/${String(Date.parse("2026-03-04T05:06:07.008Z"))}-000001.jsonl`,
    );
    expect(parseObserveKey(key)).toEqual({
      node: NODE,
      atMs: Date.parse("2026-03-04T05:06:07.008Z"),
      seq: 1,
      extension: "jsonl",
    });
  });

  it("never writes two flushes to one key, even in the same millisecond", async () => {
    const flusher = flusherWith();
    observe.emit({ type: "wake.kicked", id: "one" });
    await flusher.flush();
    observe.emit({ type: "wake.kicked", id: "two" });
    await flusher.flush();

    expect(await store.list("_scafo/observe/")).toHaveLength(2);
    expect(eventRecords(await written())).toHaveLength(2);
  });
});

describe("the encoder seam", () => {
  it("round-trips every record through JSON.parse, one per line", () => {
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
        type: "wake.admitted",
        id: "aaaa",
        host: `shop.${DOMAIN}`,
        kind: "environment",
        project: "shop",
        env: "production",
        inFlight: 1,
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

    const encoded = JSONL_CODEC.encode(records);

    expect(encoded.extension).toBe("jsonl");
    const text = new TextDecoder().decode(encoded.bytes);
    /* One record per line, and a trailing newline so concatenation cannot merge
       the last record of one file into the first of the next. */
    expect(text.endsWith("\n")).toBe(true);
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(records);
    expect(JSONL_CODEC.decode(encoded.bytes)).toEqual({ records, malformed: 0 });
  });

  it("skips and counts what is not a record, keeping what is", () => {
    const good = JSON.stringify({
      v: 1,
      record: "event",
      node: NODE,
      at: new Date(CLOCK_START_MS).toISOString(),
      type: "wake.kicked",
      id: "aaaa",
    });
    const lines = [
      good,
      "{ not json",
      JSON.stringify({ record: "event", node: NODE }),
      JSON.stringify({
        record: "invented",
        node: NODE,
        at: new Date(CLOCK_START_MS).toISOString(),
      }),
      JSON.stringify([1, 2, 3]),
      "",
      good,
    ].join("\n");

    const decoded = JSONL_CODEC.decode(new TextEncoder().encode(lines));

    expect(decoded.records).toHaveLength(2);
    expect(decoded.malformed).toBe(4);
  });

  it("encodes an empty set as an empty file rather than a blank line", () => {
    expect(JSONL_CODEC.encode([]).bytes).toHaveLength(0);
    expect(JSONL_CODEC.decode(new Uint8Array())).toEqual({ records: [], malformed: 0 });
  });
});

describe("the cadence", () => {
  it("flushes on the interval and not before it", async () => {
    const flusher = flusherWith({ intervalMs: 60_000, drainIntervalMs: 5_000 });
    flusher.start();
    observe.emit({ type: "wake.kicked", id: "aaaa" });

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
      observe.emit({ type: "wake.kicked", id: String(index) });
    /* Well inside the interval: the size bound is the other trigger, and it is
       what keeps a busy node's ring from overflowing between flushes. */
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
      observe.emit({ type: "wake.kicked", id: `round-${String(round)}` });
      clock.tick(5_000);
      await flusher.tick();
    }
    clock.tick(60_000);
    await flusher.tick();

    /* Four events through a ring of two, and none of them lost: the drain ran
       between the flushes even though no flush was due. */
    expect(eventRecords(await written())).toHaveLength(4);
    expect(flushRecords(await written())[0].ringDropped).toBe(0);
  });

  it("does not keep the process alive", () => {
    const flusher = flusherWith();
    flusher.start();
    /* The same rule every other loop on the node follows: a timer that held the
       event loop open would stop `scafo up` from ever exiting. */
    expect(() => flusher.stop()).not.toThrow();
  });
});

describe("a flush that does not land", () => {
  it("keeps the events for the next attempt rather than losing them", async () => {
    const faults = new FaultStore(store);
    const flusher = flusherWith({}, faults);
    observe.emit({ type: "wake.kicked", id: "one" });

    faults.failAfter(0);
    expect(await flusher.flush()).toBe(false);
    expect(flusher.status().pending).toBe(1);

    observe.emit({ type: "wake.kicked", id: "two" });
    faults.clearFaults();
    expect(await flusher.flush()).toBe(true);

    /* Both of them, in order: the failed attempt held the first back rather than
       dropping it, and the retry carried it out with the second. */
    expect(eventRecords(await written()).map((record) => record.at)).toHaveLength(2);
    expect(flusher.status().pending).toBe(0);
    expect(flusher.status().lastFailure).toBeNull();
  });

  it("retries at the flush cadence, never at the drain one", async () => {
    const faults = new FaultStore(store);
    /* Counted before the fault is spent, because a put that threw is still an
       attempt and it is attempts this case is about. */
    let attempts = 0;
    faults.onBeforePut = (): void => {
      attempts++;
    };
    const flusher = flusherWith({ intervalMs: 60_000, drainIntervalMs: 5_000 }, faults);
    flusher.start();
    faults.failAfter(0);
    observe.emit({ type: "wake.kicked", id: "one" });

    clock.tick(60_000);
    await flusher.tick();
    expect(attempts).toBe(1);

    /* Two drains later and still inside the interval: a bucket that is down must
       not be hammered every five seconds for as long as it is. */
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
      observe.emit({ type: "wake.kicked", id: `id-${String(index)}` });
      await flusher.flush();
    }

    expect(flusher.status().pending).toBe(3);
    expect(flusher.status().pendingDropped).toBe(3);

    faults.clearFaults();
    await flusher.flush();

    const records = eventRecords(await written());
    /* The three newest survived, the three oldest were dropped, and the header
       says how many — a bucket that never comes back must not take the node's
       memory with it, and it must not do so silently either. */
    expect(records.map((record) => ("id" in record ? record.id : ""))).toEqual([
      "id-3",
      "id-4",
      "id-5",
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

    /* One record, holding the total as it stands now. Counters are monotonic, so
       the lost snapshot is superseded rather than missed. */
    const records = counterRecords(await written());
    expect(records).toHaveLength(1);
    expect(records[0].requests).toBe(2);
  });
});

describe("retention", () => {
  beforeEach(async () => {
    /* A day of this node's own history, plus another node's, written by hand at
       the keys a flusher would have used. */
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
    /* The other node's whole history is untouched, including the parts this one
       would have swept: a node only ever sweeps its own segment. */
    expect(await store.list("_scafo/observe/node-b/")).toHaveLength(4);
    expect(await store.list(`_scafo/observe/${NODE}/`)).toHaveLength(2);
  });

  it("stops at the cap and leaves the rest for the next sweep", async () => {
    const flusher = flusherWith({ retentionDays: OBSERVE_RETENTION_DAYS, sweepMaxDeletes: 1 });

    expect(await flusher.sweep()).toHaveLength(1);
    expect(await store.list(`_scafo/observe/${NODE}/`)).toHaveLength(3);

    expect(await flusher.sweep()).toHaveLength(1);
    expect(await store.list(`_scafo/observe/${NODE}/`)).toHaveLength(2);
    /* And nothing more: what is left is inside the window. */
    expect(await flusher.sweep()).toEqual([]);
  });

  it("runs on the flush cadence rather than on every flush", async () => {
    const flusher = flusherWith({ sweepEveryFlushes: 3 });

    /* The first flush sweeps, so a node coming back from a long stop cleans up
       without waiting an hour for it. */
    observe.emit({ type: "wake.kicked", id: "one" });
    await flusher.flush();
    expect(flusher.status().swept).toBe(2);

    for (const id of ["two", "three"]) {
      observe.emit({ type: "wake.kicked", id });
      clock.tick(1);
      await flusher.flush();
    }
    /* Two more flushes, no more sweeps: the listing is the cost, and it is why
       the cadence is slow. */
    expect(flusher.status().swept).toBe(2);
  });

  it("never throws a sweep out at the caller", async () => {
    const faults = new FaultStore(store);
    faults.failAfter(0);
    const flusher = flusherWith({}, faults);

    await expect(flusher.sweep()).resolves.toEqual([]);
  });
});

/* ------------------------------------------------------------------ helpers */

/** The key a flush of `node` at `at` would have landed at. */
function observeKeyFor(node: string, at: Date): string {
  const day = [
    String(at.getUTCFullYear()).padStart(4, "0"),
    String(at.getUTCMonth() + 1).padStart(2, "0"),
    String(at.getUTCDate()).padStart(2, "0"),
    String(at.getUTCHours()).padStart(2, "0"),
  ].join("/");
  return `_scafo/observe/${node}/${day}/${String(at.getTime())}-000001.jsonl`;
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
