/*
 * The TLS material an ingress keeps in the installation's bucket: the envelope that carries bytes
 * through a string-bodied store, what a listing of a key space answers, and the named locks that
 * serialize issuance.
 */

import { describe, expect, it } from "vitest";
import {
  acquireTlsLock,
  deleteTlsObject,
  isTlsLockStale,
  listTlsObjects,
  putTlsObject,
  readTlsObject,
  refreshTlsLock,
  type RegistryContext,
  releaseTlsLock,
  statTlsObject,
  type TlsEnvelope,
  type TlsLock,
  TLS_LOCK_STALE_MS,
  tlsLockKey,
  tlsObjectKey,
} from "../src/core/registry/index.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { CLOCK_START_MS, ctxWith, type ManualClock, rejectionOf, rejectsWith } from "./_helpers.ts";

const HOLDER = "node-a-1234abcd";
const OTHER_HOLDER = "node-b-5678efab";

/** Every byte value there is: the payload a text-shaped store would corrupt. */
const EVERY_BYTE = new Uint8Array(256).map((_, index) => index);

describe("the envelope one value is carried in", () => {
  it("round-trips every byte value, which is what a DER-carrying store must do", async () => {
    const { ctx } = fresh();

    await putTlsObject(ctx, "acme/account.key", EVERY_BYTE);

    const found = await readTlsObject(ctx, "acme/account.key");
    expect(found?.value).toEqual(EVERY_BYTE);
  });

  it("files the value under the caller's own key, base64 beside the time it landed", async () => {
    const { ctx, store } = fresh();

    await putTlsObject(ctx, "certs/example.com.crt", new Uint8Array([0, 255]));

    const object = await store.get(tlsObjectKey("certs/example.com.crt"));
    expect(object).not.toBeNull();
    expect(JSON.parse(object?.body ?? "") as TlsEnvelope).toEqual({
      value: "AP8=",
      modified: new Date(CLOCK_START_MS).toISOString(),
    });
  });

  it("stamps the write from the injected clock rather than from the wall", async () => {
    const { ctx, clock } = fresh();
    clock.tick(90_000);

    await putTlsObject(ctx, "a", new Uint8Array([1]));

    expect((await readTlsObject(ctx, "a"))?.modified).toBe(
      new Date(CLOCK_START_MS + 90_000).toISOString(),
    );
  });

  it("replaces a value whole, last writer winning, and restamps it", async () => {
    const { ctx, clock } = fresh();
    await putTlsObject(ctx, "a", new Uint8Array([1, 2, 3]));
    clock.tick(1000);

    await putTlsObject(ctx, "a", new Uint8Array([9]));

    const found = await readTlsObject(ctx, "a");
    expect(found?.value).toEqual(new Uint8Array([9]));
    expect(found?.modified).toBe(new Date(CLOCK_START_MS + 1000).toISOString());
  });

  it("answers null for a key nothing was ever written to", async () => {
    const { ctx } = fresh();

    await expect(readTlsObject(ctx, "never/written")).resolves.toBeNull();
  });

  it("refuses to read an object that is not an envelope at all", async () => {
    const { ctx, store } = fresh();
    await store.put(tlsObjectKey("acme/account.key"), JSON.stringify({ value: 7 }));

    const error = await rejectsWith(
      () => readTlsObject(ctx, "acme/account.key"),
      "store-nonconforming",
    );
    expect(error.detail).toContain(tlsObjectKey("acme/account.key"));
  });
});

