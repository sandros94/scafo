/* The bootstrap conformance probe, and the ranged read celld made a requirement. */

import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { probeStore } from "../src/core/registry/index.ts";
import type { CasStore } from "../src/core/types/store.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { rejectsWith } from "./_helpers.ts";

/** A store that is `inner` in every respect but how it answers a read of bytes. */
function withGetBytes(inner: MemoryCasStore, getBytes: CasStore["getBytes"]): CasStore {
  return {
    get: (key) => inner.get(key),
    getBytes,
    put: (key, body, cas) => inner.put(key, body, cas),
    del: (key) => inner.del(key),
    list: (prefix) => inner.list(prefix),
  };
}

describe.concurrent("the conformance probe", () => {
  it("passes against a store that honours every step", async () => {
    const store = new MemoryCasStore();

    await expect(probeStore(store)).resolves.toBeUndefined();
    /* And leaves nothing of itself behind. */
    expect(store.size).toBe(0);
  });

  it("fails at step 6 when the driver says the range was ignored", async () => {
    const inner = new MemoryCasStore();
    /* What the uns3 driver raises when the bucket answered 200, not 206. */
    const ignored = new ScafoError("store-nonconforming", "Store does not honour ranged reads", {
      detail: "answered whole instead of the range",
    });
    const store = withGetBytes(inner, (key, opts) =>
      opts === undefined ? inner.getBytes(key) : Promise.reject(ignored),
    );

    const error = await rejectsWith(() => probeStore(store), "store-nonconforming");
    expect(error.message).toBe("Store does not honour ranged reads");
    expect(error.detail).toBe("Conformance probe failed at step 6 (ranged read was not honoured)");
    expect(error.cause).toBe(ignored);
  });

  it("fails at step 6 when the whole object comes back instead of the range", async () => {
    const inner = new MemoryCasStore();
    const store = withGetBytes(inner, (key) => inner.getBytes(key));

    const error = await rejectsWith(() => probeStore(store), "store-nonconforming");
    expect(error.message).toBe("Store does not honour ranged reads");
    expect(error.detail).toBe(
      "Conformance probe failed at step 6 (ranged read returned the wrong bytes)",
    );
  });

  it("fails at step 6 when the range is the right length but the wrong offset", async () => {
    const inner = new MemoryCasStore();
    const store = withGetBytes(inner, async (key, opts) => {
      const bytes = await inner.getBytes(key);
      if (bytes === null || opts === undefined) return bytes;
      /* Off by one: the same number of bytes, read from one place too far. */
      return bytes.subarray(opts.range.start + 1, opts.range.end + 2);
    });

    const error = await rejectsWith(() => probeStore(store), "store-nonconforming");
    expect(error.detail).toBe(
      "Conformance probe failed at step 6 (ranged read returned the wrong bytes)",
    );
  });

  it("keeps saying conditional writes when a precondition is what failed", async () => {
    const inner = new MemoryCasStore();
    const store: CasStore = {
      ...withGetBytes(inner, (key, opts) => inner.getBytes(key, opts)),
      /* A store that accepts every write, preconditions and all. */
      put: (key, body) => inner.put(key, body),
    };

    const error = await rejectsWith(() => probeStore(store), "store-nonconforming");
    expect(error.message).toBe("Store does not honour conditional writes");
    expect(error.detail).toBe("Conformance probe failed at step 2 (duplicate create was accepted)");
  });
});

describe.concurrent("the memory store answering a range", () => {
  it("gives back exactly the bytes asked for, both ends included", async () => {
    const store = new MemoryCasStore();
    await store.put("probe.json", `{"probe":3}`);

    await expect(store.getBytes("probe.json", { range: { start: 2, end: 6 } })).resolves.toEqual(
      new TextEncoder().encode("probe"),
    );
  });

  it("still answers null for a key that is not there", async () => {
    const store = new MemoryCasStore();

    await expect(
      store.getBytes("missing.json", { range: { start: 0, end: 3 } }),
    ).resolves.toBeNull();
  });
});
