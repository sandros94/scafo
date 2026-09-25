/*
 * Celld's own node leases, as `scafo app lease` reads and drops them: what the
 * three reads of one key add up to, what a live lease refuses, and the release
 * gate the whole command sits behind.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { VERIFIED_CELLD_RELEASES } from "../src/core/registry/_celld-contract.ts";
import {
  type CelldLeaseReading,
  dropCelldLease,
  inspectCelldLeases,
  planLeaseDrop,
} from "../src/core/registry/celld-lease.ts";
import { createApplication } from "../src/core/registry/index.ts";
import { NODE_LIVENESS_WINDOW_MS } from "../src/core/registry/nodes.ts";
import {
  celldNodeLeaseKey,
  celldNodesPrefix,
  nodeKey,
  parseCelldNodeLeaseKey,
} from "../src/core/registry/paths.ts";
import type { CasStore, StoredHead, StoredObject } from "../src/core/types/store.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith, TEST_VERSIONS } from "./_helpers.ts";

const APPLICATION = "shop";
const NODE = "node-a";
/** The one scafo node of the fixture installation; the release gate reads its record. */
const SCAFO_NODE = "node-a";
const VERIFIED = VERIFIED_CELLD_RELEASES[0];
const MINUTE_MS = 60_000;

/** The key the incident wedged on, and the only key any of this touches. */
const LEASE_KEY = celldNodeLeaseKey(APPLICATION, NODE);

let inner: MemoryCasStore;
let store: BrokenStore;
let clock: ManualClock;

beforeEach(async () => {
  inner = new MemoryCasStore({ now: (): Date => new Date(clock.nowMs()) });
  store = new BrokenStore(inner);
  clock = ctxWith(store);

  await createApplication(clock.ctx, { name: APPLICATION });
  await answeringNode();
});

describe("the verdict the three reads add up to", () => {
  it("calls a readable lease whose expiry is ahead held", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });

    const reading = await readOne();

    expect(reading.verdict).toBe("held");
    expect(reading.why).toContain("runs until");
    expect(reading.expiresAt).toBe(new Date(clock.nowMs() + 30_000).toISOString());
    expect(reading.listed.present).toBe(true);
    expect(reading.head.present).toBe(true);
    expect(reading.get.present).toBe(true);
  });

  it("calls the same lease expired once its own expiry has passed", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    clock.tick(31_000);

    const reading = await readOne();

    expect(reading.verdict).toBe("expired");
    expect(reading.why).toContain("ran out at");
  });

  it("calls a lease unreadable when LIST and HEAD answer and GET is a 404", async () => {
    /* The incident itself: the bucket names the key in a listing, answers a
       HEAD for it, and answers no GET of it, so the process can neither read
       its lease nor create one. */
    await putLease(NODE, { expiresInMs: 30_000 });
    store.swallowGet(LEASE_KEY);

    const reading = await readOne();

    expect(reading.verdict).toBe("unreadable");
    expect(reading.listed.present).toBe(true);
    expect(reading.head.present).toBe(true);
    expect(reading.get.present).toBe(false);
    expect(reading.why).toContain("the listing names it");
    expect(reading.why).toContain("a HEAD of it answers");
    expect(reading.why).toContain("a GET of it says it is not there");
  });

  it("calls it unreadable when the GET raises instead of answering, and says what it raised", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    store.failGet(LEASE_KEY, new ScafoError("store-unavailable", "Store did not answer"));

    const reading = await readOne();

    expect(reading.verdict).toBe("unreadable");
    expect(reading.get.error).toContain("Store did not answer");
    expect(reading.why).toContain("a GET of it fails");
  });

  it("calls a body that is no node lease unreadable, whatever else answers", async () => {
    await store.put(LEASE_KEY, JSON.stringify({ hello: "world" }));

    const reading = await readOne();

    expect(reading.verdict).toBe("unreadable");
    expect(reading.why).toContain("is not a node lease");
  });

  it("calls a body that is not JSON at all unreadable", async () => {
    await store.put(LEASE_KEY, '<?xml version="1.0"?><Error/>');

    expect((await readOne()).verdict).toBe("unreadable");
  });

  it("calls a key nothing sees absent", async () => {
    const reading = await readOne();

    expect(reading.verdict).toBe("absent");
    expect(reading.listed.present).toBe(false);
    expect(reading.head.present).toBe(false);
    expect(reading.get.present).toBe(false);
  });

  it("reports what each read said about the object, and not one of them for the others", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });

    const reading = await readOne();

    expect(reading.listed.size).toBeGreaterThan(0);
    expect(reading.listed.etag).toBeDefined();
    expect(reading.listed.lastModified).toBe(new Date(clock.nowMs()).toISOString());
    expect(reading.head.size).toBe(reading.listed.size);
    expect(reading.head.etag).toBe(reading.listed.etag);
    expect(reading.get.size).toBe(reading.listed.size);
  });

  it("names the node a record claims when it is not the node it is filed under", async () => {
    await putLease(NODE, { expiresInMs: 30_000, node: "someone-else" });

    const reading = await readOne();

    expect(reading.recordNode).toBe("someone-else");
    expect(reading.why).toContain("someone-else");
    /* Upstream's reaper only collects a record whose own name matches its key,
       so this one is a lease nothing of Celld's will ever tidy away. */
    expect(reading.why).toContain("reaper");
  });
});

