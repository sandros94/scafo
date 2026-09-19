/*
 * The registry view, and the pure decisions under it: what a listing says has to
 * be read, which kinds are due, and what an idle pass costs.
 *
 * The costs are asserted through a counting store, because "an unchanged pass
 * reads nothing" is the whole point of the view and prose cannot hold it.
 */

import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { diffListing, kindsDue, REGISTRY_KINDS } from "../src/core/registry/_cache.ts";
import { namesFromKeys } from "../src/core/registry/_shared.ts";
import { putJson } from "../src/core/registry/cas.ts";
import { writeChangeHint } from "../src/core/registry/changes.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { applicationKey, changesKey, nodeKey, placementKey } from "../src/core/registry/paths.ts";
import { createRegistryView, type RegistryView } from "../src/core/registry/view.ts";
import type { ApplicationRecord, NodeRecord, PlacementRecord } from "../src/core/types/registry.ts";
import type { CasStore, StoredEntry } from "../src/core/types/store.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";

/* ------------------------------------------------------------------- the pure half */

/** The name a `<prefix><name>.json` key belongs to, as the view reads one off. */
function nameOf(prefix: string): (key: string) => string | null {
  return (key) => namesFromKeys([key], prefix)[0] ?? null;
}

function entry(key: string, etag: string): StoredEntry {
  return { key, etag };
}

describe("holding a listing against a cache", () => {
  const prefix = "p/";
  const held = new Map([
    ["a", { etag: `"1"`, value: 1 }],
    ["b", { etag: `"2"`, value: 2 }],
  ]);

  it("asks for nothing when every ETag is the one it already holds", () => {
    const diff = diffListing(
      [entry("p/a.json", `"1"`), entry("p/b.json", `"2"`)],
      held,
      nameOf(prefix),
    );

    expect(diff.changed).toEqual([]);
    expect(diff.dropped).toEqual([]);
    expect(diff.unchanged).toEqual(["a", "b"]);
  });

  it("asks for exactly the records whose ETag moved", () => {
    const diff = diffListing(
      [entry("p/a.json", `"9"`), entry("p/b.json", `"2"`)],
      held,
      nameOf(prefix),
    );

    expect(diff.changed).toEqual(["a"]);
    expect(diff.unchanged).toEqual(["b"]);
  });

  it("asks for a record it has never seen", () => {
    const diff = diffListing(
      [entry("p/a.json", `"1"`), entry("p/b.json", `"2"`), entry("p/c.json", `"3"`)],
      held,
      nameOf(prefix),
    );

    expect(diff.changed).toEqual(["c"]);
  });

  it("drops what the listing no longer carries", () => {
    const diff = diffListing([entry("p/a.json", `"1"`)], held, nameOf(prefix));

    expect(diff.dropped).toEqual(["b"]);
    expect(diff.changed).toEqual([]);
  });

  it("ignores a key that is no record of this kind", () => {
    const diff = diffListing(
      [entry("p/a.json", `"1"`), entry("p/nested/x.json", `"7"`), entry("p/b.txt", `"8"`)],
      held,
      nameOf(prefix),
    );

    expect(diff.changed).toEqual([]);
    expect(diff.dropped).toEqual(["b"]);
  });
});

