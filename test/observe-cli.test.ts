/*
 * `scafo metrics` and `scafo traces`: what they read out of a bucket, what they make of it, and
 * what they say when there is nothing there.
 */

import { createWriter } from "tavolato";
import type { SyncParquetWriter } from "tavolato";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ObserveCountersRecord,
  type ObserveEventRecord,
  type ObserveRecord,
  OBSERVE_RECORD_VERSION,
} from "../src/daemon/observe-records.ts";
import {
  OBSERVE_PARQUET_EXTENSION,
  OBSERVE_PARQUET_SCHEMA,
  OBSERVE_PARQUET_WRITER_CODEC,
  observeParquetRow,
  PARQUET_CODEC,
} from "../src/daemon/observe-parquet.ts";
import {
  bandAt,
  formatMetrics,
  type MetricsNaming,
  noCounters,
  projectsCounted,
  summarizeMetrics,
  UNMATCHED,
} from "../src/cli/_metrics.ts";
import {
  nothingRecorded,
  OBSERVE_READ_SLACK_MS,
  parseSince,
  readObservations,
  windowFrom,
} from "../src/cli/_observe-read.ts";
import { formatTraces, selectTraces } from "../src/cli/_traces.ts";
import { readMetricsNaming } from "../src/cli/_metrics-names.ts";
import { traces } from "../src/cli/commands/traces.ts";
import { createBuild, createEnvironment, createProject } from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { observeKey } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { CLOCK_START_MS, rejectsWith } from "./_helpers.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** A build id as the runtime hands them out: lowercase hex, and not a name. */
const BUILD = "b1b1b1b1c2c2c2c2";

let store: MemoryCasStore;
let registry: RegistryContext;
let sequence: number;

beforeEach(() => {
  store = new MemoryCasStore();
  registry = { store };
  sequence = 0;
});

/** Writes one flush file exactly where and how the flusher would have. */
async function seed(node: string, atMs: number, records: ObserveRecord[]): Promise<string> {
  sequence++;
  const encoded = PARQUET_CODEC.encode(records);
  const key = observeKey(node, new Date(atMs), sequence, encoded.extension);
  await store.put(key, encoded.bytes);
  return key;
}

function counters(
  node: string,
  atMs: number,
  opts: {
    project: string;
    env: string;
    sinceMs?: number;
    requests: number;
    bytes: number;
    status?: Partial<ObserveCountersRecord["status"]>;
    durations?: number[];
  },
): ObserveCountersRecord {
  return {
    v: OBSERVE_RECORD_VERSION,
    record: "counters",
    node,
    at: new Date(atMs).toISOString(),
    since: new Date(opts.sinceMs ?? CLOCK_START_MS - 5 * HOUR_MS).toISOString(),
    project: opts.project,
    env: opts.env,
    requests: opts.requests,
    bytes: opts.bytes,
    status: { "2xx": opts.requests, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0, ...opts.status },
    durations: opts.durations ?? [opts.requests, 0, 0, 0, 0, 0, 0],
  };
}

function event(node: string, atMs: number, body: Record<string, unknown>): ObserveEventRecord {
  return {
    v: OBSERVE_RECORD_VERSION,
    record: "event",
    node,
    at: new Date(atMs).toISOString(),
    ...body,
  } as ObserveEventRecord;
}

