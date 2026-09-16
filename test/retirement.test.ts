/* Retiring an environment, taking it back, and the rule that decides when it may finally be deleted. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_RETIREMENT_GRACE_MS,
  deleteEnvironment,
  getEnvironment,
  type LeaseHandle,
  retireEnvironment,
  retirementState,
  unretireEnvironment,
} from "../src/core/registry/index.ts";
import { environmentKey } from "../src/core/registry/paths.ts";
import type { EnvironmentRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  ctxWith,
  FaultStore,
  invariants,
  type ManualClock,
  rejectionOf,
  rejectsWith,
} from "./_helpers.ts";

const PROJECT = "app";
const BUILD = "b1b1b1b1";
const HOUR_MS = 3_600_000;
const GRACE_MS = DEFAULT_RETIREMENT_GRACE_MS;

let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
  await createEnvironment(clock.ctx, PROJECT, { name: "prod" });
  await createEnvironment(clock.ctx, PROJECT, { name: "preview", ephemeral: true });
  await recordDeployment(clock.ctx, PROJECT, "prod", BUILD);

  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("retiring and taking it back", () => {
  it("stamps the environment, leaving everything else it carries alone", async () => {
    const before = await getEnvironment(clock.ctx, PROJECT, "prod");

    const retired = await retireEnvironment(clock.ctx, PROJECT, "prod");

    expect(retired).toEqual({ ...before, retiredAt: new Date(clock.nowMs()).toISOString() });
    /* Its build, its domains and its varset are untouched: retirement takes an
       environment out of service, it does not begin taking it apart. */
    expect(retired.deployment?.revision).toBe(1);
  });

  it("keeps the FIRST timestamp when it is retired again", async () => {
    const first = await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(HOUR_MS * 6);

    const again = await retireEnvironment(clock.ctx, PROJECT, "prod");

    /*
     * The detail that makes retirement idempotent in the way that matters.
     * Restamping would restart the grace, so a retry — or an operator running
     * the command twice — would push the deletion a full day out, and a scripted
     * "retire, wait, delete" would never reach its last step.
     */
    expect(again.retiredAt).toBe(first.retiredAt);
  });

  it("clears the stamp outright rather than emptying it", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "prod");

    const restored = await unretireEnvironment(clock.ctx, PROJECT, "prod");

    /* Absent, not `null` or `""`: every reader tests for the field's presence,
       and a falsy value left behind would read as retired to a stricter one. */
    expect(Object.hasOwn(restored, "retiredAt")).toBe(false);
    expect(await getEnvironment(clock.ctx, PROJECT, "prod")).toEqual(restored);
  });

  it("survives the round trip, and starts a fresh grace when retired again", async () => {
    const first = await retireEnvironment(clock.ctx, PROJECT, "prod");
    await unretireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(HOUR_MS * 6);

    const second = await retireEnvironment(clock.ctx, PROJECT, "prod");

    /* A new decision, and it gets the whole grace: the environment went back
       into service in between, and what was learned about the first retirement
       says nothing about this one. */
    expect(second.retiredAt).not.toBe(first.retiredAt);
    expect(retirementState(second, new Date(clock.nowMs()))?.remainingMs).toBe(GRACE_MS);
  });

  it("leaves an environment nobody retired exactly as it is", async () => {
    const before = await getEnvironment(clock.ctx, PROJECT, "prod");

    expect(await unretireEnvironment(clock.ctx, PROJECT, "prod")).toEqual(before);
  });

  it("refuses either call on an environment that is not there", async () => {
    expect((await rejectionOf(() => retireEnvironment(clock.ctx, PROJECT, "ghost"))).code).toBe(
      "not-found",
    );
    expect((await rejectionOf(() => unretireEnvironment(clock.ctx, PROJECT, "ghost"))).code).toBe(
      "not-found",
    );
  });
});

describe("retirementState", () => {
  it("counts the grace down from the moment it was retired", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(HOUR_MS * 6);
    const environment = await getEnvironment(clock.ctx, PROJECT, "prod");

    expect(retirementState(environment, new Date(clock.nowMs()))).toMatchObject({
      elapsedMs: HOUR_MS * 6,
      remainingMs: GRACE_MS - HOUR_MS * 6,
      expired: false,
    });
  });

  it("reports nothing at all for an environment that is not retired", async () => {
    const environment = await getEnvironment(clock.ctx, PROJECT, "prod");

    expect(retirementState(environment, new Date(clock.nowMs()))).toBeNull();
  });

  it("holds a stamp nothing can parse inside its grace rather than past it", async () => {
    /* A timestamp nothing can read is not evidence that a day has passed, and
       the safe reading of a damaged record is the one that deletes nothing. */
    const damaged: EnvironmentRecord = {
      ...(await getEnvironment(clock.ctx, PROJECT, "prod")),
      retiredAt: "whenever",
    };

    expect(retirementState(damaged, new Date(clock.nowMs()))).toMatchObject({
      remainingMs: GRACE_MS,
      expired: false,
    });
  });
});