describe("reading a whole fleet's leases", () => {
  it("answers one reading per lease the prefix holds, sorted by node", async () => {
    await putLease("node-c", { expiresInMs: 30_000 });
    await putLease("node-a", { expiresInMs: 30_000 });
    await putLease("node-b", { expiresInMs: -30_000 });

    const readings = await inspectCelldLeases(clock.ctx, {
      application: APPLICATION,
      now: new Date(clock.nowMs()),
    });

    expect(readings.map((one) => one.node)).toEqual(["node-a", "node-b", "node-c"]);
    expect(readings.map((one) => one.verdict)).toEqual(["held", "expired", "held"]);
  });

  it("leaves alone anything under the prefix that is not a lease key", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    await store.put(`${celldNodesPrefix(APPLICATION)}not-a-lease.txt`, "hello");
    await store.put(`${celldNodesPrefix(APPLICATION)}deeper/one.json`, "{}");

    const readings = await inspectCelldLeases(clock.ctx, {
      application: APPLICATION,
      now: new Date(clock.nowMs()),
    });

    expect(readings.map((one) => one.key)).toEqual([LEASE_KEY]);
  });

  it("answers a reading for a named node even when nothing has ever written it", async () => {
    const readings = await inspectCelldLeases(clock.ctx, {
      application: APPLICATION,
      node: "node-never",
      now: new Date(clock.nowMs()),
    });

    expect(readings).toHaveLength(1);
    expect(readings[0]?.verdict).toBe("absent");
  });

  it("refuses a node name Celld itself would not admit, before anything is read", async () => {
    const error = await rejectsWith(
      () =>
        inspectCelldLeases(clock.ctx, {
          application: APPLICATION,
          node: "../../escape",
          now: new Date(clock.nowMs()),
        }),
      "invalid-slug",
    );

    expect(error.detail).toContain("../../escape");
  });

  it("admits a node Celld named itself, which is wider than the ids scafo mints", async () => {
    await putLease("celld.Node_7", { expiresInMs: 30_000 });

    const readings = await inspectCelldLeases(clock.ctx, {
      application: APPLICATION,
      node: "celld.Node_7",
      now: new Date(clock.nowMs()),
    });

    expect(readings[0]?.verdict).toBe("held");
  });
});