describe("deleting", () => {
  it("removes the value at the key and answers what it removed", async () => {
    const { ctx } = fresh();
    await putTlsObject(ctx, "certs/example.com.crt", new Uint8Array([1]));

    await expect(deleteTlsObject(ctx, "certs/example.com.crt")).resolves.toBe(1);
    await expect(readTlsObject(ctx, "certs/example.com.crt")).resolves.toBeNull();
  });

  it("takes everything under the key with it, the key's own value included", async () => {
    const { ctx } = fresh();
    for (const key of ["certs", "certs/a.crt", "certs/deep/b.key"]) {
      await putTlsObject(ctx, key, new Uint8Array([1]));
    }

    await expect(deleteTlsObject(ctx, "certs")).resolves.toBe(3);
    await expect(listTlsObjects(ctx, "", { recursive: true })).resolves.toEqual([]);
  });

  it("leaves a sibling whose name merely starts the same way alone", async () => {
    const { ctx } = fresh();
    await putTlsObject(ctx, "cert", new Uint8Array([1]));
    await putTlsObject(ctx, "certs/a.crt", new Uint8Array([1]));

    await expect(deleteTlsObject(ctx, "cert")).resolves.toBe(1);
    await expect(readTlsObject(ctx, "certs/a.crt")).resolves.not.toBeNull();
  });

  it("answers 0 for a key that named neither a value nor a directory", async () => {
    const { ctx } = fresh();

    await expect(deleteTlsObject(ctx, "nothing/here")).resolves.toBe(0);
  });
});

describe("listing a key space", () => {
  it("answers every key at or under the prefix when it is asked recursively", async () => {
    const { ctx } = await stocked();

    await expect(listTlsObjects(ctx, "certs", { recursive: true })).resolves.toEqual([
      "certs",
      "certs/a/one.crt",
      "certs/a/two.crt",
      "certs/b/three.crt",
    ]);
  });

  it("lists the whole store for an empty prefix", async () => {
    const { ctx } = await stocked();

    await expect(listTlsObjects(ctx, "", { recursive: true })).resolves.toEqual([
      "acme/account.key",
      "certs",
      "certs/a/one.crt",
      "certs/a/two.crt",
      "certs/b/three.crt",
      "certsimilar/x",
    ]);
  });

  it("folds deeper keys into the child they sit under, once, when it is not", async () => {
    const { ctx } = await stocked();

    await expect(listTlsObjects(ctx, "certs")).resolves.toEqual(["certs/a", "certs/b"]);
  });

  it("leaves out the value stored AT the prefix, which is not a child of itself", async () => {
    const { ctx } = await stocked();

    const children = await listTlsObjects(ctx, "certs");
    expect(children).not.toContain("certs");
  });

  it("answers the top-level names for an empty prefix", async () => {
    const { ctx } = await stocked();

    await expect(listTlsObjects(ctx, "")).resolves.toEqual(["acme", "certs", "certsimilar"]);
  });

  it("never lets a prefix match a sibling that merely starts the same way", async () => {
    const { ctx } = await stocked();

    await expect(listTlsObjects(ctx, "certs", { recursive: true })).resolves.not.toContain(
      "certsimilar/x",
    );
  });

  it("answers an empty list for a prefix nothing matches, rather than failing", async () => {
    const { ctx } = await stocked();

    await expect(listTlsObjects(ctx, "nothing/here", { recursive: true })).resolves.toEqual([]);
    await expect(listTlsObjects(ctx, "nothing/here")).resolves.toEqual([]);
  });
});

describe("what a key is", () => {
  it("reports a stored value with its size and the time it landed", async () => {
    const { ctx } = await stocked();

    await expect(statTlsObject(ctx, "acme/account.key")).resolves.toEqual({
      key: "acme/account.key",
      modified: new Date(CLOCK_START_MS).toISOString(),
      size: 3,
      isTerminal: true,
    });
  });

  it("reports a name that only has keys beneath it as no value at all", async () => {
    const { ctx } = await stocked();

    await expect(statTlsObject(ctx, "certs/a")).resolves.toEqual({
      key: "certs/a",
      modified: null,
      size: 0,
      isTerminal: false,
    });
  });

  it("answers null for a name that is neither", async () => {
    const { ctx } = await stocked();

    await expect(statTlsObject(ctx, "certs/nowhere")).resolves.toBeNull();
  });

  it("prefers the value over the directory when a key is both", async () => {
    const { ctx } = await stocked();

    await expect(statTlsObject(ctx, "certs")).resolves.toMatchObject({ isTerminal: true, size: 1 });
  });
});