describe("what a window reads", () => {
  it("takes the records inside it and leaves the rest, oldest first", async () => {
    await seed("node-a", CLOCK_START_MS - 2 * HOUR_MS, [
      event("node-a", CLOCK_START_MS - 2 * HOUR_MS, {
        type: "runtime.started",
        processId: "shop--old",
      }),
    ]);
    await seed("node-a", CLOCK_START_MS - 10 * MINUTE_MS, [
      event("node-a", CLOCK_START_MS - 10 * MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--inside",
      }),
    ]);

    const window = { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS };
    const found = await readObservations(registry, { window });

    expect(found.records.map((record) => ("processId" in record ? record.processId : ""))).toEqual([
      "shop--inside",
    ]);
    /* The nodes are reported whatever the window said, so an empty answer can
       tell "nobody ever wrote" from "nobody wrote lately". */
    expect(found.nodes).toEqual(["node-a"]);
  });

  it("reads a file written after the window, because its records may predate it", async () => {
    /* A flush that had to be retried carries events far older than its own key,
       which is why the upper bound is on the RECORD and never on the file. */
    await seed("node-a", CLOCK_START_MS + 30 * MINUTE_MS, [
      event("node-a", CLOCK_START_MS - 10 * MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--late-flush",
      }),
    ]);

    const window = { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS };
    const found = await readObservations(registry, { window });

    expect(found.records).toHaveLength(1);
  });

  it("skips a file written long before the window without reading it", async () => {
    const stale = await seed("node-a", CLOCK_START_MS - 2 * OBSERVE_READ_SLACK_MS - HOUR_MS, [
      event("node-a", CLOCK_START_MS - 30 * MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--impossible",
      }),
    ]);
    expect(stale).toContain("_scafo/observe/node-a/");

    const found = await readObservations(registry, {
      window: { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS },
    });

    expect(found.files).toBe(0);
    expect(found.records).toEqual([]);
  });

  it("interleaves two nodes by when things happened, not by how they were listed", async () => {
    await seed("node-b", CLOCK_START_MS, [
      event("node-b", CLOCK_START_MS - 5 * MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--b-second",
      }),
    ]);
    await seed("node-a", CLOCK_START_MS, [
      event("node-a", CLOCK_START_MS - 9 * MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--a-first",
      }),
    ]);

    const found = await readObservations(registry, {
      window: { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS },
    });

    expect(found.records.map((record) => record.node)).toEqual(["node-a", "node-b"]);
  });

  it("skips and counts the rows that are not records, keeping the file's good ones", async () => {
    const good = event("node-a", CLOCK_START_MS - MINUTE_MS, {
      type: "runtime.started",
      processId: "shop--kept",
    });
    const writer = createWriter(OBSERVE_PARQUET_SCHEMA, {
      codec: OBSERVE_PARQUET_WRITER_CODEC,
    }) as SyncParquetWriter;
    writer.appendAll([
      observeParquetRow(good),
      /* A record kind this build does not know: written through the same schema,
         which is the only way such a row can reach a reader at all. */
      { v: 1, record: "invented", node: "node-a", at: CLOCK_START_MS - MINUTE_MS },
    ]);
    const key = observeKey("node-a", new Date(CLOCK_START_MS), 1, OBSERVE_PARQUET_EXTENSION);
    await store.put(key, writer.finish());

    const found = await readObservations(registry, {
      window: { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS },
    });

    expect(found.records).toHaveLength(1);
    expect(found.malformed).toBe(1);
  });

  it("reports a file in an encoding it does not know instead of failing over it", async () => {
    await store.put(observeKey("node-a", new Date(CLOCK_START_MS), 1, "invented"), "who knows");

    const found = await readObservations(registry, {
      window: { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS },
    });

    expect(found.unreadable).toHaveLength(1);
    expect(found.files).toBe(0);
  });

  it("reports a file that is not what its name promised, and reads the rest", async () => {
    /* A half-written object, or something else at that key. One of them must not
       take the whole window with it. */
    await seed("node-a", CLOCK_START_MS, [
      event("node-a", CLOCK_START_MS - MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--kept",
      }),
    ]);
    await store.put(
      observeKey("node-a", new Date(CLOCK_START_MS), 99, OBSERVE_PARQUET_EXTENSION),
      "PAR1 and then some nonsense",
    );

    const found = await readObservations(registry, {
      window: { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS },
    });

    expect(found.unreadable).toHaveLength(1);
    expect(found.records).toHaveLength(1);
    expect(found.files).toBe(1);
  });
});

