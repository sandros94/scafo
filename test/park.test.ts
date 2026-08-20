/*
 * How an environment scales to zero: the decisions an operator states, and what
 * the environment's kind implies about every blank they left.
 *
 * The rule this file turns on reads like a special case and is not. A LONG-LIVED
 * ENVIRONMENT NEVER PARKS ON A CLOCK: a stamp is written when something is
 * woken, a warm environment is never woken, so a clock against the last stamp
 * would stop one under live traffic. `setParkPolicy` refuses to write the field
 * on one, and `resolveParkPolicy` resolves it to `0` anyway — the belt over the
 * braces, for records some other writer produced.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createEnvironment,
  createProject,
  DEFAULT_BUILD_IDLE_S,
  DEFAULT_EPHEMERAL_PARK_AFTER_S,
  DEFAULT_WAKE_DEADLINE_S,
  getEnvironment,
  putJson,
  resolveParkPolicy,
  setNodeSelector,
  setParkPolicy,
} from "../src/core/registry/index.ts";
import { environmentKey } from "../src/core/registry/paths.ts";
import type { EnvironmentRecord, ParkPolicy } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
/** Long-lived: the one that never parks on a clock. */
const PROD = "prod";
/** Ephemeral: the one the whole feature is for. */
const PREVIEW = "preview";

let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: PROD });
  await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });
});

describe("resolveParkPolicy", () => {
  it("fills an ephemeral environment's blanks with what its kind implies", async () => {
    const environment = await getEnvironment(clock.ctx, PROJECT, PREVIEW);

    expect(resolveParkPolicy(environment)).toEqual({
      afterS: DEFAULT_EPHEMERAL_PARK_AFTER_S,
      recallBuilds: true,
      buildIdleS: DEFAULT_BUILD_IDLE_S,
      wakeDeadlineS: DEFAULT_WAKE_DEADLINE_S,
    });
    /* Named rather than spelled out, so the numbers live in one place. */
    expect([DEFAULT_EPHEMERAL_PARK_AFTER_S, DEFAULT_BUILD_IDLE_S, DEFAULT_WAKE_DEADLINE_S]).toEqual(
      [900, 300, 30],
    );
  });

  it("keeps every field the operator did state", async () => {
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, {
      afterS: 60,
      recallBuilds: false,
      buildIdleS: 30,
      wakeDeadlineS: 5,
    });

    expect(resolveParkPolicy(await getEnvironment(clock.ctx, PROJECT, PREVIEW))).toEqual({
      afterS: 60,
      recallBuilds: false,
      buildIdleS: 30,
      wakeDeadlineS: 5,
    });
  });

  it("resolves a long-lived environment's window to 0 WHATEVER its record says", async () => {
    /*
     * The belt behind {@link setParkPolicy}'s refusal, and it is deliberately
     * not the same check: this one covers a record written by anything else at
     * all — an older build, a hand-edited object, a future feature — because a
     * long-lived environment parked on a clock is one taken off the air under
     * live traffic that no stamp ever reflected.
     */
    await writeRecord(PROD, { park: { afterS: 60 } });

    expect(resolveParkPolicy(await getEnvironment(clock.ctx, PROJECT, PROD)).afterS).toBe(0);
  });

  it("still resolves the recall fields of a long-lived environment", async () => {
    /* Only the clock is refused one. Waking a superseded build at its own host
       is a request answering itself and works on any environment. */
    await setParkPolicy(clock.ctx, PROJECT, PROD, { recallBuilds: false, buildIdleS: 45 });

    expect(resolveParkPolicy(await getEnvironment(clock.ctx, PROJECT, PROD))).toEqual({
      afterS: 0,
      recallBuilds: false,
      buildIdleS: 45,
      wakeDeadlineS: DEFAULT_WAKE_DEADLINE_S,
    });
  });
});

