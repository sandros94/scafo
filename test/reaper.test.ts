/* The reaper only deletes retired environments and old deployment history. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_RETIREMENT_GRACE_MS,
  executeReap,
  getEnvironment,
  type LeaseHandle,
  planReap,
  type ReapOptions,
  retireEnvironment,
  unretireEnvironment,
} from "../src/core/registry/index.ts";
import { buildKey, domainKey, environmentKey, fleetPrefix } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const BUILD = "b1b1b1b1";
const HOUR_MS = 3_600_000;
const RETENTION_MS = 1_800_000;
const FLEET_KEYS = [
  `${fleetPrefix(PROJECT, "preview")}/node-a.json`,
  `${fleetPrefix(PROJECT, "preview")}/state/routes.json`,
];
const SURVIVOR = `${fleetPrefix(PROJECT, "preview")}2/keep.json`;

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;
let opts: ReapOptions;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: "prod" });
  await createEnvironment(clock.ctx, PROJECT, { name: "preview", ephemeral: true });
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
  await recordDeployment(clock.ctx, PROJECT, "preview", BUILD);
  for (const key of [...FLEET_KEYS, SURVIVOR]) await store.put(key, "{}");

  clock.tick(HOUR_MS);
  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the reaper fixture could not take the lease");
  lease = acquired;
  opts = { buildRetention: { maxAgeMs: RETENTION_MS } };
});

describe("planReap", () => {
  it("keeps every active environment, including old ephemeral ones", async () => {
    clock.tick(365 * 24 * HOUR_MS);

    const plan = await planReap(clock.ctx, opts);

    expect(plan.environments).toEqual([]);
  });

  it("proposes a retired environment only after its grace", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "preview");
    expect((await planReap(clock.ctx, opts)).environments).toEqual([]);

    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);
    const plan = await planReap(clock.ctx, opts);

    expect(plan.environments).toEqual([
      expect.objectContaining({ env: "preview", reason: expect.stringContaining("retired at") }),
    ]);
  });

  it("honours an explicitly shorter retirement grace", async () => {
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(HOUR_MS);

    const plan = await planReap(clock.ctx, { ...opts, graceMs: HOUR_MS });

    expect(plan.environments.map((target) => target.env)).toEqual(["prod"]);
  });

  it("treats builds as immutable history governed only by retention", async () => {
    expect((await planReap(clock.ctx)).builds).toEqual([]);
    expect((await planReap(clock.ctx, opts)).builds).toEqual([
      expect.objectContaining({ id: BUILD, reason: expect.stringContaining("old") }),
    ]);
  });
});

describe("executeReap", () => {
  async function retiredPlan(): Promise<Awaited<ReturnType<typeof planReap>>> {
    await retireEnvironment(clock.ctx, PROJECT, "preview");
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);
    return planReap(clock.ctx, opts);
  }

  it("deletes references before the retired environment record", async () => {
    const host = "preview.example.com";
    await claimDomain(clock.ctx, host, PROJECT, "preview");
    const plan = await retiredPlan();

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).toEqual([
      domainKey(host),
      ...FLEET_KEYS,
      environmentKey(PROJECT, "preview"),
      buildKey(PROJECT, BUILD),
    ]);
    await expect(checkDomain(clock.ctx, host)).resolves.toBeNull();
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    await expect(store.get(SURVIVOR)).resolves.not.toBeNull();
    await invariants(store);
  });

  it("re-checks retirement and spares an environment taken back", async () => {
    const plan = await retiredPlan();
    await unretireEnvironment(clock.ctx, PROJECT, "preview");

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).not.toContain(environmentKey(PROJECT, "preview"));
    expect(result.skipped).toContainEqual({
      target: environmentKey(PROJECT, "preview"),
      reason: expect.stringContaining("no longer retired past its grace"),
    });
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
  });

  it("skips an environment already removed by another actor", async () => {
    const plan = await retiredPlan();
    await inner.del(environmentKey(PROJECT, "preview"));

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.skipped).toContainEqual({
      target: environmentKey(PROJECT, "preview"),
      reason: "environment no longer exists",
    });
  });

  it("deletes nothing after the coordinator lease is superseded", async () => {
    const plan = await retiredPlan();
    const stolen = await acquireLease(clock.ctx, "node-b");
    expect(stolen).not.toBeNull();

    const deletesBefore = store.dels;
    await rejectsWith(() => executeReap(clock.ctx, plan, lease, opts), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
  });
});
