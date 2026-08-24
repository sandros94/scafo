/*
 * Named locks in the bucket: taking one, waiting for one, keeping one alive
 * while the work runs, and finding out that it is gone.
 *
 * The clock is the test's own, so staleness is decided by hand rather than
 * waited out; the refresh and poll intervals are real timers over a space whose
 * durations are the shipped ones divided by two hundred, so what a case proves
 * is the mechanism rather than the numbers.
 */

import { describe, expect, it, vi } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { readJson } from "../src/core/registry/cas.ts";
import {
  acquireLock,
  isLockStale,
  LOCK_POLL_MS,
  LOCK_REFRESH_MS,
  LOCK_STALE_MS,
  type LockSpace,
  type NamedLock,
  releaseLock,
  withLock,
} from "../src/core/registry/locks.ts";
import { locksPrefix, pointerLockKey, tlsLockKey } from "../src/core/registry/paths.ts";
import { POINTER_LOCK_SPACE, pointerLockName } from "../src/core/registry/pointer-lock.ts";
import { TLS_LOCK_SPACE } from "../src/core/registry/tls-lock.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { CLOCK_START_MS, ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const HOLDER = "node-a-0f0f0f0f";
const FOREIGN = "somebody-else";

/** The shipped durations, scaled so a case runs in milliseconds. */
const SPACE: LockSpace = {
  keyOf: (name: string): string => `${locksPrefix()}test/${name}.json`,
  refreshMs: LOCK_REFRESH_MS / 200,
  staleMs: LOCK_STALE_MS / 200,
  pollMs: LOCK_POLL_MS / 200,
};

describe("running work under a lock", () => {
  it("takes the name, hands back what the work returned, and gives it back", async () => {
    const { store, clock } = world();
    let held: NamedLock | null = null;

    const answer = await withLock(clock.ctx, request(), async () => {
      held = await record(store, "one");
      return "done";
    });

    expect(answer).toBe("done");
    expect(held).toMatchObject({ holder: HOLDER });
    /* And the name is free the moment the work is over. */
    await expect(store.get(SPACE.keyOf("one"))).resolves.toBeNull();
  });

  it("hands a failure of the work back untouched, and still gives the lock back", async () => {
    const { store, clock } = world();

    const error = await rejectsWith(
      () =>
        withLock(clock.ctx, request(), () =>
          Promise.reject(new ScafoError("invalid-input", "The work refused")),
        ),
      "invalid-input",
    );

    expect(error.message).toBe("The work refused");
    await expect(store.get(SPACE.keyOf("one"))).resolves.toBeNull();
  });

  it("runs the work of two different names at the same time", async () => {
    const { clock } = world();
    const inside: string[] = [];
    const one = deferred<void>();
    const two = deferred<void>();

    const first = withLock(clock.ctx, request({ name: "one" }), async () => {
      inside.push("one");
      await one.promise;
    });
    const second = withLock(clock.ctx, request({ name: "two" }), async () => {
      inside.push("two");
      await two.promise;
    });

    /* Neither waited for the other: two names are two locks, and an environment
       must never be serialized behind an unrelated one. */
    await settle();
    expect(inside).toEqual(["one", "two"]);

    one.resolve();
    two.resolve();
    await Promise.all([first, second]);
  });
});

