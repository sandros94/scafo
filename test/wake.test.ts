/*
 * Wake stamps: when an environment was last asked for.
 *
 * Parked-ness itself is never stored — every reader derives it from a stamp's
 * age — so there is no state machine here to get out of step, and the only
 * question a stamp ever answers is "when". A stamp that cannot answer it is the
 * case worth reading twice: it keeps NOTHING awake, because a stamp exists to
 * hold something up and one that says nothing holds nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  putJson,
  readEnvironmentWake,
  stampEnvironmentWake,
  wakeActivity,
  type WakeStamp,
} from "../src/core/registry/index.ts";
import { envWakeKey } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const PROJECT = "app";
const PREVIEW = "preview";
const OTHER_ENV = "prod";
const MINUTE_MS = 60_000;

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("an environment's wake", () => {
  it("reads back the moment it was stamped, on the clock the node was given", async () => {
    await stampEnvironmentWake(clock.ctx, PROJECT, PREVIEW);

    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
  });

  it("moves forward every time it is stamped again", async () => {
    await stampEnvironmentWake(clock.ctx, PROJECT, PREVIEW);
    clock.tick(MINUTE_MS * 5);

    await stampEnvironmentWake(clock.ctx, PROJECT, PREVIEW);

    /* Last writer wins, deliberately outside the CAS discipline: two nodes
       stamping the same wake differ by milliseconds and either value keeps the
       environment awake. */
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
  });

  it("answers null for an environment nothing has ever woken", async () => {
    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toBeNull();
  });

  it("answers null for a stamp nothing can parse, rather than a date at the epoch", async () => {
    /* A damaged stamp must read as "never woken" and not as "woken in 1970":
       the caller's fallback is the environment's own timestamps, while an epoch
       date would park the environment on the spot. */
    await putJson<WakeStamp>(clock.ctx, envWakeKey(PROJECT, PREVIEW), { at: "whenever" });

    await expect(readEnvironmentWake(clock.ctx, PROJECT, PREVIEW)).resolves.toBeNull();
  });

  it("keeps one environment's stamp out of another's", async () => {
    await stampEnvironmentWake(clock.ctx, PROJECT, PREVIEW);

    await expect(readEnvironmentWake(clock.ctx, PROJECT, OTHER_ENV)).resolves.toBeNull();
  });
});

describe("wakeActivity", () => {
  it("reports the environment's own stamp as its last activity", async () => {
    await stampEnvironmentWake(clock.ctx, PROJECT, PREVIEW);

    await expect(wakeActivity(clock.ctx).lastActiveAt(PROJECT, PREVIEW)).resolves.toEqual(
      await readEnvironmentWake(clock.ctx, PROJECT, PREVIEW),
    );
  });

  it("reports nothing for one that was never woken, leaving the fallback to the reaper", async () => {
    /* The fallback for an environment with no stamp — its current deployment, then its
       creation — stays where it always was, in the reaper itself, so an
       installation that has never stamped anything reaps exactly as it did. */
    await expect(wakeActivity(clock.ctx).lastActiveAt(PROJECT, PREVIEW)).resolves.toBeNull();
  });
});