describe("dropping one lease", () => {
  it("refuses a held lease and deletes nothing", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    const before = await readOne();

    const error = await rejectsWith(
      () => dropCelldLease(clock.ctx, before, { now: new Date(clock.nowMs()) }),
      "reference-held",
    );

    expect(error.detail).toContain(LEASE_KEY);
    expect(error.detail).toContain("--force");
    expect(await store.get(LEASE_KEY)).not.toBeNull();
  });

  it("deletes a held lease when the operator forces it", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    const before = await readOne();

    const done = await dropCelldLease(clock.ctx, before, {
      now: new Date(clock.nowMs()),
      force: true,
    });

    expect(done.deleted).toBe(true);
    expect(done.stillThere).toBe(false);
    expect(await store.get(LEASE_KEY)).toBeNull();
  });

  it("deletes an expired lease without being forced, and reads the key back", async () => {
    await putLease(NODE, { expiresInMs: -MINUTE_MS });
    const before = await readOne();

    const done = await dropCelldLease(clock.ctx, before, { now: new Date(clock.nowMs()) });

    expect(done.before.verdict).toBe("expired");
    expect(done.after.verdict).toBe("absent");
    expect(done.stillThere).toBe(false);
  });

  it("deletes the unreadable object the incident wedged on", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    store.swallowGet(LEASE_KEY);
    const before = await readOne();

    const done = await dropCelldLease(clock.ctx, before, { now: new Date(clock.nowMs()) });

    expect(before.verdict).toBe("unreadable");
    expect(done.deleted).toBe(true);
    expect(done.stillThere).toBe(false);
    expect(await inner.get(LEASE_KEY)).toBeNull();
  });

  it("says so plainly when the store still names the key after the deletion", async () => {
    await putLease(NODE, { expiresInMs: -MINUTE_MS });
    const before = await readOne();
    store.swallowDelete(LEASE_KEY);

    const done = await dropCelldLease(clock.ctx, before, { now: new Date(clock.nowMs()) });

    expect(done.deleted).toBe(true);
    expect(done.stillThere).toBe(true);
    expect(done.after.verdict).toBe("expired");
  });

  it("deletes nothing at all when there is nothing there", async () => {
    const before = await readOne();

    const done = await dropCelldLease(clock.ctx, before, { now: new Date(clock.nowMs()) });

    expect(before.verdict).toBe("absent");
    expect(done.deleted).toBe(false);
    expect(store.dels).toEqual([]);
  });

  it("touches no other lease of the same fleet", async () => {
    await putLease(NODE, { expiresInMs: -MINUTE_MS });
    await putLease("node-b", { expiresInMs: 30_000 });
    await putLease("node-c", { expiresInMs: -MINUTE_MS });

    await dropCelldLease(clock.ctx, await readOne(), { now: new Date(clock.nowMs()) });

    expect(store.dels).toEqual([LEASE_KEY]);
    expect(await inner.list(celldNodesPrefix(APPLICATION))).toEqual([
      celldNodeLeaseKey(APPLICATION, "node-b"),
      celldNodeLeaseKey(APPLICATION, "node-c"),
    ]);
  });
});

/*
 * The pin, which is prune's own gate: this command reads and deletes inside
 * Celld's keyspace, so nothing is read at all unless the installation answers
 * on a release this build was verified against.
 */
describe("the Celld release the installation is answering on", () => {
  it("refuses when no node of the installation is answering at all", async () => {
    await store.del(nodeKey(SCAFO_NODE));

    const error = await rejectsWith(() => readOne(), "capability-missing");

    expect(error.detail).toContain("no node of this installation is answering");
    expect(error.detail).toContain(VERIFIED);
    expect(error.detail).toContain("scafo app lease");
  });

  it("refuses an answering node running a release this was never verified on", async () => {
    await answeringNode({ celld: "0.4.1" });

    const error = await rejectsWith(() => readOne(), "capability-missing");

    expect(error.detail).toContain("celld 0.4.1");
    expect(error.detail).toContain("nothing was planned or deleted");
  });

  it("ignores the record of a machine that stopped answering on an old release", async () => {
    await answeringNode({
      id: "node-retired",
      celld: "0.4.1",
      beatAgoMs: NODE_LIVENESS_WINDOW_MS,
    });
    await putLease(NODE, { expiresInMs: 30_000 });

    expect((await readOne()).verdict).toBe("held");
  });

  it("refuses before it reads a key, so a plan of a drop is refused by the same gate", async () => {
    await putLease(NODE, { expiresInMs: 30_000 });
    await answeringNode({ celld: "0.4.1" });

    const error = await rejectsWith(
      () =>
        planLeaseDrop(clock.ctx, {
          application: APPLICATION,
          node: NODE,
          now: new Date(clock.nowMs()),
        }),
      "capability-missing",
    );

    expect(error.detail).not.toContain(LEASE_KEY);
    /* The gate reads the node records and stops: nothing of Celld's was read. */
    expect(store.gets.filter((key) => key.startsWith("fleets/"))).toEqual([]);
  });
});

