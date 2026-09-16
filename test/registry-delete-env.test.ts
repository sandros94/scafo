/*
 * Deleting an environment because an operator said so: what it refuses, the order it takes things
 * apart in, and what a lease taken away mid-run leaves.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createBuild,
  createDeployRecord,
  createEnvironment,
  createProject,
  deleteEnvironment,
  getDeployRecord,
  getEnvironment,
  type LeaseHandle,
} from "../src/core/registry/index.ts";
import { deployKey, domainKey, environmentKey, fleetPrefix } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const BUILD = "b1b1b1b1";
const HOST = "preview.example.com";
const HOUR_MS = 3_600_000;

const FLEET_KEYS = [
  `${fleetPrefix(PROJECT, "preview")}/node-a.json`,
  `${fleetPrefix(PROJECT, "preview")}/state/routes.json`,
];
/* `fleets/app/preview` is a prefix of `fleets/app/preview2`; only one is meant. */
const SURVIVORS = [
  `${fleetPrefix(PROJECT, "preview")}2/keep.json`,
  `fleets/${PROJECT}/prod/keep.json`,
];

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: "prod" });
  await createEnvironment(clock.ctx, PROJECT, { name: "preview", ephemeral: true });
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
  await recordDeployment(clock.ctx, PROJECT, "preview", BUILD);

  for (const key of [...FLEET_KEYS, ...SURVIVORS]) await store.put(key, "{}");

  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("deleteEnvironment", () => {
  it("refuses a non-ephemeral environment, and deletes nothing at all", async () => {
    const deletesBefore = store.dels;

    const error = await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "prod", lease),
      "invalid-input",
    );

    /* 409 rather than 400: the request is well-formed, the environment is simply
       not in a state this call may act on. */
    expect(error.status).toBe(409);
    expect(error.detail).toContain("ephemeral");
    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "prod")).resolves.toMatchObject({
      name: "prod",
    });
    await invariants(store);
  });

  it("deletes the claims, then the fleet keys, then the record", async () => {
    await claimDomain(clock.ctx, HOST, PROJECT, "preview");

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    expect(deleted).toEqual([domainKey(HOST), ...FLEET_KEYS, environmentKey(PROJECT, "preview")]);
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    for (const key of SURVIVORS) await expect(store.get(key)).resolves.not.toBeNull();
    await invariants(store);
  });

  it("deletes an ephemeral environment without retirement", async () => {
    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    expect(deleted).toContain(environmentKey(PROJECT, "preview"));
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
  });

  it("leaves a domain another environment took over alone", async () => {
    await claimDomain(clock.ctx, HOST, PROJECT, "preview");
    /* The claim moves on before the delete reaches it; it belongs to prod now. */
    await inner.put(
      domainKey(HOST),
      JSON.stringify({ v: 1, project: PROJECT, environment: "prod", claimedAt: "2026-01-01" }),
    );

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    expect(deleted).not.toContain(domainKey(HOST));
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ environment: "prod" });
  });

  it("takes the deploy records of that environment with it, and no others", async () => {
    const mine = `${PROJECT}.a1b2c3d4e5f60718`;
    const theirs = `${PROJECT}.00112233445566ff`;
    await createDeployRecord(clock.ctx, PROJECT, {
      id: mine,
      environment: "preview",
      node: "node-a",
    });
    await createDeployRecord(clock.ctx, PROJECT, {
      id: theirs,
      environment: "prod",
      node: "node-a",
    });

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    expect(deleted).toContain(deployKey(PROJECT, mine));
    /* Deploy records are filed per project, and prod is still there. */
    expect(deleted).not.toContain(deployKey(PROJECT, theirs));
    await expect(getDeployRecord(clock.ctx, PROJECT, theirs)).resolves.toMatchObject({
      environment: "prod",
    });
  });

  it("refuses an environment that is not there", async () => {
    const error = await rejectsWith(
      () => deleteEnvironment(clock.ctx, PROJECT, "ghost", lease),
      "not-found",
    );

    expect(error.detail).toContain(environmentKey(PROJECT, "ghost"));
  });

  it("deletes nothing once the lease has been taken away", async () => {
    clock.tick(HOUR_MS);
    const stolen = await acquireLease(clock.ctx, "node-b");
    expect(stolen).not.toBeNull();

    const deletesBefore = store.dels;
    await rejectsWith(() => deleteEnvironment(clock.ctx, PROJECT, "preview", lease), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
    for (const key of FLEET_KEYS) await expect(store.get(key)).resolves.not.toBeNull();
    await invariants(store);
  });

  it("stops at the step the lease was lost on, leaving the record for the next pass", async () => {
    await claimDomain(clock.ctx, HOST, PROJECT, "preview");

    /* Taken away after the claim has been released, while the fleet keys are
       going: the environment record must survive, because a record deleted
       ahead of its claims is one nothing would ever revisit. */
    store.onBeforeDel = async (key: string): Promise<void> => {
      if (!key.startsWith(fleetPrefix(PROJECT, "preview"))) return;
      store.onBeforeDel = undefined;
      clock.tick(HOUR_MS);
      await acquireLease(clock.ctx, "node-b");
    };

    await rejectsWith(() => deleteEnvironment(clock.ctx, PROJECT, "preview", lease), "lease-lost");

    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
      /* Released before the record was touched, so nothing is left pointing at
         a claim that is gone and the next attempt starts from a consistent one. */
      domains: [],
    });
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    await invariants(store);
  });
});