describe("--since", () => {
  it("reads a duration back from now", () => {
    expect(parseSince("90s", CLOCK_START_MS)).toBe(CLOCK_START_MS - 90_000);
    expect(parseSince("15m", CLOCK_START_MS)).toBe(CLOCK_START_MS - 15 * MINUTE_MS);
    expect(parseSince("1h", CLOCK_START_MS)).toBe(CLOCK_START_MS - HOUR_MS);
    expect(parseSince("7d", CLOCK_START_MS)).toBe(CLOCK_START_MS - 7 * 86_400_000);
  });

  it("reads an instant, for correlating with something that happened at one", () => {
    expect(parseSince("2026-01-01T00:00:00.000Z", CLOCK_START_MS)).toBe(CLOCK_START_MS);
  });

  it("defaults to the last hour", () => {
    expect(windowFrom(undefined, CLOCK_START_MS)).toEqual({
      sinceMs: CLOCK_START_MS - HOUR_MS,
      untilMs: CLOCK_START_MS,
    });
  });

  it("refuses what it cannot read rather than falling back to the default", async () => {
    /* A window that silently became the default would answer a question nobody
       asked, and read exactly like an empty one. */
    const error = await rejectsWith(
      () => Promise.resolve(parseSince("last tuesday", CLOCK_START_MS)),
      "invalid-input",
    );
    expect(error.detail).toContain("90s, 15m, 1h, 7d");
  });
});