describe("deciding which kinds are due", () => {
  const base = {
    nowMs: 1000,
    hint: "aaaa",
    lastHint: "aaaa",
    lastResyncMs: 1000,
    lastNodesMs: 1000,
    resyncIntervalMs: 60_000,
    nodeRefreshIntervalMs: 30_000,
  };

  it("asks for everything before anything has ever been read", () => {
    expect(kindsDue({ ...base, lastResyncMs: null, lastNodesMs: null })).toEqual([
      ...REGISTRY_KINDS,
    ]);
  });

  it("asks for nothing while the token stands and no timer is up", () => {
    expect(kindsDue({ ...base, nowMs: 20_000 })).toEqual([]);
  });

  it("asks for every kind routing is decided from when the token moved", () => {
    /* The nodes among them: the token is opaque, and what a node serves is
       hinted explicitly because the fleet's routing is rendered from it. */
    expect(kindsDue({ ...base, nowMs: 20_000, hint: "bbbb" })).toEqual([...REGISTRY_KINDS]);
  });

  it("asks for every kind when a hint appears where there was none", () => {
    expect(kindsDue({ ...base, nowMs: 20_000, hint: "bbbb", lastHint: null })).toEqual([
      ...REGISTRY_KINDS,
    ]);
  });

  it("asks for the nodes on their own timer, because no write announces a death", () => {
    expect(kindsDue({ ...base, nowMs: 31_000 })).toEqual(["nodes"]);
  });

  it("asks for everything once the resync is due, whatever the token says", () => {
    expect(kindsDue({ ...base, nowMs: 61_000 })).toEqual([...REGISTRY_KINDS]);
  });
});

/* ------------------------------------------------------------------ the live view */

/** Every operation a view dispatched, so a pass's cost is an assertion. */
interface CountedStore extends CasStore {
  counts: { get: number; list: number; put: number; del: number };
  reset(): void;
  /** Made to fail every read, as an unreachable bucket does. */
  breaking: boolean;
}

function countingStore(inner: CasStore): CountedStore {
  const counts = { get: 0, list: 0, put: 0, del: 0 };
  const store: CountedStore = {
    counts,
    breaking: false,
    reset(): void {
      counts.get = 0;
      counts.list = 0;
      counts.put = 0;
      counts.del = 0;
    },
    get(key): Promise<ReturnType<CasStore["get"]> extends Promise<infer T> ? T : never> {
      counts.get++;
      if (store.breaking) return Promise.reject(new ScafoError("store-unavailable", "no answer"));
      return inner.get(key);
    },
    getBytes: (key, opts) => inner.getBytes(key, opts),
    put(key, body, cas): Promise<{ etag: string }> {
      counts.put++;
      return inner.put(key, body, cas);
    },
    del(key): Promise<void> {
      counts.del++;
      return inner.del(key);
    },
    list: (prefix) => inner.list(prefix),
    listEntries(prefix): Promise<StoredEntry[]> {
      counts.list++;
      if (store.breaking) return Promise.reject(new ScafoError("store-unavailable", "no answer"));
      return inner.listEntries(prefix);
    },
  };
  return store;
}

function applicationRecord(name: string, revision: number): ApplicationRecord {
  return {
    v: 1,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    deployment: { revision, deployedAt: "2026-01-01T00:00:00.000Z" },
    domains: [],
  };
}

function placementRecord(nodes: string[]): PlacementRecord {
  return { v: 1, nodes, decidedAt: "2026-01-01T00:00:00.000Z", fence: 1 };
}

function nodeRecord(id: string, heartbeatAt: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: id },
    addresses: { internal: "10.0.0.1", apiPort: 7400 },
    heartbeatAt,
  };
}

/** A seeded installation, a clock the test owns, and the view over both. */
async function world(): Promise<{
  store: CountedStore;
  ctx: RegistryContext;
  view: RegistryView;
  at: (ms: number) => void;
}> {
  const inner = new MemoryCasStore();
  const store = countingStore(inner);
  let nowMs = 1_000_000;
  const ctx: RegistryContext = { store, now: () => new Date(nowMs) };

  for (const name of ["a", "b"]) {
    await putJson(ctx, applicationKey(name), applicationRecord(name, 1));
    await putJson(ctx, placementKey(name), placementRecord(["node-1"]));
  }
  await putJson(ctx, nodeKey("node-1"), nodeRecord("node-1", new Date(nowMs).toISOString()));
  await writeChangeHint(store);

  const view = createRegistryView(ctx);
  return { store, ctx, view, at: (ms: number): void => void (nowMs = ms) };
}

