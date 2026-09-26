/* The fleet's deploy freeze, as the registry holds it. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  assertDeploysUnfrozen,
  FREEZE_REASON_MAX,
  freezeDeploys,
  readFreeze,
  unfreezeDeploys,
} from "../src/core/registry/freeze.ts";
import { freezeKey } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const ADMIN = "op-aaaa1111";
const OTHER = "op-bbbb2222";
const REASON = "celld 0.5.0 upgrade";

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("where the freeze lives", () => {
  it("is one object at the root of the registry, so any node finds it without a listing", () => {
    expect(freezeKey()).toBe("_scafo/freeze.json");
  });
});

describe("freezing deploys", () => {
  it("writes who decided, when, and why", async () => {
    const outcome = await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });

    expect(outcome.created).toBe(true);
    expect(outcome.freeze).toEqual({
      v: 1,
      frozenAt: new Date(clock.nowMs()).toISOString(),
      by: ADMIN,
      reason: REASON,
    });
    await expect(readFreeze(clock.ctx)).resolves.toEqual(outcome.freeze);
  });

  it("leaves the reason off entirely when the admin said nothing", async () => {
    const outcome = await freezeDeploys(clock.ctx, { by: ADMIN });

    expect(outcome.freeze).not.toHaveProperty("reason");
    /* A blank one is nothing said, not an empty reason worth storing. */
    expect(
      (await freezeDeploys(clock.ctx, { by: ADMIN, reason: "   " })).freeze,
    ).not.toHaveProperty("reason");
  });

  it("KEEPS THE FIRST RECORD when a second admin freezes an already frozen fleet", async () => {
    const first = await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });
    clock.tick(60_000);

    const second = await freezeDeploys(clock.ctx, { by: OTHER, reason: "something else" });

    /* Freezing twice is one freeze: the decision standing is the first one, and
       rewriting it would lose who took it and why while intake did not change. */
    expect(second.created).toBe(false);
    expect(second.freeze).toEqual(first.freeze);
    await expect(readFreeze(clock.ctx)).resolves.toEqual(first.freeze);
  });

  it("refuses a reason longer than one line's worth, naming the bound", async () => {
    const error = await rejectsWith(
      () => freezeDeploys(clock.ctx, { by: ADMIN, reason: "x".repeat(FREEZE_REASON_MAX + 1) }),
      "invalid-input",
    );

    expect(error.detail).toContain(String(FREEZE_REASON_MAX));
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });

  it("refuses a reason that is not one line, since every printer prints one", async () => {
    await rejectsWith(
      () => freezeDeploys(clock.ctx, { by: ADMIN, reason: "upgrade\nand also" }),
      "invalid-input",
    );

    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
  });
});

describe("reading and lifting it", () => {
  it("reads null while the fleet takes deploys, and the record once it does not", async () => {
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();

    await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });

    await expect(readFreeze(clock.ctx)).resolves.toMatchObject({ by: ADMIN, reason: REASON });
  });

  it("says whether there was a freeze to lift, and lifts it exactly once", async () => {
    await freezeDeploys(clock.ctx, { by: ADMIN });

    await expect(unfreezeDeploys(clock.ctx)).resolves.toBe(true);
    await expect(readFreeze(clock.ctx)).resolves.toBeNull();
    await expect(unfreezeDeploys(clock.ctx)).resolves.toBe(false);
  });

  it("takes a fresh freeze after one was lifted, with its own stamp", async () => {
    await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });
    await unfreezeDeploys(clock.ctx);
    clock.tick(60_000);

    const again = await freezeDeploys(clock.ctx, { by: OTHER });

    expect(again.created).toBe(true);
    expect(again.freeze).toMatchObject({
      by: OTHER,
      frozenAt: new Date(clock.nowMs()).toISOString(),
    });
    expect(again.freeze).not.toHaveProperty("reason");
  });
});

describe("what a frozen fleet refuses with", () => {
  it("passes an unfrozen fleet through untouched", () => {
    expect(() => {
      assertDeploysUnfrozen(null);
    }).not.toThrow();
  });

  it("names when, by whom, why, and the one command that lifts it", async () => {
    const { freeze } = await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });

    const error = await rejectsWith(
      () => Promise.resolve(assertDeploysUnfrozen(freeze)),
      "deploys-frozen",
    );

    expect(error.status).toBe(409);
    expect(error.detail).toContain(freeze.frozenAt);
    expect(error.detail).toContain(ADMIN);
    expect(error.detail).toContain(REASON);
    expect(error.detail).toContain("scafo fleet unfreeze");
  });

  it("still refuses, and still says how to lift it, when no reason was given", async () => {
    const { freeze } = await freezeDeploys(clock.ctx, { by: ADMIN });

    const error = await rejectsWith(
      () => Promise.resolve(assertDeploysUnfrozen(freeze)),
      "deploys-frozen",
    );

    expect(error.detail).toContain(ADMIN);
    expect(error.detail).toContain("scafo fleet unfreeze");
  });
});