describe("what the metrics come to", () => {
  const window = { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS };

  it("differences the first and last snapshot of the window", () => {
    const records: ObserveRecord[] = [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 100,
        bytes: 1000,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 460,
        bytes: 9000,
      }),
    ];

    const summary = summarizeMetrics(records, window);

    /* The totals are monotonic since that node booted; what happened IN the
       window is the difference and nothing else. */
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].requests).toBe(360);
    expect(summary.rows[0].bytes).toBe(8000);
  });

  it("adds up the nodes rather than differencing across them", () => {
    const records: ObserveRecord[] = [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 100,
        bytes: 10,
      }),
      counters("node-b", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 7000,
        bytes: 10,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 150,
        bytes: 20,
      }),
      counters("node-b", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 7020,
        bytes: 20,
      }),
    ];

    const summary = summarizeMetrics(records, window);

    expect(summary.rows[0].requests).toBe(70);
    expect(summary.rows[0].nodes).toEqual(["node-a", "node-b"]);
  });

  it("takes a node that restarted mid-window whole rather than going negative", () => {
    const records: ObserveRecord[] = [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        sinceMs: CLOCK_START_MS - 5 * HOUR_MS,
        requests: 9000,
        bytes: 90,
      }),
      /* Restarted: the totals went back to zero, and a subtraction against the
         old run's 9000 would report a negative number of requests. */
      counters("node-a", CLOCK_START_MS - 20 * MINUTE_MS, {
        project: "shop",
        env: "production",
        sinceMs: CLOCK_START_MS - 30 * MINUTE_MS,
        requests: 12,
        bytes: 12,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        sinceMs: CLOCK_START_MS - 30 * MINUTE_MS,
        requests: 40,
        bytes: 40,
      }),
    ];

    const summary = summarizeMetrics(records, window);

    /* The old run contributes nothing (one sample, nothing to difference), and
       the new one contributes everything it counted, because it started here. */
    expect(summary.rows[0].requests).toBe(40);
  });

  it("keeps the environments apart and totals them together", () => {
    const records: ObserveRecord[] = [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 0,
        bytes: 0,
      }),
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "preview",
        requests: 0,
        bytes: 0,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 300,
        bytes: 3000,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "preview",
        requests: 12,
        bytes: 120,
      }),
    ];

    const summary = summarizeMetrics(records, window);

    expect(summary.rows.map((row) => `${row.project}/${row.env}=${String(row.requests)}`)).toEqual([
      "shop/preview=12",
      "shop/production=300",
    ]);
    expect(summary.totals.requests).toBe(312);
  });

  it("narrows to one project and environment when asked", () => {
    const records: ObserveRecord[] = [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 0,
        bytes: 0,
      }),
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "blog",
        env: "production",
        requests: 0,
        bytes: 0,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 5,
        bytes: 5,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "blog",
        env: "production",
        requests: 900,
        bytes: 900,
      }),
    ];

    const summary = summarizeMetrics(records, window, { project: "shop", env: "production" });

    expect(summary.rows).toHaveLength(1);
    expect(summary.totals.requests).toBe(5);
  });

  it("summarizes the latency as the band a share of the requests finished inside", () => {
    /* 80 of a hundred inside 10ms and a long thin tail: the median lands in the
       first band, and the 95th only reaches the third. */
    expect(bandAt([80, 10, 5, 3, 1, 0, 1], 0.5)).toBe("<=10ms");
    expect(bandAt([80, 10, 5, 3, 1, 0, 1], 0.95)).toBe("<=100ms");
    expect(bandAt([0, 0, 0, 0, 0, 0, 4], 0.5)).toBe(">3s");
    expect(bandAt([0, 0, 0, 0, 0, 0, 0], 0.5)).toBe("-");
  });

  it("prints a table with a totals line under it", () => {
    const records: ObserveRecord[] = [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 0,
        bytes: 0,
        durations: [0, 0, 0, 0, 0, 0, 0],
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project: "shop",
        env: "production",
        requests: 12_480,
        bytes: 4_200_000,
        status: { "2xx": 12_310, "4xx": 160, "5xx": 10 },
        durations: [4000, 5000, 2000, 1200, 260, 19, 1],
      }),
    ];

    const table = formatMetrics(summarizeMetrics(records, window));
    const lines = table.split("\n");

    expect(lines[0].split(/\s+/)).toEqual([
      "PROJECT",
      "ENV",
      "REQUESTS",
      "BYTES",
      "2XX",
      "3XX",
      "4XX",
      "5XX",
      "P50",
      "P95",
    ]);
    expect(lines[1]).toContain("shop");
    expect(lines[1]).toContain("12480");
    expect(lines[1]).toContain("4.20 MB");
    expect(lines.at(-1)).toContain("TOTAL");
    /* A rule between the rows and the total, so a fleet with one environment
       cannot be misread as counting it twice. */
    expect(lines.at(-2)).toMatch(/^-+$/);
  });
});