describe("keys the store refuses", () => {
  const refused = [
    "",
    "/absolute",
    "a//b",
    "a/",
    ".",
    "..",
    "a/./b",
    "a/../b",
    "a\nb",
    "a\u0000b",
    "café",
  ];

  it.each(refused)("refuses %j as an object key, before touching the store", async (key) => {
    const { ctx, store } = fresh();

    await rejectsWith(() => putTlsObject(ctx, key, new Uint8Array([1])), "invalid-input");
    await rejectsWith(() => readTlsObject(ctx, key), "invalid-input");
    await rejectsWith(() => deleteTlsObject(ctx, key), "invalid-input");
    await rejectsWith(() => statTlsObject(ctx, key), "invalid-input");
    expect(store.size).toBe(0);
  });

  it.each(refused.filter((key) => key !== ""))("refuses %j as a lock name too", async (name) => {
    const { ctx } = fresh();

    expect((await rejectionOf(() => acquireTlsLock(ctx, name, HOLDER))).code).toBe("invalid-input");
  });

  it("takes every printable character, spaces and wildcards among them", async () => {
    const { ctx } = fresh();

    await putTlsObject(ctx, "certs/wildcard_.example.com/a b.crt", EVERY_BYTE);

    await expect(listTlsObjects(ctx, "certs", { recursive: true })).resolves.toEqual([
      "certs/wildcard_.example.com/a b.crt",
    ]);
  });

  it("refuses a non-empty listing prefix on the same terms", async () => {
    const { ctx } = fresh();

    await rejectsWith(() => listTlsObjects(ctx, "a/../b"), "invalid-input");
    /* The one exception, and it is the whole store: an empty prefix lists it. */
    await expect(listTlsObjects(ctx, "")).resolves.toEqual([]);
  });
});

