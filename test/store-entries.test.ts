/*
 * What a listing says about each object, from the in-memory store.
 *
 * The same three questions `test/integration/store.test.ts` asks of a real
 * bucket, asked here of the driver every unit suite and the scale harness run
 * on: a listed ETag equals a read of the same key, it survives a listing that
 * changed nothing, and it moves when the object is rewritten. Everything that
 * reads only what changed rests on those three.
 */

import { describe, expect, it } from "vitest";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";

describe("what the in-memory store lists about an object", () => {
  it("lists the ETag a read of the same key answers with", async () => {
    const store = new MemoryCasStore();
    const written = await store.put("k/a.json", `{"n":1}`);

    const entries = await store.listEntries("k/");

    expect(entries.map((entry) => entry.key)).toEqual(["k/a.json"]);
    expect(entries[0]?.etag).toBe(written.etag);
    expect(entries[0]?.etag).toBe((await store.get("k/a.json"))?.etag);
  });

  it("keeps the ETag still while nothing writes, and moves it on a rewrite", async () => {
    const store = new MemoryCasStore();
    const first = await store.put("k/a.json", `{"n":1}`);

    expect((await store.listEntries("k/"))[0]?.etag).toBe(first.etag);

    const second = await store.put("k/a.json", `{"n":2}`);
    const after = await store.listEntries("k/");

    expect(after[0]?.etag).toBe(second.etag);
    expect(after[0]?.etag).not.toBe(first.etag);
  });

  it("conditions a write on an ETag it listed and nothing else", async () => {
    const store = new MemoryCasStore();
    await store.put("k/a.json", `{"n":1}`);
    const listed = (await store.listEntries("k/"))[0]?.etag as string;

    await expect(store.put("k/a.json", `{"n":2}`, { ifMatch: listed })).resolves.toMatchObject({
      etag: expect.any(String),
    });
    await expect(store.put("k/a.json", `{"n":3}`, { ifMatch: listed })).rejects.toMatchObject({
      code: "cas-conflict",
    });
  });
});