describe("whose traffic a counted host actually was", () => {
  const window = { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS };

  /** What the registry holds, for the cases below to be read against. */
  const naming: MetricsNaming = {
    projects: new Set(["shop"]),
    environments: new Map([["shop", new Set(["production", "preview-7"])]]),
    builds: new Map([["shop", new Set([BUILD])]]),
  };

  it("reads a build's own host as the project it belongs to, never as an environment of it", () => {
    /* A node counts an unrouted `<project>--<ref>` host by the platform grammar,
       which cannot tell a build id from an environment name — so a build's hash
       host arrives here labelled as an environment called `<build id>`, which is
       an environment nobody ever made. */
    const records = run("shop", BUILD, 40, 140);

    const summary = summarizeMetrics(records, window, { naming });

    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].project).toBe("shop");
    expect(summary.rows[0].env).toBe(`(build ${BUILD.slice(0, 12)})`);
    expect(summary.rows[0].requests).toBe(100);
  });

  it("keeps an environment the registry really holds exactly as it was counted", () => {
    const summary = summarizeMetrics(run("shop", "preview-7", 5, 25), window, { naming });

    expect(summary.rows).toMatchObject([{ project: "shop", env: "preview-7", requests: 20 }]);
  });

  it("never invents a project out of a host nothing serves", () => {
    /* `wat.apps.test` parses as a project label perfectly well, and a scanner
       walking the platform domain produces a thousand of them. */
    const summary = summarizeMetrics(run("wat", "production", 0, 9), window, { naming });

    expect(summary.rows).toMatchObject([{ project: UNMATCHED, env: UNMATCHED, requests: 9 }]);
  });

  it("puts a real project's unknown ref under the same unmatched row", () => {
    const summary = summarizeMetrics(run("shop", "typo", 0, 3), window, { naming });

    expect(summary.rows).toMatchObject([{ project: UNMATCHED, env: UNMATCHED, requests: 3 }]);
  });

  it("gathers what the node could not attribute at all into that one row", () => {
    const records = [...run("-", "-", 0, 11), ...run("wat", "production", 0, 4)];

    const summary = summarizeMetrics(records, window, { naming });

    /* One row, whichever way a host failed to name something: an address, a
       domain this installation never minted, a label no project answers to. */
    expect(summary.rows).toMatchObject([{ project: UNMATCHED, env: UNMATCHED, requests: 15 }]);
  });

  it("filters on what a row turned out to be, not on what the counter wrote", () => {
    const records = [...run("shop", BUILD, 0, 60), ...run("wat", "production", 0, 4)];

    const summary = summarizeMetrics(records, window, { naming, project: "shop" });

    expect(summary.rows).toMatchObject([{ project: "shop", requests: 60 }]);
  });

  it("leaves every name alone when nothing was read back about them", () => {
    /* Without a registry to check against there is nothing to correct, and
       guessing would be exactly the failure this fixes. */
    const summary = summarizeMetrics(run("shop", BUILD, 0, 8), window);

    expect(summary.rows).toMatchObject([{ project: "shop", env: BUILD, requests: 8 }]);
  });

  it("reads back what the registry holds, for those projects and no others", async () => {
    await createProject(registry, { slug: "shop" });
    await createEnvironment(registry, "shop", { name: "production" });
    await createBuild(registry, "shop", {
      id: BUILD,
      celldVersionId: BUILD,
    });
    await createProject(registry, { slug: "untouched" });

    const read = await readMetricsNaming(registry, ["shop", "wat"]);

    expect(read.projects.has("shop")).toBe(true);
    /* A label under a platform domain that no project answers to. */
    expect(read.projects.has("wat")).toBe(false);
    expect([...(read.environments.get("shop") ?? [])]).toEqual(["production"]);
    expect([...(read.builds.get("shop") ?? [])]).toEqual([BUILD]);
    /* A project this window never counted costs no listing at all. */
    expect(read.environments.has("untouched")).toBe(false);
  });

  it("names the projects a window counted, so only those have to be read back", () => {
    const records = [
      ...run("shop", BUILD, 0, 1),
      ...run("-", "-", 0, 1),
      ...run("blog", "production", 0, 1),
    ];

    /* The unattributed bucket is not a project and is never looked up. */
    expect(projectsCounted(records)).toEqual(["blog", "shop"]);
  });

  /** One node's run of one `{project, env}`: a baseline in the window, and its end. */
  function run(project: string, env: string, from: number, to: number): ObserveRecord[] {
    return [
      counters("node-a", CLOCK_START_MS - 50 * MINUTE_MS, {
        project,
        env,
        requests: from,
        bytes: from * 10,
      }),
      counters("node-a", CLOCK_START_MS - 5 * MINUTE_MS, {
        project,
        env,
        requests: to,
        bytes: to * 10,
      }),
    ];
  }
});

