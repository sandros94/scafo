/*
 * Named locks in the bucket: taking one, keeping one alive, giving one back, and
 * finding out that somebody else has it.
 */

import { describe, expect, it } from "vitest";
import { readJson } from "../src/core/registry/cas.ts";
import {
  acquireLock,
  isLockStale,
  LOCK_POLL_MS,
  LOCK_REFRESH_MS,
  LOCK_STALE_MS,
  lockHolder,
  type LockSpace,
  type NamedLock,
  refreshLock,
  releaseLock,
} from "../src/core/registry/locks.ts";
import { tlsLockKey } from "../src/core/registry/paths.ts";
import { TLS_LOCK_SPACE } from "../src/core/registry/tls-lock.ts";
import { ScafoError } from "../src/core/error.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  CLOCK_START_MS,
  ctxWith,
  FaultStore,
  type ManualClock,
  rejectionOf,
  rejectsWith,
} from "./_helpers.ts";

const HOLDER = "node-a-0f0f0f0f";
const FOREIGN = "somebody-else";

/** The shipped durations, scaled so a case runs in milliseconds. */
const SPACE: LockSpace = {
  keyOf: (name: string): string => `_scafo/tls/locks/test/${name}.json`,
  refreshMs: LOCK_REFRESH_MS / 200,
  staleMs: LOCK_STALE_MS / 200,
  pollMs: LOCK_POLL_MS / 200,
};

describe("taking a lock", () => {
  it("writes the record, and refuses the second caller of the same name", async () => {
    const { store, clock } = world();

    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    expect(handle).toMatchObject({ name: "one", lock: { holder: HOLDER } });
    await expect(record(store, "one")).resolves.toMatchObject({ holder: HOLDER });

    const error = await rejectsWith(
      () => acquireLock(clock.ctx, SPACE, "one", FOREIGN),
      "cas-conflict",
    );
    expect(error.detail).toContain(HOLDER);
  });

  it("leaves a different name alone: two names are two locks", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    await expect(acquireLock(clock.ctx, SPACE, "two", FOREIGN)).resolves.toMatchObject({
      name: "two",
    });
  });

  it("takes over one whose holder stopped restamping it, and not a moment sooner", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);

    /* Nobody is left to give it back, so it is waited out rather than waited on
       forever — and not a moment before it is due. */
    clock.tick(SPACE.staleMs - 1);
    await rejectsWith(() => acquireLock(clock.ctx, SPACE, "one", HOLDER), "cas-conflict");

    clock.tick(1);
    await expect(acquireLock(clock.ctx, SPACE, "one", HOLDER)).resolves.toMatchObject({
      lock: { holder: HOLDER },
    });
  });

  it("takes a lock whose creation landed before the store failed to say so", async () => {
    const store = new FaultStore(new MemoryCasStore());
    const clock = ctxWith(store);
    /* The record is already written and the answer that said so was lost, so
       the repeat the driver sent is refused by its own precondition. Refusing
       the caller over that would deny it a lock it holds, for the whole stale
       window. */
    store.onAfterPut = (): void => {
      store.onAfterPut = undefined;
      throw new ScafoError("cas-conflict", "Conditional write failed", { status: 412 });
    };

    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    expect(handle.lock).toMatchObject({ holder: HOLDER });
    clock.tick(SPACE.refreshMs);
    await expect(refreshLock(clock.ctx, SPACE, handle)).resolves.toMatchObject({ name: "one" });
  });

  it("takes over a stale lock whose takeover landed before the store failed to say so", async () => {
    const store = new FaultStore(new MemoryCasStore());
    const clock = ctxWith(store);
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);
    clock.tick(SPACE.staleMs);
    store.onAfterPut = (): void => {
      store.onAfterPut = undefined;
      throw new ScafoError("cas-conflict", "Conditional write failed", { status: 412 });
    };

    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    expect(handle.lock).toMatchObject({ holder: HOLDER });
    await expect(refreshLock(clock.ctx, SPACE, handle)).resolves.toMatchObject({ name: "one" });
  });

  it("refuses the same holder taking the same name again within one clock tick", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    /* Holder and moment are the same record, field for field; only the token
       drawn at each acquisition says this is a second one and not the first
       one's unanswered repeat. */
    const error = await rejectionOf(() => acquireLock(clock.ctx, SPACE, "one", HOLDER));
    expect(error.code).toBe("cas-conflict");
  });

  it("hands a holder id that tells two daemons of one node apart", () => {
    const first = lockHolder("node-a");
    expect(first).toMatch(/^node-a-[0-9a-f]{8}$/);
    expect(first).not.toBe(lockHolder("node-a"));
  });
});