describe("the key the leases live under", () => {
  it("is Celld's own, one node at a time, and never reaches a sibling fleet", () => {
    expect(LEASE_KEY).toBe("fleets/shop/nodes/node-a.json");
    expect(celldNodesPrefix("shop")).toBe("fleets/shop/nodes/");
    expect(celldNodesPrefix("shop")).not.toBe(celldNodesPrefix("shop-preview"));
  });

  it("reads back only the keys it would have written", () => {
    expect(parseCelldNodeLeaseKey("shop", LEASE_KEY)).toBe("node-a");
    expect(parseCelldNodeLeaseKey("shop", "fleets/shop/nodes/a/b.json")).toBeNull();
    expect(parseCelldNodeLeaseKey("shop", "fleets/shop/nodes/x.txt")).toBeNull();
    expect(parseCelldNodeLeaseKey("shop", "fleets/shop-preview/nodes/x.json")).toBeNull();
  });
});

/* ------------------------------------------------------------------ fixtures */

/** The one node's lease, read and judged against the test's own clock. */
async function readOne(node: string = NODE): Promise<CelldLeaseReading> {
  return planLeaseDrop(clock.ctx, {
    application: APPLICATION,
    node,
    now: new Date(clock.nowMs()),
  });
}

/**
 * One node lease exactly as Celld writes one: the two fields it requires, plus
 * the ones every release fills in beside them.
 */
async function putLease(node: string, opts: { expiresInMs: number; node?: string }): Promise<void> {
  await store.put(
    celldNodeLeaseKey(APPLICATION, node),
    JSON.stringify({
      node: opts.node ?? node,
      expires_ms: clock.nowMs() + opts.expiresInMs,
      addr: "127.0.0.1:9000",
      probe_public_key: "fixture",
      peer_protocol: 1,
      paced_handoff: true,
      ownership_index_generation: "fixture",
    }),
  );
}

/** A scafo node record, which is the only thing that says which Celld wrote this bucket. */
async function answeringNode(
  opts: { id?: string; celld?: string | null; beatAgoMs?: number } = {},
): Promise<void> {
  const id = opts.id ?? SCAFO_NODE;
  const celld = opts.celld === undefined ? VERIFIED : opts.celld;

  await store.put(
    nodeKey(id),
    JSON.stringify({
      v: 1,
      id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "fixture" },
      addresses: { internal: "127.0.0.1", apiPort: 7400 },
      heartbeatAt: new Date(clock.nowMs() - (opts.beatAgoMs ?? 0)).toISOString(),
      ...(celld === null ? {} : { versions: { ...TEST_VERSIONS, celld } }),
    }),
  );
}

/**
 * A store that can answer for a key it will not hand over, which is the failure
 * this whole command exists for and which no honest store reproduces.
 */
class BrokenStore implements CasStore {
  /** Keys read through `get`, in order, so a test can prove nothing was read. */
  gets: string[] = [];
  /** Keys deleted, in order: the proof that one deletion touched one key. */
  dels: string[] = [];

  readonly #inner: CasStore;
  readonly #swallowed = new Set<string>();
  readonly #failed = new Map<string, Error>();
  readonly #undeletable = new Set<string>();

  constructor(inner: CasStore) {
    this.#inner = inner;
  }

  /** Answers a 404 for `key` on `get`, while LIST and HEAD go on naming it. */
  swallowGet(key: string): void {
    this.#swallowed.add(key);
  }

  /** Raises `error` on every `get` of `key`. */
  failGet(key: string, error: Error): void {
    this.#failed.set(key, error);
  }

  /** Takes a delete of `key` and keeps the object anyway. */
  swallowDelete(key: string): void {
    this.#undeletable.add(key);
  }

  get(key: string): Promise<StoredObject | null> {
    this.gets.push(key);
    const failure = this.#failed.get(key);
    if (failure !== undefined) return Promise.reject(failure);
    if (this.#swallowed.has(key)) return Promise.resolve(null);
    return this.#inner.get(key);
  }

  getBytes(key: string, opts?: Parameters<CasStore["getBytes"]>[1]): Promise<Uint8Array | null> {
    return this.#inner.getBytes(key, opts);
  }

  head(key: string): Promise<StoredHead | null> {
    return this.#inner.head(key);
  }

  put(
    key: string,
    body: string | Uint8Array,
    cas?: Parameters<CasStore["put"]>[2],
  ): Promise<{ etag: string }> {
    return this.#inner.put(key, body, cas);
  }

  async del(key: string): Promise<void> {
    this.dels.push(key);
    if (this.#undeletable.has(key)) return;
    await this.#inner.del(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }

  listEntries(prefix: string): ReturnType<CasStore["listEntries"]> {
    return this.#inner.listEntries(prefix);
  }
}