describe("what the traces come to", () => {
  const window = { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS };

  /** What a node emits on its own timer while nothing at all is happening. */
  function passes(count: number): ObserveEventRecord[] {
    return Array.from({ length: count }, (_unused, index) =>
      event("node-a", CLOCK_START_MS - (count - index) * 5_000, {
        type: "reconcile.pass.end",
        actions: 0,
        failures: 0,
        storeOps: 6,
        listOps: 1,
        durationMs: 12,
      }),
    );
  }

  /** Non-periodic runtime events a default trace listing should retain. */
  function runtimeEvents(count: number, startMs: number): ObserveEventRecord[] {
    return Array.from({ length: count }, (_unused, index) =>
      event("node-a", startMs + index, {
        type: "runtime.started",
        processId: `shop--env-${String(index)}`,
      }),
    );
  }

  it("shows the newest when there are more than the limit, and says how many it left out", () => {
    const events = Array.from({ length: 10 }, (_unused, index) =>
      event("node-a", CLOCK_START_MS - (10 - index) * MINUTE_MS, {
        type: "runtime.started",
        processId: `shop--env-${String(index)}`,
      }),
    );

    const selection = selectTraces(events, { limit: 3 });

    expect(
      selection.events.map((record) => ("processId" in record ? record.processId : "")),
    ).toEqual(["shop--env-7", "shop--env-8", "shop--env-9"]);
    expect({ matched: selection.matched, omitted: selection.omitted }).toEqual({
      matched: 10,
      omitted: 7,
    });
  });

  it("finds a project directly and through a runtime process id", () => {
    const records: ObserveRecord[] = [
      event("node-a", CLOCK_START_MS - 10 * MINUTE_MS, {
        type: "project.blocked",
        actor: "op-aaaa1111",
        project: "shop",
      }),
      event("node-a", CLOCK_START_MS - 9 * MINUTE_MS, {
        type: "runtime.started",
        processId: "shop--production",
      }),
      event("node-a", CLOCK_START_MS - 8 * MINUTE_MS, {
        type: "runtime.started",
        processId: "blog--production",
      }),
      event("node-a", CLOCK_START_MS - 7 * MINUTE_MS, {
        type: "reconcile.pass.start",
        kicked: true,
      }),
    ];

    const selection = selectTraces(records, { project: "shop" });

    expect(selection.events).toHaveLength(2);
    expect(selection.events.every((record) => record.type !== "reconcile.pass.start")).toBe(true);
  });

  it("keeps only the selected project's placement pending events", () => {
    const own = event("node-a", CLOCK_START_MS - 2 * MINUTE_MS, {
      type: "placement.pending",
      project: "shop",
      env: "production",
      reason: "profile-unavailable",
    });
    const other = event("node-a", CLOCK_START_MS - MINUTE_MS, {
      type: "placement.pending",
      project: "blog",
      env: "production",
      reason: "placement-unavailable",
    });

    expect(selectTraces([own, other], { project: "shop" }).events).toEqual([own]);
  });

  it("leaves the reconcile loop's own passes out of a listing nobody narrowed", () => {
    /* A node reconciles every 5s whether or not anything is happening, so a
       window of any length is mostly this — and it is the one thing in the
       catalog nobody is ever debugging when they run `scafo traces` with no
       arguments at all. */
    const records = [...passes(40), ...runtimeEvents(5, CLOCK_START_MS - MINUTE_MS)];

    const selection = selectTraces(records);

    expect(selection.events.every((record) => !record.type.startsWith("reconcile."))).toBe(true);
    expect(selection.events).toHaveLength(5);
    expect({ matched: selection.matched, hidden: selection.hidden }).toEqual({
      matched: 5,
      hidden: 40,
    });
  });

  it("shows what an operator did to the fleet's own keys, in a listing nobody narrowed", () => {
    /* Only the reconcile loop is periodic. An audit line is the opposite of
       that — it is a thing a person did, once — so the default view is exactly
       where it has to appear. */
    const records = [
      ...passes(40),
      event("node-a", CLOCK_START_MS - MINUTE_MS, {
        type: "operator.trusted",
        actor: "op-aaaa1111",
        subject: "op-bbbb2222",
        role: "operator",
      }),
      event("node-a", CLOCK_START_MS, {
        type: "operator.revoked",
        actor: "op-aaaa1111",
        subject: "op-bbbb2222",
        role: "operator",
      }),
    ];

    const selection = selectTraces(records);

    expect(selection.events.map((record) => record.type)).toEqual([
      "operator.trusted",
      "operator.revoked",
    ]);
    expect(formatTraces(selection)).toContain(
      "actor=op-aaaa1111 subject=op-bbbb2222 role=operator",
    );
  });

  it("does not let the passes it hid take the window's room", () => {
    /* The trap the default is for: periodic passes must not consume the room
       reserved for operational events. */
    const records = [...passes(40), ...runtimeEvents(5, CLOCK_START_MS - MINUTE_MS)];

    const selection = selectTraces(records, { limit: 10 });

    expect(selection.events).toHaveLength(5);
    expect(selection.omitted).toBe(0);
  });

  it("shows them again when the caller asks for all of it", () => {
    const records = [...passes(40), ...runtimeEvents(5, CLOCK_START_MS - MINUTE_MS)];

    const selection = selectTraces(records, { all: true });

    expect(selection.matched).toBe(45);
    expect(selection.hidden).toBe(0);
  });

  it("takes --all as the way to see them", () => {
    /* The default hides events a node really did record, so the command has to
       carry the way back to them. */
    expect(traces.args).toHaveProperty("all");
  });

  it("renders every field an event carried, whatever the event is", () => {
    const rendered = formatTraces(
      selectTraces(
        [
          event("node-a", CLOCK_START_MS, {
            type: "reconcile.pass.end",
            actions: 2,
            failures: 0,
            storeOps: 17,
            listOps: 3,
            durationMs: 412,
          }),
        ],
        { all: true },
      ),
    );

    /* Derived rather than per-type, so an event variant added later prints its
       own fields rather than another variant's. */
    expect(rendered).toContain("reconcile.pass.end");
    expect(rendered).toContain("actions=2 failures=0 storeOps=17 listOps=3 durationMs=412");
    expect(rendered).toContain(new Date(CLOCK_START_MS).toISOString());
  });

  it("reads a seeded bucket end to end", async () => {
    await seed("node-a", CLOCK_START_MS, runtimeEvents(5, CLOCK_START_MS - 3 * MINUTE_MS));

    const found = await readObservations(registry, { window });
    const selection = selectTraces(found.records, { project: "shop" });

    expect(selection.events).toHaveLength(5);
    expect(formatTraces(selection)).toContain("shop--env-4");
  });
});