describe("taking a lock", () => {
  it("writes who has it, since when, and as of when, from the injected clock", async () => {
    const { ctx, store } = fresh();

    const handle = await acquireTlsLock(ctx, "issue/example.com", HOLDER);

    const at = new Date(CLOCK_START_MS).toISOString();
    expect(handle.lock).toEqual({
      holder: HOLDER,
      acquiredAt: at,
      refreshedAt: at,
      token: expect.stringMatching(/^[a-f\d]{16}$/) as string,
    });
    const stored = await store.get(tlsLockKey("issue/example.com"));
    expect(JSON.parse(stored?.body ?? "") as TlsLock).toEqual(handle.lock);
  });

  it("refuses a second caller while the first keeps it fresh", async () => {
    const { ctx } = fresh();
    await acquireTlsLock(ctx, "issue", HOLDER);

    const error = await rejectsWith(
      () => acquireTlsLock(ctx, "issue", OTHER_HOLDER),
      "cas-conflict",
    );
    expect(error.status).toBe(409);
    expect(error.detail).toContain(HOLDER);
  });

  it("still refuses it one millisecond before the record goes stale", async () => {
    const { ctx, clock } = fresh();
    await acquireTlsLock(ctx, "issue", HOLDER);
    clock.tick(TLS_LOCK_STALE_MS - 1);

    expect((await rejectionOf(() => acquireTlsLock(ctx, "issue", OTHER_HOLDER))).code).toBe(
      "cas-conflict",
    );
  });

  it("hands it to the next caller once nobody has restamped it", async () => {
    const { ctx, clock } = fresh();
    await acquireTlsLock(ctx, "issue", HOLDER);
    clock.tick(TLS_LOCK_STALE_MS);

    const taken = await acquireTlsLock(ctx, "issue", OTHER_HOLDER);

    const at = new Date(CLOCK_START_MS + TLS_LOCK_STALE_MS).toISOString();
    expect(taken.lock).toEqual({
      holder: OTHER_HOLDER,
      acquiredAt: at,
      refreshedAt: at,
      token: expect.stringMatching(/^[a-f\d]{16}$/) as string,
    });
  });

  it("lets only one of two callers take a stale lock over", async () => {
    const { ctx, clock } = fresh();
    await acquireTlsLock(ctx, "issue", HOLDER);
    clock.tick(TLS_LOCK_STALE_MS);

    const outcomes = await Promise.allSettled([
      acquireTlsLock(ctx, "issue", OTHER_HOLDER),
      acquireTlsLock(ctx, "issue", "node-c-0000"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  it("counts a record whose time cannot be read as stale, so nothing is stuck forever", () => {
    expect(
      isTlsLockStale({ holder: HOLDER, acquiredAt: "?", refreshedAt: "?", token: "?" }, new Date()),
    ).toBe(true);
  });
});

describe("keeping a lock", () => {
  it("restamps it without moving when it was taken", async () => {
    const { ctx, clock } = fresh();
    const handle = await acquireTlsLock(ctx, "issue", HOLDER);
    clock.tick(5000);

    const kept = await refreshTlsLock(ctx, handle);

    expect(kept.lock.acquiredAt).toBe(handle.lock.acquiredAt);
    expect(kept.lock.refreshedAt).toBe(new Date(CLOCK_START_MS + 5000).toISOString());
    expect(kept.etag).not.toBe(handle.etag);
  });

  it("keeps the lock out of anyone else's reach for as long as it is restamped", async () => {
    const { ctx, clock } = fresh();
    let handle = await acquireTlsLock(ctx, "issue", HOLDER);

    for (let round = 0; round < 6; round++) {
      clock.tick(5000);
      handle = await refreshTlsLock(ctx, handle);
      await rejectsWith(() => acquireTlsLock(ctx, "issue", OTHER_HOLDER), "cas-conflict");
    }
    expect(handle.lock.holder).toBe(HOLDER);
  });

  it("reports the lock lost once someone else has taken it over", async () => {
    const { ctx, clock } = fresh();
    const handle = await acquireTlsLock(ctx, "issue", HOLDER);
    clock.tick(TLS_LOCK_STALE_MS);
    await acquireTlsLock(ctx, "issue", OTHER_HOLDER);

    expect((await rejectionOf(() => refreshTlsLock(ctx, handle))).code).toBe("lease-lost");
  });
});

describe("giving a lock up", () => {
  it("removes the record when it is still the one this caller took", async () => {
    const { ctx, store } = fresh();
    const handle = await acquireTlsLock(ctx, "issue", HOLDER);

    await expect(releaseTlsLock(ctx, handle)).resolves.toBe(true);
    await expect(store.get(tlsLockKey("issue"))).resolves.toBeNull();
  });

  it("NEVER removes a lock somebody else has taken over since", async () => {
    const { ctx, clock, store } = fresh();
    const handle = await acquireTlsLock(ctx, "issue", HOLDER);
    clock.tick(TLS_LOCK_STALE_MS);
    const taken = await acquireTlsLock(ctx, "issue", OTHER_HOLDER);

    await expect(releaseTlsLock(ctx, handle)).resolves.toBe(false);
    const stored = await store.get(tlsLockKey("issue"));
    expect(JSON.parse(stored?.body ?? "") as TlsLock).toEqual(taken.lock);
  });

  it("answers false, rather than failing, for a record that is already gone", async () => {
    const { ctx } = fresh();
    const handle = await acquireTlsLock(ctx, "issue", HOLDER);
    await releaseTlsLock(ctx, handle);

    await expect(releaseTlsLock(ctx, handle)).resolves.toBe(false);
  });

  it("frees the name for the next caller at once, rather than after the stale window", async () => {
    const { ctx } = fresh();
    await releaseTlsLock(ctx, await acquireTlsLock(ctx, "issue", HOLDER));

    const taken = await acquireTlsLock(ctx, "issue", OTHER_HOLDER);
    expect(taken.lock.holder).toBe(OTHER_HOLDER);
  });
});

interface Fixture {
  store: MemoryCasStore;
  ctx: RegistryContext;
  clock: ManualClock;
}

function fresh(): Fixture {
  const store = new MemoryCasStore();
  const clock = ctxWith(store);
  return { store, ctx: clock.ctx, clock };
}

/** A store holding a value at a prefix, under it, and beside a name that shares its start. */
async function stocked(): Promise<Fixture> {
  const fixture = fresh();
  const keys = [
    "acme/account.key",
    "certs",
    "certs/a/one.crt",
    "certs/a/two.crt",
    "certs/b/three.crt",
    "certsimilar/x",
  ];
  for (const key of keys) {
    await putTlsObject(fixture.ctx, key, new Uint8Array(key === "certs" ? 1 : 3));
  }
  return fixture;
}