describe("what deleteEnvironment will act on", () => {
  it("deletes an ephemeral environment, as it always has", async () => {
    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    expect(deleted).toContain(environmentKey(PROJECT, "preview"));
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    await invariants(store);
  });

  it("deletes a retired environment once its grace has run out", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(GRACE_MS);

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "prod", lease);

    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
    await invariants(store);
  });

  it("deletes anything at all when the caller forces it", async () => {
    const deletesBefore = store.dels;

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "prod", lease, { force: true });

    /* Neither ephemeral nor retired: force is the one path that discards a
       long-lived environment in a single call. */
    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
    expect(store.dels).toBeGreaterThan(deletesBefore);
    await invariants(store);
  });

  it("forces past a grace that has barely started", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "prod");

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "prod", lease, { force: true });

    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
  });

  it("honours a grace the caller shortened", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(HOUR_MS);

    await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "prod", lease, { graceMs: HOUR_MS * 2 }),
      "invalid-input",
    );
    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "prod", lease, {
      graceMs: HOUR_MS,
    });

    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
  });
});

describe("what it refuses, and what it tells the operator to do about it", () => {
  it("refuses a long-lived environment nobody retired, naming both routes on", async () => {
    const deletesBefore = store.dels;

    const error = await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "prod", lease),
      "invalid-input",
    );

    /* 409 rather than 400: the request is well-formed, the environment is simply
       not in a state this call may act on. */
    expect(error.status).toBe(409);
    expect(error.detail).toContain(`"${PROJECT}/prod"`);
    expect(error.detail).toContain("scafo env retire");
    expect(error.detail).toContain("force");
    /* The wait it is asking for, in the unit an operator plans around. */
    expect(error.detail).toContain("24h");
    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "prod")).resolves.toMatchObject({
      name: "prod",
    });
    await invariants(store);
  });

  it("refuses one still inside its grace, saying how much of it is left", async () => {
    const retired = await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(HOUR_MS * 6);
    const deletesBefore = store.dels;

    const error = await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "prod", lease),
      "invalid-input",
    );

    expect(error.status).toBe(409);
    /* When it was retired, what remains, and the way back — the three things an
       operator holding this answer actually needs. */
    expect(error.detail).toContain(retired.retiredAt as string);
    expect(error.detail).toContain("18h");
    expect(error.detail).toContain("scafo env unretire");
    expect(error.detail).toContain("force");
    expect(store.dels).toBe(deletesBefore);
    await invariants(store);
  });

  it("refuses one whose stamp cannot be read, which force still gets past", async () => {
    await store.put(
      environmentKey(PROJECT, "prod"),
      JSON.stringify({
        ...(await getEnvironment(clock.ctx, PROJECT, "prod")),
        retiredAt: "whenever",
      }),
    );

    const error = await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "prod", lease),
      "invalid-input",
    );
    expect(error.detail).toContain("whenever");

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "prod", lease, { force: true });
    expect(deleted).toContain(environmentKey(PROJECT, "prod"));
  });

  it("still refuses an environment that is not there, before any of this", async () => {
    /* Force is about the state of an environment, not about conjuring one: a
       typo in a name must not be answered as a successful deletion. */
    const error = await rejectionOf(() =>
      deleteEnvironment(clock.ctx, PROJECT, "ghost", lease, { force: true }),
    );

    expect(error.code).toBe("not-found");
  });

  it("still refuses once the lease has been taken away, forced or not", async () => {
    clock.tick(HOUR_MS);
    expect(await acquireLease(clock.ctx, "node-b")).not.toBeNull();
    const deletesBefore = store.dels;

    await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "prod", lease, { force: true }),
      "lease-lost",
    );

    /* Force skips the retirement rule and nothing else. The lease is what keeps
       two deleters apart, and no flag an operator can pass is allowed past it. */
    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "prod")).resolves.toMatchObject({
      name: "prod",
    });
  });
});
