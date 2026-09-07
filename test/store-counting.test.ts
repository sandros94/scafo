/* Counted-store operations and transparent store semantics. */

import { describe, expect, it } from "vitest";
import { createCountingStore, countingRegistry, storeOpsOf } from "../src/core/registry/index.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { rejectsWith } from "./_helpers.ts";

describe("what it counts", () => {
  it("counts each kind of operation apart from the others", async () => {
    const store = createCountingStore(new MemoryCasStore());

    await store.put("a.json", "{}");
    await store.put("b.json", "{}");
    await store.get("a.json");
    await store.list("");
    await store.del("b.json");
    await store.get("b.json");

    expect(store.counts()).toEqual({ get: 2, put: 2, del: 1, list: 1 });
    expect(storeOpsOf(store.counts())).toBe(5);
  });

  it("counts an operation that RAISED, because it cost a round trip all the same", async () => {
    const store = createCountingStore(new MemoryCasStore());
    await store.put("a.json", "{}");

    await rejectsWith(() => store.put("a.json", "{}", { ifNoneMatch: "*" }), "cas-conflict");

    expect(store.counts()).toEqual({ get: 0, put: 2, del: 0, list: 0 });
  });

  it("hands out a copy, so a baseline taken before some work survives it", async () => {
    const store = createCountingStore(new MemoryCasStore());

    const before = store.counts();
    await store.get("a.json");

    expect(before).toEqual({ get: 0, put: 0, del: 0, list: 0 });
    expect(store.counts().get).toBe(1);
    expect(storeOpsOf(store.counts()) - storeOpsOf(before)).toBe(1);
  });
});

describe("what it passes through", () => {
  it("answers exactly as the store under it does", async () => {
    const inner = new MemoryCasStore();
    const counted = createCountingStore(inner);

    const written = await counted.put("shop.json", `{"v":1}`);
    const read = await counted.get("shop.json");
    const missing = await counted.get("nothing.json");
    const listed = await counted.list("");

    expect(read).toEqual({ body: `{"v":1}`, etag: written.etag });
    expect(await inner.get("shop.json")).toEqual(read);
    expect(missing).toBeNull();
    expect(listed).toEqual(["shop.json"]);
  });

  it("keeps the conditional writes conditional, in both directions", async () => {
    const store = createCountingStore(new MemoryCasStore());

    const first = await store.put("shop.json", `{"v":1}`, { ifNoneMatch: "*" });
    await rejectsWith(
      () => store.put("shop.json", `{"v":2}`, { ifMatch: `"stale"` }),
      "cas-conflict",
    );
    const second = await store.put("shop.json", `{"v":2}`, { ifMatch: first.etag });

    expect((await store.get("shop.json"))?.body).toBe(`{"v":2}`);
    expect(second.etag).not.toBe(first.etag);
  });

  it("forwards a ranged read, and counts it as the one round trip it is", async () => {
    const store = createCountingStore(new MemoryCasStore());
    await store.put("obs.parquet", new Uint8Array([0, 1, 2, 3, 4]));

    const ranged = await store.getBytes("obs.parquet", { range: { start: 1, end: 3 } });

    expect(ranged).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.counts()).toEqual({ get: 1, put: 1, del: 0, list: 0 });
  });

  it("deletes through, and a delete of nothing is still not a failure", async () => {
    const store = createCountingStore(new MemoryCasStore());
    await store.put("shop.json", "{}");

    await store.del("shop.json");
    await store.del("shop.json");

    expect(await store.get("shop.json")).toBeNull();
    expect(store.counts().del).toBe(2);
  });
});

describe("the registry wrapping one", () => {
  it("carries the injected clock over, and counts what goes through it", async () => {
    const now = (): Date => new Date(0);
    const counted = countingRegistry({ store: new MemoryCasStore(), now });

    await counted.registry.store.put("a.json", "{}");
    await counted.registry.store.list("");

    expect(counted.registry.now).toBe(now);
    expect(counted.counts()).toEqual({ get: 0, put: 1, del: 0, list: 1 });
  });

  it("leaves the context it was given untouched, so nothing else is counted", async () => {
    const original = { store: new MemoryCasStore() };
    const counted = countingRegistry(original);

    await original.store.put("a.json", "{}");

    expect(counted.counts()).toEqual({ get: 0, put: 0, del: 0, list: 0 });
    expect(counted.registry.store).not.toBe(original.store);
  });
});
