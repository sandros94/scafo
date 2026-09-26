/* JSON over conditional writes: create-once, read, and the read-modify-retry loop. */

import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import {
  createJson,
  putJson,
  readJson,
  requireJson,
  updateJson,
} from "../src/core/registry/index.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, rejectsWith } from "./_helpers.ts";

interface Counter {
  a: number;
  b: number;
}

const KEY = "_scafo/probe/aabbccdd.json";

describe("createJson", () => {
  it("creates once and conflicts on repeat", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());

    const created = await createJson(ctx, KEY, { a: 1, b: 0 });
    expect(created.etag).toBeTypeOf("string");

    await rejectsWith(() => createJson(ctx, KEY, { a: 2, b: 0 }), "cas-conflict");
    await expect(readJson<Counter>(ctx, KEY)).resolves.toMatchObject({ value: { a: 1, b: 0 } });
  });
});

describe("readJson", () => {
  it("returns null for a key that is not there", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    await expect(readJson(ctx, KEY)).resolves.toBeNull();
  });

  it("reports a body that is not JSON as store-nonconforming", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await store.put(KEY, "{not json");

    const error = await rejectsWith(() => readJson(ctx, KEY), "store-nonconforming");
    expect(error.status).toBe(500);
  });

  it("reads a document back without a key an object answers for on its own", async () => {
    const store = new MemoryCasStore();
    const { ctx } = ctxWith(store);
    await store.put(KEY, '{"a": 1, "__proto__": {"a": 99}, "constructor": "no", "b": 0}');

    const found = await readJson<Counter>(ctx, KEY);

    expect(Object.keys(found?.value ?? {})).toEqual(["a", "b"]);
    expect(found?.value).toEqual({ a: 1, b: 0 });
  });

  it("throws not-found from requireJson only", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    const error = await rejectsWith(() => requireJson(ctx, KEY), "not-found");
    expect(error.status).toBe(404);
  });
});

describe("putJson", () => {
  it("writes unconditionally and honours an explicit precondition", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());

    const first = await putJson(ctx, KEY, { a: 1, b: 1 });
    const second = await putJson(ctx, KEY, { a: 2, b: 1 }, { ifMatch: first.etag });
    expect(second.etag).not.toBe(first.etag);

    await rejectsWith(
      () => putJson(ctx, KEY, { a: 3, b: 1 }, { ifMatch: first.etag }),
      "cas-conflict",
    );
  });
});

describe("updateJson", () => {
  it("reads, mutates and writes back under the read etag", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    await createJson(ctx, KEY, { a: 1, b: 1 });

    const updated = await updateJson<Counter>(ctx, KEY, (current) => ({
      ...current,
      a: current.a + 1,
    }));

    expect(updated.value).toEqual({ a: 2, b: 1 });
    await expect(readJson<Counter>(ctx, KEY)).resolves.toMatchObject({
      value: { a: 2, b: 1 },
      etag: updated.etag,
    });
  });

  it("re-reads after losing the race, so no writer is lost", async () => {
    const inner = new MemoryCasStore();
    const store = new FaultStore(inner);
    const { ctx } = ctxWith(store);
    await createJson(ctx, KEY, { a: 0, b: 0 });
    const putsBefore = store.puts;

    /* One competing writer, landing between the caller's read and its first put. */
    let raced = false;
    store.onBeforePut = async (key): Promise<void> => {
      if (raced) return;
      raced = true;
      const current = await inner.get(key);
      if (current === null) return;
      const value = JSON.parse(current.body) as Counter;
      await inner.put(key, JSON.stringify({ ...value, b: 7 }), { ifMatch: current.etag });
    };

    const updated = await updateJson<Counter>(
      ctx,
      KEY,
      (current) => ({ ...current, a: current.a + 1 }),
      { jitter: () => 0, sleep: () => Promise.resolve() },
    );

    expect(updated.value).toEqual({ a: 1, b: 7 });
    expect(store.puts - putsBefore, "one losing put, then one winning put").toBe(2);
  });

  it("throws not-found when the key is absent", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());

    const error = await rejectsWith(
      () => updateJson<Counter>(ctx, KEY, (current) => current),
      "not-found",
    );
    expect(error.detail).toContain(KEY);
  });

  it("lets the conflict escape once the attempts run out", async () => {
    const inner = new MemoryCasStore();
    const store = new FaultStore(inner);
    const { ctx } = ctxWith(store);
    await createJson(ctx, KEY, { a: 0, b: 0 });
    const putsBefore = store.puts;

    /* A writer that never yields: every attempt reads stale and loses its put. */
    store.onBeforePut = async (key): Promise<void> => {
      const current = await inner.get(key);
      if (current === null) return;
      const value = JSON.parse(current.body) as Counter;
      await inner.put(key, JSON.stringify({ ...value, b: value.b + 1 }), { ifMatch: current.etag });
    };

    await rejectsWith(
      () =>
        updateJson<Counter>(ctx, KEY, (current) => ({ ...current, a: current.a + 1 }), {
          attempts: 3,
          jitter: () => 0,
          sleep: () => Promise.resolve(),
        }),
      "cas-conflict",
    );

    expect(store.puts - putsBefore, "three attempts, three lost puts").toBe(3);
  });

  it("does not retry an error raised by the mutation itself", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());
    await createJson(ctx, KEY, { a: 0, b: 0 });

    let mutations = 0;
    const error = await rejectsWith(
      () =>
        updateJson<Counter>(ctx, KEY, () => {
          mutations++;
          throw new ScafoError("immutable", "mutation refused");
        }),
      "immutable",
    );

    expect(error.message).toBe("mutation refused");
    expect(mutations).toBe(1);
  });
});