describe("keeping a lock", () => {
  it("restamps it, so one held across the stale window is never taken over", async () => {
    const { store, clock } = world();
    let handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    /* Three stale windows of work, with the clock moved half a window at a time
       and a restamp landing between each pair. */
    for (let round = 0; round < 6; round++) {
      clock.tick(SPACE.staleMs / 2);
      handle = await refreshLock(clock.ctx, SPACE, handle);
      await expect(record(store, "one")).resolves.toMatchObject({
        refreshedAt: new Date(clock.nowMs()).toISOString(),
      });
    }

    await rejectsWith(() => acquireLock(clock.ctx, SPACE, "one", FOREIGN), "cas-conflict");
  });

  it("types a restamp onto a record a successor has taken as lease loss", async () => {
    const { clock } = world();
    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    clock.tick(SPACE.staleMs);
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);

    const error = await rejectsWith(() => refreshLock(clock.ctx, SPACE, handle), "lease-lost");
    expect(error.detail).toContain(HOLDER);
  });

  it("keeps a lock whose restamp landed before the store failed to say so", async () => {
    const store = new FaultStore(new MemoryCasStore());
    const clock = ctxWith(store);
    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    clock.tick(SPACE.refreshMs);
    /* The record is already restamped and the answer that said so was lost, so
       the repeat the driver sent is refused by its own precondition. */
    store.onAfterPut = (): void => {
      store.onAfterPut = undefined;
      throw new ScafoError("cas-conflict", "Conditional write failed", { status: 412 });
    };

    const kept = await refreshLock(clock.ctx, SPACE, handle);

    expect(kept.lock).toMatchObject({
      holder: HOLDER,
      acquiredAt: handle.lock.acquiredAt,
      refreshedAt: new Date(clock.nowMs()).toISOString(),
    });
    /* And the handle it answered with fences the next restamp, which the one
       the caller came in with no longer could. */
    clock.tick(SPACE.refreshMs);
    await expect(refreshLock(clock.ctx, SPACE, kept)).resolves.toMatchObject({ name: "one" });
  });

  it("types a restamp onto a record its own id has taken again as lease loss", async () => {
    const { clock } = world();
    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    clock.tick(SPACE.staleMs);
    /* The same id holding the name a second time: only the moment it was taken
       tells the two tenancies apart. */
    await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    const error = await rejectsWith(() => refreshLock(clock.ctx, SPACE, handle), "lease-lost");
    expect(error.detail).toContain(handle.lock.acquiredAt);
  });

  it("types an unreachable restamp as lease loss too, and preserves its cause", async () => {
    const { store, clock } = world();
    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    const put = store.put.bind(store);
    const storeFailure = new Error("the bucket is unreachable");
    store.put = (key, body, cas) =>
      cas?.ifMatch === undefined ? put(key, body, cas) : Promise.reject(storeFailure);

    /* Neither a conflict nor a transport failure proves the restamp landed, so
       both cost the holder its authority rather than its certainty. */
    const error = await rejectsWith(() => refreshLock(clock.ctx, SPACE, handle), "lease-lost");
    expect(error.cause).toBe(storeFailure);
  });
});

describe("giving a lock back", () => {
  it("removes the record this handle wrote, and says so", async () => {
    const { store, clock } = world();
    const handle = await acquireLock(clock.ctx, SPACE, "one", HOLDER);

    await expect(releaseLock(clock.ctx, SPACE, handle)).resolves.toBe(true);
    await expect(record(store, "one")).resolves.toBeNull();
  });

  it("removes NOTHING once a successor holds the name", async () => {
    const { store, clock } = world();
    const stale = await acquireLock(clock.ctx, SPACE, "one", HOLDER);
    clock.tick(SPACE.staleMs);
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);

    await expect(releaseLock(clock.ctx, SPACE, stale)).resolves.toBe(false);
    await expect(record(store, "one")).resolves.toMatchObject({ holder: FOREIGN });
  });
});

describe("where a lock lives", () => {
  it("keeps every ingress lock under the prefix of its own", () => {
    expect(tlsLockKey("issue/example.com")).toBe("_scafo/tls/locks/issue/example.com");
  });

  it("waits on the same durations wherever it is taken", () => {
    for (const space of [TLS_LOCK_SPACE]) {
      expect({ ...space, keyOf: undefined }).toEqual({
        keyOf: undefined,
        refreshMs: LOCK_REFRESH_MS,
        staleMs: LOCK_STALE_MS,
        pollMs: LOCK_POLL_MS,
      });
    }
    /* A holder restamps twice inside the window another caller waits out. */
    expect(LOCK_REFRESH_MS * 2).toBeLessThanOrEqual(LOCK_STALE_MS);
  });
});

describe("reading a record's staleness", () => {
  it("counts a lock stale once, and only once, it is due", () => {
    const lock: NamedLock = {
      holder: HOLDER,
      acquiredAt: new Date(CLOCK_START_MS).toISOString(),
      refreshedAt: new Date(CLOCK_START_MS).toISOString(),
      token: "0123456789abcdef",
    };

    expect(isLockStale(lock, new Date(CLOCK_START_MS + LOCK_STALE_MS - 1), LOCK_STALE_MS)).toBe(
      false,
    );
    expect(isLockStale(lock, new Date(CLOCK_START_MS + LOCK_STALE_MS), LOCK_STALE_MS)).toBe(true);
  });

  it("counts a record it cannot read a time out of as stale", () => {
    /* Nobody is coming back for a record whose stamp means nothing, and refusing
       every later attempt over it would be worse than taking it over. */
    const lock: NamedLock = {
      holder: HOLDER,
      acquiredAt: "",
      refreshedAt: "whenever",
      token: "0123456789abcdef",
    };

    expect(isLockStale(lock, new Date(CLOCK_START_MS), LOCK_STALE_MS)).toBe(true);
  });
});

function world(): { store: MemoryCasStore; clock: ManualClock } {
  const store = new MemoryCasStore();
  return { store, clock: ctxWith(store) };
}

/** The lock record as it stands in the bucket, or null when the name is free. */
async function record(store: MemoryCasStore, name: string): Promise<NamedLock | null> {
  const found = await readJson<NamedLock>({ store }, SPACE.keyOf(name));
  return found?.value ?? null;
}
