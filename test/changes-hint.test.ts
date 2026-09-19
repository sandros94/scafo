/*
 * The change hint: what mints a token, what does not, and what a hint that could
 * not be written costs the mutation it follows.
 */

import { describe, expect, it, vi } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import {
  hintingStore,
  isHintedKey,
  mintChangeToken,
  readChangeHint,
  writeChangeHint,
} from "../src/core/registry/changes.ts";
import {
  applicationKey,
  changesKey,
  deployKey,
  deploymentKey,
  domainKey,
  nodeKey,
  placementKey,
  trustKey,
} from "../src/core/registry/paths.ts";
import type { CasStore } from "../src/core/types/store.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";

/** Told about every hint that could not be written. */
const onFailure = vi.fn();

/** The token the hint object currently carries, straight out of the store. */
async function tokenOf(store: CasStore): Promise<string | null> {
  return readChangeHint({ store });
}

describe("which writes the fleet is told about at once", () => {
  it("names the three prefixes routing is decided from, and no others", () => {
    expect(isHintedKey(applicationKey("shop"))).toBe(true);
    expect(isHintedKey(placementKey("shop"))).toBe(true);
    expect(isHintedKey(domainKey("shop.example.test"))).toBe(true);

    /* A heartbeat rewrites a node record every thirty seconds; hinting one would
       cost every node a listing several times a minute, forever. */
    expect(isHintedKey(nodeKey("node-1"))).toBe(false);
    expect(isHintedKey(deployKey("shop", "shop.0123456789abcdef"))).toBe(false);
    expect(isHintedKey(deploymentKey("shop", "abcd1234"))).toBe(false);
    expect(isHintedKey(trustKey("shop"))).toBe(false);
    expect(isHintedKey(changesKey())).toBe(false);
  });
});

describe("a token", () => {
  it("is sixteen lowercase hex characters, and a different one each time", () => {
    const first = mintChangeToken();
    expect(first).toMatch(/^[\da-f]{16}$/);
    expect(mintChangeToken()).not.toBe(first);
  });
});

describe("the hinting store", () => {
  it("mints a fresh token after a write under a hinted prefix", async () => {
    const store = hintingStore(new MemoryCasStore());

    await store.put(applicationKey("shop"), "{}");
    const first = await tokenOf(store);
    expect(first).toMatch(/^[\da-f]{16}$/);

    await store.put(placementKey("shop"), "{}");
    const second = await tokenOf(store);
    expect(second).not.toBe(first);

    await store.del(domainKey("shop.example.test"));
    expect(await tokenOf(store)).not.toBe(second);
  });

  it("leaves the token alone for a write of any other kind of record", async () => {
    const store = hintingStore(new MemoryCasStore());
    await store.put(applicationKey("shop"), "{}");
    const token = await tokenOf(store);

    await store.put(nodeKey("node-1"), "{}");
    await store.put(deploymentKey("shop", "abcd1234"), "{}");
    await store.put(trustKey("shop"), "{}");
    await store.del(nodeKey("node-1"));

    expect(await tokenOf(store)).toBe(token);
  });

  it("hints nothing when the write it follows failed", async () => {
    const store = hintingStore(new MemoryCasStore());
    await store.put(applicationKey("shop"), "{}");
    const token = await tokenOf(store);

    /* A create that lost is a change that never happened. */
    await expect(
      store.put(applicationKey("shop"), "{}", { ifNoneMatch: "*" }),
    ).rejects.toMatchObject({ code: "cas-conflict" });

    expect(await tokenOf(store)).toBe(token);
  });

  it("writes the hint blind, so concurrent mutations never contend on it", async () => {
    const inner = new MemoryCasStore();
    const conditions: unknown[] = [];
    const watched: CasStore = {
      get: (key) => inner.get(key),
      getBytes: (key, opts) => inner.getBytes(key, opts),
      list: (prefix) => inner.list(prefix),
      listEntries: (prefix) => inner.listEntries(prefix),
      del: (key) => inner.del(key),
      put: (key, body, cas) => {
        if (key === changesKey()) conditions.push(cas);
        return inner.put(key, body, cas);
      },
    };
    const store = hintingStore(watched);

    await Promise.all(
      ["a", "b", "c", "d"].map(async (name) => store.put(applicationKey(name), "{}")),
    );

    expect(conditions).toHaveLength(4);
    expect(conditions.every((cas) => cas === undefined)).toBe(true);
    expect(await tokenOf(inner)).toMatch(/^[\da-f]{16}$/);
  });

  it("reports a hint it could not write, and answers the mutation as the success it was", async () => {
    const inner = new MemoryCasStore();
    const store = hintingStore(
      {
        get: (key) => inner.get(key),
        getBytes: (key, opts) => inner.getBytes(key, opts),
        list: (prefix) => inner.list(prefix),
        listEntries: (prefix) => inner.listEntries(prefix),
        del: (key) => inner.del(key),
        put: (key, body, cas) => {
          if (key === changesKey()) {
            return Promise.reject(new ScafoError("store-unavailable", "Store did not answer"));
          }
          return inner.put(key, body, cas);
        },
      },
      { onFailure },
    );
    const written = await store.put(applicationKey("shop"), `{"n":1}`);

    expect(written.etag).not.toBe("");
    await expect(inner.get(applicationKey("shop"))).resolves.toMatchObject({ body: `{"n":1}` });
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});

describe("reading the hint", () => {
  it("answers null when nothing has ever hinted", async () => {
    await expect(readChangeHint({ store: new MemoryCasStore() })).resolves.toBeNull();
  });

  it("answers null for a hint it cannot read, so the reader falls back to its resync", async () => {
    const store = new MemoryCasStore();
    await store.put(changesKey(), "not json at all");
    await expect(readChangeHint({ store })).resolves.toBeNull();

    await store.put(changesKey(), `{"v":1}`);
    await expect(readChangeHint({ store })).resolves.toBeNull();
  });

  it("answers the token a blind write left", async () => {
    const store = new MemoryCasStore();
    const written = await writeChangeHint(store);
    await expect(readChangeHint({ store })).resolves.toBe(written);
  });
});
