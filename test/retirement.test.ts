/* Retiring an application, taking it back, and the rule that decides when it may finally be deleted. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  createApplication,
  createDeployment,
  DEFAULT_RETIREMENT_GRACE_MS,
  deleteApplication,
  getApplication,
  type LeaseHandle,
  retireApplication,
  retirementState,
  unretireApplication,
} from "../src/core/registry/index.ts";
import { applicationKey } from "../src/core/registry/paths.ts";
import type { ApplicationRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  ctxWith,
  FaultStore,
  invariants,
  type ManualClock,
  rejectionOf,
  rejectsWith,
} from "./_helpers.ts";

const APPLICATION = "shop";
const VERSION = "b1b1b1b1";
const HOUR_MS = 3_600_000;
const GRACE_MS = DEFAULT_RETIREMENT_GRACE_MS;

let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);

  await createApplication(clock.ctx, { name: APPLICATION });
  await createDeployment(clock.ctx, APPLICATION, { version: VERSION });
  await recordRevision(clock.ctx, APPLICATION, VERSION);

  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("retiring and taking it back", () => {
  it("stamps the application, leaving everything else it carries alone", async () => {
    const before = await getApplication(clock.ctx, APPLICATION);

    const retired = await retireApplication(clock.ctx, APPLICATION);

    expect(retired).toEqual({ ...before, retiredAt: new Date(clock.nowMs()).toISOString() });
    /* Its deployment and its domains are untouched: retirement takes an
       application out of service, it does not begin taking it apart. */
    expect(retired.deployment?.revision).toBe(1);
  });

  it("keeps the FIRST timestamp when it is retired again", async () => {
    const first = await retireApplication(clock.ctx, APPLICATION);
    clock.tick(HOUR_MS * 6);

    const again = await retireApplication(clock.ctx, APPLICATION);

    /*
     * The detail that makes retirement idempotent in the way that matters.
     * Restamping would restart the grace, so a retry — or an operator running
     * the command twice — would push the deletion a full day out, and a scripted
     * "retire, wait, delete" would never reach its last step.
     */
    expect(again.retiredAt).toBe(first.retiredAt);
  });

  it("clears the stamp outright rather than emptying it", async () => {
    await retireApplication(clock.ctx, APPLICATION);

    const restored = await unretireApplication(clock.ctx, APPLICATION);

    /* Absent, not `null` or `""`: every reader tests for the field's presence,
       and a falsy value left behind would read as retired to a stricter one. */
    expect(Object.hasOwn(restored, "retiredAt")).toBe(false);
    expect(await getApplication(clock.ctx, APPLICATION)).toEqual(restored);
  });

  it("survives the round trip, and starts a fresh grace when retired again", async () => {
    const first = await retireApplication(clock.ctx, APPLICATION);
    await unretireApplication(clock.ctx, APPLICATION);
    clock.tick(HOUR_MS * 6);

    const second = await retireApplication(clock.ctx, APPLICATION);

    /* A new decision, and it gets the whole grace: the application went back
       into service in between, and what was learned about the first retirement
       says nothing about this one. */
    expect(second.retiredAt).not.toBe(first.retiredAt);
    expect(retirementState(second, new Date(clock.nowMs()))?.remainingMs).toBe(GRACE_MS);
  });

  it("leaves an application nobody retired exactly as it is", async () => {
    const before = await getApplication(clock.ctx, APPLICATION);

    expect(await unretireApplication(clock.ctx, APPLICATION)).toEqual(before);
  });

  it("refuses either call on an application that is not there", async () => {
    expect((await rejectionOf(() => retireApplication(clock.ctx, "ghost"))).code).toBe("not-found");
    expect((await rejectionOf(() => unretireApplication(clock.ctx, "ghost"))).code).toBe(
      "not-found",
    );
  });
});

describe("retirementState", () => {
  it("counts the grace down from the moment it was retired", async () => {
    await retireApplication(clock.ctx, APPLICATION);
    clock.tick(HOUR_MS * 6);
    const application = await getApplication(clock.ctx, APPLICATION);

    expect(retirementState(application, new Date(clock.nowMs()))).toMatchObject({
      elapsedMs: HOUR_MS * 6,
      remainingMs: GRACE_MS - HOUR_MS * 6,
      expired: false,
    });
  });

  it("reports nothing at all for an application that is not retired", async () => {
    const application = await getApplication(clock.ctx, APPLICATION);

    expect(retirementState(application, new Date(clock.nowMs()))).toBeNull();
  });

  it("holds a stamp nothing can parse inside its grace rather than past it", async () => {
    /* A timestamp nothing can read is not evidence that a day has passed, and
       the safe reading of a damaged record is the one that deletes nothing. */
    const damaged: ApplicationRecord = {
      ...(await getApplication(clock.ctx, APPLICATION)),
      retiredAt: "whenever",
    };

    expect(retirementState(damaged, new Date(clock.nowMs()))).toMatchObject({
      remainingMs: GRACE_MS,
      expired: false,
    });
  });
});

