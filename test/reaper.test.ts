/* The reaper only ever deletes what nothing points at, and re-checks that under fault. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireLease,
  type ActivitySource,
  checkDomain,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  executeReap,
  flipAlias,
  getEnvironment,
  type LeaseHandle,
  planReap,
  type ReapOptions,
  setSplit,
} from "../src/core/registry/index.ts";
import {
  artifactKey,
  buildKey,
  domainKey,
  environmentKey,
  fleetPrefix,
} from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const B1 = "b1b1b1b1";
const B2 = "b2b2b2b2";
const B3 = "b3b3b3b3";
const B4 = "b4b4b4b4";
const HOUR_MS = 3_600_000;
const RETENTION_MS = 1_800_000;

const FLEET_KEYS = [
  `${fleetPrefix(PROJECT, "preview")}/node-a.json`,
  `${fleetPrefix(PROJECT, "preview")}/state/routes.json`,
];
/* Sibling prefixes must survive: `fleets/app/preview` is a prefix of `fleets/app/preview2`. */
const SURVIVORS = [
  `${fleetPrefix(PROJECT, "preview")}2/keep.json`,
  `fleets/${PROJECT}/prod/keep.json`,
];

/** Last-request timestamps the reaper reads; unset environments fall back to their records. */
class FakeActivity implements ActivitySource {
  readonly #seen = new Map<string, Date>();

  set(project: string, env: string, at: Date): void {
    this.#seen.set(`${project}/${env}`, at);
  }

  lastActiveAt(project: string, env: string): Promise<Date | null> {
    return Promise.resolve(this.#seen.get(`${project}/${env}`) ?? null);
  }
}

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;
let activity: FakeActivity;
let lease: LeaseHandle;
let opts: ReapOptions;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);
  activity = new FakeActivity();

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: "prod" });
  await createEnvironment(clock.ctx, PROJECT, {
    name: "preview",
    ephemeral: true,
    idleTtlS: 900,
  });
  for (const id of [B1, B2, B3, B4]) {
    await createBuild(clock.ctx, PROJECT, { id, runtimeConfigurable: true });
  }

  /* prod serves b1 and can roll back to b2; preview serves b1 with b3 taking a slice. */
  await flipAlias(clock.ctx, PROJECT, "prod", B2);
  await flipAlias(clock.ctx, PROJECT, "prod", B1);
  await flipAlias(clock.ctx, PROJECT, "preview", B1);
  await setSplit(clock.ctx, PROJECT, "preview", [
    { build: B3, weight: 70 },
    { build: B1, weight: 30 },
  ]);

  for (const key of [...FLEET_KEYS, ...SURVIVORS]) await store.put(key, "{}");
  await store.put(artifactKey(PROJECT, B4), "artifact-bytes");

  clock.tick(HOUR_MS);
  activity.set(PROJECT, "prod", new Date(clock.nowMs() - HOUR_MS));
  activity.set(PROJECT, "preview", new Date(clock.nowMs() - HOUR_MS));

  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the reaper fixture could not take the lease");
  lease = acquired;

  opts = { activity, buildRetention: { maxAgeMs: RETENTION_MS } };
});

describe("planReap", () => {
  it("proposes only the idle ephemeral environment and the unreferenced build", async () => {
    const plan = await planReap(clock.ctx, opts);

    expect(plan.environments.map((target) => target.env)).toEqual(["preview"]);
    expect(plan.builds.map((target) => target.id)).toEqual([B4]);
    expect(plan.environments[0].reason).toContain("idle");
    expect(plan.builds[0].reason).toContain("unreferenced");
  });

  it("never proposes a build an alias, its previous or a split leg points at", async () => {
    const plan = await planReap(clock.ctx, opts);
    const proposed = plan.builds.map((target) => target.id);

    for (const referenced of [B1, B2, B3]) expect(proposed).not.toContain(referenced);
  });

  it("proposes no build at all without a retention window", async () => {
    const plan = await planReap(clock.ctx, { activity });

    expect(plan.builds).toEqual([]);
    expect(plan.environments.map((target) => target.env)).toEqual(["preview"]);
  });

  it("leaves the ephemeral environment alone while it is still being used", async () => {
    activity.set(PROJECT, "preview", new Date(clock.nowMs()));
    const plan = await planReap(clock.ctx, opts);

    expect(plan.environments).toEqual([]);
  });

  it("never proposes a non-ephemeral environment, however idle", async () => {
    clock.tick(365 * 24 * HOUR_MS);
    const plan = await planReap(clock.ctx, opts);

    expect(plan.environments.map((target) => target.env)).not.toContain("prod");
  });
});