describe("waiting for a lock somebody else has", () => {
  it("takes it the moment it is given back", async () => {
    const { clock } = world();
    const first = await acquireLock(clock.ctx, SPACE, "one", FOREIGN);
    let ran = false;

    const second = withLock(clock.ctx, request({ timeoutMs: 1000 }), () => {
      ran = true;
      return Promise.resolve("second");
    });

    await settle();
    expect(ran, "the work ran while somebody else held the lock").toBe(false);

    await releaseLock(clock.ctx, SPACE, first);
    await expect(second).resolves.toBe("second");
  });

  it("gives up with a refusal rather than hanging, and never runs the work", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);
    let ran = false;

    const started = Date.now();
    const error = await rejectsWith(
      () =>
        withLock(clock.ctx, request({ timeoutMs: SPACE.pollMs * 4 }), () => {
          ran = true;
          return Promise.resolve("never");
        }),
      "cas-conflict",
    );

    expect(ran).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(SPACE.pollMs * 4);
    expect(error.detail).toContain("one");
    expect(error.detail).toContain(HOLDER);
  });

  it("tries exactly once when it was told to wait for nothing", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);

    const started = Date.now();
    await rejectsWith(() => withLock(clock.ctx, request({ timeoutMs: 0 }), work), "cas-conflict");

    expect(Date.now() - started).toBeLessThan(SPACE.pollMs * 4);
  });

  it("keeps its whole wait when the machine's clock jumps forward under it", async () => {
    const { clock } = world();
    const first = await acquireLock(clock.ctx, SPACE, "one", FOREIGN);
    const timeoutMs = SPACE.pollMs * 100;

    steppableWallClock();
    try {
      const second = withLock(clock.ctx, request({ timeoutMs }), work);

      /* A jump of ten times the budget, while barely any of it has been spent. */
      await elapse(SPACE.pollMs * 2);
      vi.setSystemTime(Date.now() + timeoutMs * 10);

      /* And the lock comes back well inside the wait it was given. */
      await elapse(SPACE.pollMs * 2);
      await releaseLock(clock.ctx, SPACE, first);

      /* A wait budgeted on the wall clock would have been spent by the jump —
         and this caller refused a lock nobody was holding, told it had waited
         the whole of a wait it never got. */
      await expect(second).resolves.toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on time when the machine's clock jumps backwards under it", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);
    const timeoutMs = SPACE.pollMs * 20;
    const started = performance.now();

    steppableWallClock();
    try {
      const waiting = rejectsWith(
        () => withLock(clock.ctx, request({ timeoutMs }), work),
        "cas-conflict",
      );

      await elapse(SPACE.pollMs * 2);
      vi.setSystemTime(Date.now() - timeoutMs * 20);
      await waiting;
    } finally {
      vi.useRealTimers();
    }

    /* The other half of the same rule: a jump backwards must not buy the waiter
       time either, or a rollout told to give up in five seconds holds its pass
       up for as long as the clock went back. */
    expect(performance.now() - started).toBeLessThan(timeoutMs * 5);
  });

  it("takes over one whose holder stopped restamping it", async () => {
    const { clock } = world();
    await acquireLock(clock.ctx, SPACE, "one", FOREIGN);

    /* Nobody is left to give it back, so it is waited out rather than waited on
       forever — and not a moment before it is due. */
    clock.tick(SPACE.staleMs - 1);
    await rejectsWith(() => withLock(clock.ctx, request({ timeoutMs: 0 }), work), "cas-conflict");

    clock.tick(1);
    await expect(withLock(clock.ctx, request({ timeoutMs: 0 }), work)).resolves.toBe("done");
  });
});

describe("keeping a lock while the work runs", () => {
  it("restamps it, so work outlasting the stale window is never taken over", async () => {
    const { store, clock } = world();
    const working = deferred<string>();

    const held = withLock(clock.ctx, request(), () => working.promise);

    /* Three stale windows of work — what bundling and uploading an artifact
       costs — with the clock moved half a window at a time and a restamp landing
       between each pair. */
    for (let round = 0; round < 6; round++) {
      clock.tick(SPACE.staleMs / 2);
      await expect
        .poll(async () => (await record(store, "one"))?.refreshedAt, { interval: 2 })
        .toBe(new Date(clock.nowMs()).toISOString());
    }

    await rejectsWith(() => acquireLock(clock.ctx, SPACE, "one", FOREIGN), "cas-conflict");
    working.resolve("done");
    await expect(held).resolves.toBe("done");
  });

  it("aborts loudly the moment a restamp does not land, without waiting for the work", async () => {
    const { store, clock } = world();
    /* Work that would never end on its own: the rejection has to come from the
       lock being gone, not from the section finishing. */
    const held = withLock(clock.ctx, request(), () => deferred<string>().promise);
    await expect.poll(() => record(store, "one"), { interval: 2 }).not.toBeNull();

    /* Another node, whose clock is well past this holder's last restamp, takes
       the lock over. */
    const ahead = ctxWith(store, CLOCK_START_MS + SPACE.staleMs * 5);
    const stolen = await acquireLock(ahead.ctx, SPACE, "one", FOREIGN);

    const error = await rejectsWith(() => held, "lease-lost");
    expect(error.detail).toContain(HOLDER);
    /* And it removed nothing on its way out: what is at that name now belongs to
       whoever holds it. */
    expect(await record(store, "one")).toEqual(stolen.lock);
  });
});