describe("what deleteApplication will act on", () => {
  it("deletes a retired application once its grace has run out", async () => {
    await retireApplication(clock.ctx, APPLICATION);
    clock.tick(GRACE_MS);

    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease);

    expect(deleted).toContain(applicationKey(APPLICATION));
    await invariants(store);
  });

  it("deletes anything at all when the caller forces it", async () => {
    const deletesBefore = store.dels;

    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease, { force: true });

    /* Never retired: force is the one path that discards an application in a
       single call. */
    expect(deleted).toContain(applicationKey(APPLICATION));
    expect(store.dels).toBeGreaterThan(deletesBefore);
    await invariants(store);
  });

  it("forces past a grace that has barely started", async () => {
    await retireApplication(clock.ctx, APPLICATION);

    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease, { force: true });

    expect(deleted).toContain(applicationKey(APPLICATION));
  });

  it("honours a grace the caller shortened", async () => {
    await retireApplication(clock.ctx, APPLICATION);
    clock.tick(HOUR_MS);

    await rejectsWith(
      () => deleteApplication(clock.ctx, APPLICATION, lease, { graceMs: HOUR_MS * 2 }),
      "invalid-input",
    );
    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease, {
      graceMs: HOUR_MS,
    });

    expect(deleted).toContain(applicationKey(APPLICATION));
  });
});

describe("what it refuses, and what it tells the operator to do about it", () => {
  it("refuses a long-lived application nobody retired, naming both routes on", async () => {
    const deletesBefore = store.dels;

    const error = await rejectsWith(
      () => deleteApplication(clock.ctx, APPLICATION, lease),
      "invalid-input",
    );

    /* 409 rather than 400: the request is well-formed, the application is simply
       not in a state this call may act on. */
    expect(error.status).toBe(409);
    expect(error.detail).toContain(`"${APPLICATION}"`);
    expect(error.detail).toContain("scafo app retire");
    expect(error.detail).toContain("force");
    /* The wait it is asking for, in the unit an operator plans around. */
    expect(error.detail).toContain("24h");
    expect(store.dels).toBe(deletesBefore);
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      name: APPLICATION,
    });
    await invariants(store);
  });

  it("refuses one still inside its grace, saying how much of it is left", async () => {
    const retired = await retireApplication(clock.ctx, APPLICATION);
    clock.tick(HOUR_MS * 6);
    const deletesBefore = store.dels;

    const error = await rejectsWith(
      () => deleteApplication(clock.ctx, APPLICATION, lease),
      "invalid-input",
    );

    expect(error.status).toBe(409);
    /* When it was retired, what remains, and the way back — the three things an
       operator holding this answer actually needs. */
    expect(error.detail).toContain(retired.retiredAt as string);
    expect(error.detail).toContain("18h");
    expect(error.detail).toContain("scafo app unretire");
    expect(error.detail).toContain("force");
    expect(store.dels).toBe(deletesBefore);
    await invariants(store);
  });

  it("refuses one whose stamp cannot be read, which force still gets past", async () => {
    await store.put(
      applicationKey(APPLICATION),
      JSON.stringify({
        ...(await getApplication(clock.ctx, APPLICATION)),
        retiredAt: "whenever",
      }),
    );

    const error = await rejectsWith(
      () => deleteApplication(clock.ctx, APPLICATION, lease),
      "invalid-input",
    );
    expect(error.detail).toContain("whenever");

    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease, { force: true });
    expect(deleted).toContain(applicationKey(APPLICATION));
  });

  it("still refuses an application that is not there, before any of this", async () => {
    /* Force is about the state of an application, not about conjuring one: a
       typo in a name must not be answered as a successful deletion. */
    const error = await rejectionOf(() =>
      deleteApplication(clock.ctx, "ghost", lease, { force: true }),
    );

    expect(error.code).toBe("not-found");
  });

  it("still refuses once the lease has been taken away, forced or not", async () => {
    clock.tick(HOUR_MS);
    expect(await acquireLease(clock.ctx, "node-b")).not.toBeNull();
    const deletesBefore = store.dels;

    await rejectsWith(
      () => deleteApplication(clock.ctx, APPLICATION, lease, { force: true }),
      "lease-lost",
    );

    /* Force skips the retirement rule and nothing else. The lease is what keeps
       two deleters apart, and no flag an operator can pass is allowed past it. */
    expect(store.dels).toBe(deletesBefore);
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      name: APPLICATION,
    });
  });
});