describe("executeReap", () => {
  it("deletes the environment, its fleet keys and the build with its artifact", async () => {
    const plan = await planReap(clock.ctx, opts);
    const result = await executeReap(clock.ctx, plan, lease, opts);

    /* Fleet keys go first and the environment record last, so a crash mid-run
       leaves the environment for the next plan to pick up again. */
    expect(result.deleted).toEqual([
      ...FLEET_KEYS,
      environmentKey(PROJECT, "preview"),
      buildKey(PROJECT, B4),
      artifactKey(PROJECT, B4),
    ]);
    expect(result.skipped).toEqual([]);

    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    await expect(store.get(artifactKey(PROJECT, B4))).resolves.toBeNull();
    for (const key of SURVIVORS) await expect(store.get(key)).resolves.not.toBeNull();
    await expect(getEnvironment(clock.ctx, PROJECT, "prod")).resolves.toMatchObject({
      alias: { build: B1, previous: B2 },
    });
    await invariants(store);
  });

  it("skips a build that picked up a reference between planning and deleting", async () => {
    const plan = await planReap(clock.ctx, opts);
    await flipAlias(clock.ctx, PROJECT, "prod", B4);

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).not.toContain(buildKey(PROJECT, B4));
    expect(result.skipped).toContainEqual({
      target: buildKey(PROJECT, B4),
      reason: expect.stringContaining("referenced"),
    });
    await expect(store.get(artifactKey(PROJECT, B4))).resolves.not.toBeNull();
    await invariants(store);
  });

  it("skips an environment that took traffic between planning and deleting", async () => {
    const plan = await planReap(clock.ctx, opts);
    activity.set(PROJECT, "preview", new Date(clock.nowMs()));

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).not.toContain(environmentKey(PROJECT, "preview"));
    expect(result.skipped).toContainEqual({
      target: environmentKey(PROJECT, "preview"),
      reason: expect.stringContaining("no longer idle"),
    });
    for (const key of FLEET_KEYS) await expect(store.get(key)).resolves.not.toBeNull();
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
    await invariants(store);
  });

  it("skips an environment somebody else already deleted", async () => {
    const plan = await planReap(clock.ctx, opts);
    await inner.del(environmentKey(PROJECT, "preview"));

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.skipped).toContainEqual({
      target: environmentKey(PROJECT, "preview"),
      reason: expect.stringContaining("no longer exists"),
    });
  });

  it("releases the domains of the environment it reaps", async () => {
    const host = "preview.example.com";
    await claimDomain(clock.ctx, host, PROJECT, "preview");
    await invariants(store);

    const plan = await planReap(clock.ctx, opts);
    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).toContain(environmentKey(PROJECT, "preview"));
    expect(result.deleted).toContain(domainKey(host));
    /* Claims are released before the environment record disappears, so a crash
       mid-run never orphans a claim planReap would no longer revisit. */
    expect(result.deleted.indexOf(domainKey(host))).toBeLessThan(
      result.deleted.indexOf(environmentKey(PROJECT, "preview")),
    );
    await expect(checkDomain(clock.ctx, host)).resolves.toBeNull();
    await invariants(store);
  });

  it("leaves a domain another environment took over alone", async () => {
    const host = "preview.example.com";
    await claimDomain(clock.ctx, host, PROJECT, "preview");
    const plan = await planReap(clock.ctx, opts);

    /* The claim moves on while the plan is in flight; the reaper must not delete it. */
    await inner.put(
      domainKey(host),
      JSON.stringify({ v: 1, project: PROJECT, environment: "prod", claimedAt: "2026-01-01" }),
    );

    const result = await executeReap(clock.ctx, plan, lease, opts);
    expect(result.deleted).not.toContain(domainKey(host));
    await expect(checkDomain(clock.ctx, host)).resolves.toMatchObject({ environment: "prod" });
  });

  it("deletes nothing once the lease has been taken away", async () => {
    const plan = await planReap(clock.ctx, opts);
    clock.tick(HOUR_MS);
    const stolen = await acquireLease(clock.ctx, "node-b");
    expect(stolen).not.toBeNull();

    const deletesBefore = store.dels;
    await rejectsWith(() => executeReap(clock.ctx, plan, lease, opts), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
    await invariants(store);
  });
});