describe("where a lock lives", () => {
  it("keeps the fleet's own locks apart from the ones an ingress takes", () => {
    /* The names under the TLS prefix come from a caller through
       `/v1/storage/locks`; these are the fleet's own, and no caller may reach
       across into them. */
    expect(pointerLockKey("shop", "prod")).toBe("_scafo/locks/pointer/shop/prod.json");
    expect(tlsLockKey("issue/example.com")).toBe("_scafo/tls/locks/issue/example.com");
    expect(pointerLockKey("shop", "prod").startsWith("_scafo/tls/")).toBe(false);
    expect(tlsLockKey("locks/pointer/shop/prod.json").startsWith(locksPrefix())).toBe(false);
  });

  it("addresses one environment's pointer lock, and nothing else", () => {
    expect(POINTER_LOCK_SPACE.keyOf(pointerLockName("shop", "prod"))).toBe(
      pointerLockKey("shop", "prod"),
    );

    for (const name of ["shop", "shop/prod/extra", "Shop/prod", "shop/PROD", ""]) {
      expect(() => POINTER_LOCK_SPACE.keyOf(name), name).toThrow(ScafoError);
    }
  });

  it("waits on the same durations wherever it is taken", () => {
    for (const space of [POINTER_LOCK_SPACE, TLS_LOCK_SPACE]) {
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
    };

    expect(isLockStale(lock, new Date(CLOCK_START_MS + LOCK_STALE_MS - 1), LOCK_STALE_MS)).toBe(
      false,
    );
    expect(isLockStale(lock, new Date(CLOCK_START_MS + LOCK_STALE_MS), LOCK_STALE_MS)).toBe(true);
  });

  it("counts a record it cannot read a time out of as stale", () => {
    /* Nobody is coming back for a record whose stamp means nothing, and refusing
       every later attempt over it would be worse than taking it over. */
    const lock: NamedLock = { holder: HOLDER, acquiredAt: "", refreshedAt: "whenever" };

    expect(isLockStale(lock, new Date(CLOCK_START_MS), LOCK_STALE_MS)).toBe(true);
  });
});

/* ---- fixtures ---- */

function world(): { store: MemoryCasStore; clock: ManualClock } {
  const store = new MemoryCasStore();
  return { store, clock: ctxWith(store) };
}

/** One request for the test lock, with whatever a case wants to change about it. */
function request(opts?: { name?: string; timeoutMs?: number }): {
  space: LockSpace;
  name: string;
  holder: string;
  timeoutMs: number;
} {
  return {
    space: SPACE,
    name: opts?.name ?? "one",
    holder: HOLDER,
    timeoutMs: opts?.timeoutMs ?? 0,
  };
}

/** The lock record as it stands in the bucket, or null when the name is free. */
async function record(store: MemoryCasStore, name: string): Promise<NamedLock | null> {
  const found = await readJson<NamedLock>({ store }, SPACE.keyOf(name));
  return found?.value ?? null;
}

function work(): Promise<string> {
  return Promise.resolve("done");
}

/** Long enough for a waiting caller to have polled several times over. */
function settle(): Promise<void> {
  return elapse(SPACE.pollMs * 4);
}

/** Real elapsed time, whatever the wall clock a case is faking says. */
function elapse(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A wall clock a case can JUMP, which is a thing that happens to a running node:
 * an NTP correction, a resumed virtual machine, an operator setting the date.
 *
 * `Date` alone is faked, so the polls and the sleeps a wait is spent on stay
 * real elapsed time — that separation IS the case — and it is left tracking real
 * time so a `setSystemTime` call is the only thing that ever moves it out of
 * step. The registry's own clock is the manual one and is untouched by any of
 * this, so staleness is still decided by hand as everywhere else in this file.
 */
function steppableWallClock(): void {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, advanceTimeDelta: 1 });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}