describe("the registry view", () => {
  it("reads everything on its first sync, and nothing at all on the next", async () => {
    const { store, view, at } = await world();

    const first = await view.sync();
    expect(first.applications.map((record) => record.name)).toEqual(["a", "b"]);
    expect([...first.placements.keys()]).toEqual(["a", "b"]);
    expect(first.nodes.map((record) => record.id)).toEqual(["node-1"]);

    store.reset();
    at(1_005_000);
    await view.sync();

    /* The hint, and nothing else: no listing, no record read, no write. */
    expect(store.counts).toEqual({ get: 1, list: 0, put: 0, del: 0 });
  });

  it("reads back exactly the one record that changed", async () => {
    const { store, ctx, view, at } = await world();
    await view.sync();

    await putJson(ctx, applicationKey("a"), applicationRecord("a", 2));
    await writeChangeHint(store);
    store.reset();
    at(1_005_000);

    const snapshot = await view.sync();

    /* The hint, then a listing of every kind, then the one record that moved. */
    expect(store.counts.get).toBe(2);
    expect(store.counts.list).toBe(3);
    expect(snapshot.applications.find((record) => record.name === "a")?.deployment).toMatchObject({
      revision: 2,
    });
  });

  it("drops a record that has vanished", async () => {
    const { store, view, at } = await world();
    await view.sync();

    await store.del(applicationKey("b"));
    await writeChangeHint(store);
    at(1_005_000);

    const snapshot = await view.sync();
    expect(snapshot.applications.map((record) => record.name)).toEqual(["a"]);
  });

  it("keeps the snapshot it had when a refresh fails, and says so", async () => {
    const { store, view, at } = await world();
    const before = await view.sync();

    store.breaking = true;
    at(1_005_000);
    await expect(view.sync()).rejects.toMatchObject({ code: "store-unavailable" });

    /* Never "every application was removed": the last good answer still stands. */
    expect(view.current().applications.map((record) => record.name)).toEqual(
      before.applications.map((record) => record.name),
    );
  });

  it("looks again after a failure rather than believing it saw that token", async () => {
    const { store, ctx, view, at } = await world();
    await view.sync();

    await putJson(ctx, applicationKey("a"), applicationRecord("a", 2));
    await writeChangeHint(store);
    store.breaking = true;
    at(1_005_000);
    await expect(view.sync()).rejects.toMatchObject({ code: "store-unavailable" });

    store.breaking = false;
    at(1_010_000);
    const snapshot = await view.sync();
    expect(snapshot.applications.find((record) => record.name === "a")?.deployment).toMatchObject({
      revision: 2,
    });
  });

  it("re-reads everything once the resync interval has run out, unchanged or not", async () => {
    const { store, view, at } = await world();
    await view.sync();

    store.reset();
    at(1_061_000);
    await view.sync();

    /* Three listings and the hint; not one record, because not one had moved. */
    expect(store.counts.list).toBe(3);
    expect(store.counts.get).toBe(1);
  });

  it("re-reads the nodes on their own timer, and only the ones that beat", async () => {
    const { store, ctx, view, at } = await world();
    await view.sync();

    at(1_031_000);
    await putJson(ctx, nodeKey("node-1"), nodeRecord("node-1", new Date(1_031_000).toISOString()));
    store.reset();
    await view.sync();

    expect(store.counts.list).toBe(1);
    /* The hint plus the one node record whose heartbeat moved. */
    expect(store.counts.get).toBe(2);
    expect(view.current().nodes[0]?.heartbeatAt).toBe(new Date(1_031_000).toISOString());
  });

  it("answers the skew gate from the view while the nodes are young enough", async () => {
    const { store, view, at } = await world();
    await view.sync();

    store.reset();
    at(1_020_000);
    await expect(view.freshNodes()).resolves.toHaveLength(1);
    expect(store.counts).toEqual({ get: 0, list: 0, put: 0, del: 0 });

    at(1_031_000);
    await view.freshNodes();
    expect(store.counts.list).toBe(1);
  });

  it("mints a token for the changes no write of its own carries", async () => {
    const { store, ctx, view } = await world();
    const before = (await store.get(changesKey()))?.body;

    await view.hint();

    expect((await store.get(changesKey()))?.body).not.toBe(before);
    expect(ctx.store).toBe(store);
  });
});