describe("setParkPolicy", () => {
  it("stores the fields it was given and nothing else, leaving the record alone", async () => {
    const before = await getEnvironment(clock.ctx, PROJECT, PREVIEW);

    const updated = await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { afterS: 60 });

    /* A policy states an operator's decisions; writing a resolved default beside
       them would freeze today's default into an environment that never asked. */
    expect(updated).toEqual({ ...before, park: { afterS: 60 } });
    expect(await getEnvironment(clock.ctx, PROJECT, PREVIEW)).toEqual(updated);
  });

  it("replaces the whole policy rather than merging into it", async () => {
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { afterS: 60, buildIdleS: 30 });

    const updated = await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { buildIdleS: 45 });

    /* One statement of how this environment scales to zero: merging would leave
       an operator unable to take a decision back off again. */
    expect(updated.park).toEqual({ buildIdleS: 45 });
  });

  it("clears it by REMOVING the field, not by storing an empty one", async () => {
    await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { afterS: 60 });

    const cleared = await setParkPolicy(clock.ctx, PROJECT, PREVIEW, null);

    /* Readers ask what an environment's kind implies once it carries no policy
       of its own, so a `{}` left behind would be a policy that says nothing. */
    expect("park" in cleared).toBe(false);
    expect(await getEnvironment(clock.ctx, PROJECT, PREVIEW)).toEqual(cleared);
  });

  it("clears one that was never set, without complaint", async () => {
    const cleared = await setParkPolicy(clock.ctx, PROJECT, PREVIEW, null);

    expect("park" in cleared).toBe(false);
  });

  it("refuses a window on a long-lived environment, naming what does work on one", async () => {
    const putsBefore = store.puts;

    const error = await rejectsWith(
      () => setParkPolicy(clock.ctx, PROJECT, PROD, { afterS: 60 }),
      "invalid-input",
    );

    /* The refusal has to carry the reason: an operator who reads only the rule
       goes looking for the flag that turns it off, and there is not one. */
    expect(error.detail).toContain(`"${PROJECT}/${PROD}"`);
    expect(error.detail).toContain("live traffic");
    expect(error.detail).toContain("recallBuilds");
    expect(store.puts).toBe(putsBefore);
    expect((await getEnvironment(clock.ctx, PROJECT, PROD)).park).toBeUndefined();
  });

  it("refuses a window of 0 on a long-lived one too, rather than reading it as agreement", async () => {
    /* `afterS: 0` happens to resolve to what a long-lived environment already
       does, but stating it is still stating a clock this environment has no
       business carrying — and the field would outlive whoever wrote it. */
    await rejectsWith(
      () => setParkPolicy(clock.ctx, PROJECT, PROD, { afterS: 0 }),
      "invalid-input",
    );
  });

  it.each([
    { afterS: 1.5 },
    { afterS: -1 },
    { buildIdleS: -30 },
    { buildIdleS: Number.NaN },
    { wakeDeadlineS: 2.5 },
  ])("refuses %p, which is not a whole number of seconds", async (policy) => {
    const putsBefore = store.puts;

    const error = await rejectsWith(
      () => setParkPolicy(clock.ctx, PROJECT, PREVIEW, policy),
      "invalid-input",
    );

    expect(error.detail).toContain("whole number of seconds");
    expect(store.puts).toBe(putsBefore);
    expect((await getEnvironment(clock.ctx, PROJECT, PREVIEW)).park).toBeUndefined();
  });

  it("refuses a wake deadline of 0, which no wake could ever meet", async () => {
    const error = await rejectsWith(
      () => setParkPolicy(clock.ctx, PROJECT, PREVIEW, { wakeDeadlineS: 0 }),
      "invalid-input",
    );

    /* A request held for no time at all is a request answered 503 before the
       wake it is waiting for has begun. */
    expect(error.detail).toContain("wakeDeadlineS");
  });

  it("takes a window of 0, which is how an ephemeral environment is kept warm", async () => {
    const updated = await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { afterS: 0 });

    expect(updated.park).toEqual({ afterS: 0 });
    expect(resolveParkPolicy(updated).afterS).toBe(0);
  });

  it.each(["true", 1, null])(
    "refuses recallBuilds %p, which is not true or false",
    async (value) => {
      const error = await rejectsWith(
        () =>
          setParkPolicy(clock.ctx, PROJECT, PREVIEW, {
            recallBuilds: value,
          } as unknown as ParkPolicy),
        "invalid-input",
      );

      /* A flag that guesses what "1" meant is a flag that misreads a typo as an
       instruction. */
      expect(error.detail).toContain("recallBuilds");
      expect((await getEnvironment(clock.ctx, PROJECT, PREVIEW)).park).toBeUndefined();
    },
  );

  it("refuses an environment that is not there", async () => {
    const error = await rejectsWith(
      () => setParkPolicy(clock.ctx, PROJECT, "ghost", { afterS: 60 }),
      "not-found",
    );

    expect(error.detail).toContain(environmentKey(PROJECT, "ghost"));
  });

  it("carries a change that raced it rather than dropping either", async () => {
    /* One conditional update on the environment record: a write that lands
       between the read and the put takes the If-Match with it, and the retry
       re-reads, so the two decisions end up on the record together instead of
       the later one erasing the earlier. */
    store.onBeforePut = async (key: string): Promise<void> => {
      if (key !== environmentKey(PROJECT, PREVIEW)) return;
      store.onBeforePut = undefined;
      await setNodeSelector(clock.ctx, PROJECT, PREVIEW, { tier: "fast" });
    };

    const updated = await setParkPolicy(clock.ctx, PROJECT, PREVIEW, { afterS: 60 });

    expect(updated.park).toEqual({ afterS: 60 });
    expect(updated.nodeSelector).toEqual({ tier: "fast" });
    expect(await getEnvironment(clock.ctx, PROJECT, PREVIEW)).toEqual(updated);
  });
});

/** Writes an environment record straight into the bucket, as another writer would. */
async function writeRecord(name: string, patch: Partial<EnvironmentRecord>): Promise<void> {
  const current = await getEnvironment(clock.ctx, PROJECT, name);
  await putJson<EnvironmentRecord>(clock.ctx, environmentKey(PROJECT, name), {
    ...current,
    ...patch,
  });
}