describe("nothing to show", () => {
  const window = { sinceMs: CLOCK_START_MS - HOUR_MS, untilMs: CLOCK_START_MS };

  it("names the switch when no node has ever written anything", async () => {
    const found = await readObservations(registry, { window });

    const said = nothingRecorded(found, window);
    expect(said).toContain("nothing recorded");
    expect(said).toContain("observability.enabled");
  });

  it("says the window is the problem when something was written outside it", async () => {
    await seed("node-a", CLOCK_START_MS - 10 * HOUR_MS, [
      event("node-a", CLOCK_START_MS - 10 * HOUR_MS, {
        type: "runtime.started",
        processId: "shop--old",
      }),
    ]);
    const found = await readObservations(registry, { window });

    const said = nothingRecorded(found, window);
    expect(said).toContain("nothing recorded since");
    expect(said).toContain("node-a");
    expect(said).toContain("--since");
  });

  it("names the access log when the nodes report on themselves but count nothing", () => {
    const records = [
      event("node-a", CLOCK_START_MS, {
        type: "runtime.started",
        processId: "shop--one",
      }),
    ];

    const said = noCounters(records);
    expect(said).toContain("nothing recorded");
    expect(said).toContain("observability.ingressAccessLog");
  });

  it("summarizes an empty window as no rows rather than as a failure", () => {
    const summary = summarizeMetrics([], window);

    expect({ rows: summary.rows, samples: summary.samples }).toEqual({ rows: [], samples: 0 });
    expect(summary.totals.requests).toBe(0);
  });
});
