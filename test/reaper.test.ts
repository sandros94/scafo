/* The reaper only deletes retired applications and old deployment history. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createApplication,
  createDeployment,
  createDeployRecord,
  DEFAULT_RETIREMENT_GRACE_MS,
  DEPLOY_RECORD_RETENTION_MS,
  executeReap,
  getApplication,
  getDeployRecord,
  heartbeatNode,
  type LeaseHandle,
  NODE_LIVENESS_WINDOW_MS,
  planReap,
  type ReapOptions,
  registerNode,
  retireApplication,
  unretireApplication,
  updateDeployRecord,
} from "../src/core/registry/index.ts";
import {
  applicationKey,
  deploymentKey,
  deployKey,
  domainKey,
  fleetPrefix,
} from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const APPLICATION = "preview";
const KEEPER = "prod";
const VERSION = "b1b1b1b1";
const HOUR_MS = 3_600_000;
const RETENTION_MS = 1_800_000;
const FLEET_KEYS = [
  `${fleetPrefix(APPLICATION)}/node-a.json`,
  `${fleetPrefix(APPLICATION)}/state/routes.json`,
];
/* `fleets/preview` is a prefix of `fleets/preview2`; only one is meant. */
const SURVIVOR = `${fleetPrefix(APPLICATION)}2/keep.json`;

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;
let opts: ReapOptions;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);

  await createApplication(clock.ctx, { name: KEEPER });
  await createApplication(clock.ctx, { name: APPLICATION });
  await createDeployment(clock.ctx, APPLICATION, { version: VERSION });
  await recordRevision(clock.ctx, APPLICATION, VERSION);
  for (const key of [...FLEET_KEYS, SURVIVOR]) await store.put(key, "{}");

  clock.tick(HOUR_MS);
  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the reaper fixture could not take the lease");
  lease = acquired;
  opts = { deploymentRetention: { maxAgeMs: RETENTION_MS } };
});

describe("planReap", () => {
  it("keeps every active application, however old", async () => {
    clock.tick(365 * 24 * HOUR_MS);

    const plan = await planReap(clock.ctx, opts);

    expect(plan.applications).toEqual([]);
  });

  it("proposes a retired application only after its grace", async () => {
    await retireApplication(clock.ctx, APPLICATION);
    expect((await planReap(clock.ctx, opts)).applications).toEqual([]);

    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);
    const plan = await planReap(clock.ctx, opts);

    expect(plan.applications).toEqual([
      expect.objectContaining({
        application: APPLICATION,
        reason: expect.stringContaining("retired at"),
      }),
    ]);
  });

  it("honours an explicitly shorter retirement grace", async () => {
    await retireApplication(clock.ctx, KEEPER);
    clock.tick(HOUR_MS);

    const plan = await planReap(clock.ctx, { ...opts, graceMs: HOUR_MS });

    expect(plan.applications.map((target) => target.application)).toEqual([KEEPER]);
  });

  it("treats deployments as immutable history governed only by retention", async () => {
    expect((await planReap(clock.ctx)).deployments).toEqual([]);
    expect((await planReap(clock.ctx, opts)).deployments).toEqual([
      expect.objectContaining({ version: VERSION, reason: expect.stringContaining("old") }),
    ]);
  });
});

describe("executeReap", () => {
  async function retiredPlan(): Promise<Awaited<ReturnType<typeof planReap>>> {
    await retireApplication(clock.ctx, APPLICATION);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);
    return planReap(clock.ctx, opts);
  }

  it("deletes references before the retired application record", async () => {
    const host = "preview.example.com";
    await claimDomain(clock.ctx, host, APPLICATION);
    const plan = await retiredPlan();

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).toEqual([
      domainKey(host),
      ...FLEET_KEYS,
      deploymentKey(APPLICATION, VERSION),
      applicationKey(APPLICATION),
    ]);
    await expect(checkDomain(clock.ctx, host)).resolves.toBeNull();
    await rejectsWith(() => getApplication(clock.ctx, APPLICATION), "not-found");
    /* A name that merely starts with the deleted one keeps its fleet keys. */
    await expect(store.get(SURVIVOR)).resolves.not.toBeNull();
    await invariants(store);
  });

  it("re-checks retirement and spares an application taken back", async () => {
    const plan = await retiredPlan();
    await unretireApplication(clock.ctx, APPLICATION);

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.deleted).not.toContain(applicationKey(APPLICATION));
    expect(result.skipped).toContainEqual({
      target: applicationKey(APPLICATION),
      reason: expect.stringContaining("no longer retired past its grace"),
    });
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      name: APPLICATION,
    });
  });

  it("skips an application already removed by another actor", async () => {
    const plan = await retiredPlan();
    await inner.del(applicationKey(APPLICATION));

    const result = await executeReap(clock.ctx, plan, lease, opts);

    expect(result.skipped).toContainEqual({
      target: applicationKey(APPLICATION),
      reason: "application no longer exists",
    });
  });

  it("deletes nothing after the coordinator lease is superseded", async () => {
    const plan = await retiredPlan();
    const stolen = await acquireLease(clock.ctx, "node-b");
    expect(stolen).not.toBeNull();

    const deletesBefore = store.dels;
    await rejectsWith(() => executeReap(clock.ctx, plan, lease, opts), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      name: APPLICATION,
    });
  });
});

describe("deploy records", () => {
  const NODE = "node-a";
  const RUNNING = `${APPLICATION}.a1b2c3d4e5f60718`;
  const FINISHED = `${APPLICATION}.00112233445566ff`;
  const NEIGHBOURS = `${KEEPER}.0f0f0f0f0f0f0f0f`;

  /** A node of this fleet that has just said it is still there. */
  async function beating(id: string): Promise<void> {
    await registerNode(clock.ctx, {
      v: 1,
      id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: id },
      addresses: { internal: "10.0.0.9", apiPort: 7400 },
      heartbeatAt: new Date(clock.nowMs()).toISOString(),
    });
  }

  /** A deploy still on its way, accepted by `node`. */
  async function running(node: string = NODE): Promise<void> {
    await createDeployRecord(clock.ctx, APPLICATION, { id: RUNNING, node });
  }

  /** A deploy that finished, and has been sitting in the registry ever since. */
  async function finished(): Promise<void> {
    await createDeployRecord(clock.ctx, APPLICATION, { id: FINISHED, node: NODE });
    await updateDeployRecord(clock.ctx, APPLICATION, FINISHED, {
      state: "deployed",
      deployment: VERSION,
    });
  }

  describe("a deploy whose node stopped answering", () => {
    it("is failed, saying which node went and what it was doing", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);

      const plan = await planReap(clock.ctx, opts);
      expect(plan.staleDeploys).toEqual([
        expect.objectContaining({ application: APPLICATION, id: RUNNING }),
      ]);

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.failed).toEqual([deployKey(APPLICATION, RUNNING)]);
      await expect(getDeployRecord(clock.ctx, APPLICATION, RUNNING)).resolves.toMatchObject({
        state: "failed",
        code: "deploy-timeout",
        detail: `node "${NODE}" stopped answering while this deploy was accepted`,
      });
    });

    it("counts a node this installation has no record of as gone", async () => {
      await running("ghost-1");
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);

      const plan = await planReap(clock.ctx, opts);
      await executeReap(clock.ctx, plan, lease, opts);

      await expect(getDeployRecord(clock.ctx, APPLICATION, RUNNING)).resolves.toMatchObject({
        state: "failed",
        detail: expect.stringContaining(`node "ghost-1"`),
      });
    });

    it("leaves a deploy alone while the node that took it still answers", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      await heartbeatNode(clock.ctx, NODE);

      const plan = await planReap(clock.ctx, opts);

      expect(plan.staleDeploys).toEqual([]);
      await expect(getDeployRecord(clock.ctx, APPLICATION, RUNNING)).resolves.toMatchObject({
        state: "accepted",
      });
    });

    it("leaves a deploy alone that has moved inside the liveness window", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      /* The node is quiet, but the deploy itself wrote a moment ago. */
      await updateDeployRecord(clock.ctx, APPLICATION, RUNNING, { state: "uploading" });

      expect((await planReap(clock.ctx, opts)).staleDeploys).toEqual([]);
    });

    it("leaves a deploy alone that has already finished", async () => {
      await finished();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);

      expect((await planReap(clock.ctx, opts)).staleDeploys).toEqual([]);
    });

    it("spares one whose node is answering again by the time the plan runs", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      const plan = await planReap(clock.ctx, opts);
      await heartbeatNode(clock.ctx, NODE);

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.failed).toEqual([]);
      expect(result.skipped).toContainEqual({
        target: deployKey(APPLICATION, RUNNING),
        reason: expect.stringContaining("answering"),
      });
      await expect(getDeployRecord(clock.ctx, APPLICATION, RUNNING)).resolves.toMatchObject({
        state: "accepted",
      });
    });

    it("spares one that finished between the plan and the run", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      const plan = await planReap(clock.ctx, opts);
      await updateDeployRecord(clock.ctx, APPLICATION, RUNNING, {
        state: "deployed",
        deployment: VERSION,
      });

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.failed).toEqual([]);
      await expect(getDeployRecord(clock.ctx, APPLICATION, RUNNING)).resolves.toMatchObject({
        state: "deployed",
      });
    });

    it("writes nothing once the coordinator lease is superseded", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      const plan = await planReap(clock.ctx, opts);
      expect(await acquireLease(clock.ctx, "node-b")).not.toBeNull();

      await rejectsWith(() => executeReap(clock.ctx, plan, lease, opts), "lease-lost");

      await expect(getDeployRecord(clock.ctx, APPLICATION, RUNNING)).resolves.toMatchObject({
        state: "accepted",
      });
    });
  });

  describe("a deploy that finished long ago", () => {
    it("is deleted once it is past its retention", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);

      const plan = await planReap(clock.ctx, opts);
      expect(plan.deploys).toEqual([
        expect.objectContaining({
          application: APPLICATION,
          id: FINISHED,
          reason: "604800s old",
        }),
      ]);

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.deleted).toContain(deployKey(APPLICATION, FINISHED));
      await rejectsWith(() => getDeployRecord(clock.ctx, APPLICATION, FINISHED), "not-found");
    });

    it("is kept while it is still inside the window", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS - 1);

      expect((await planReap(clock.ctx, opts)).deploys).toEqual([]);
    });

    it("is kept while it is still running, however old it is", async () => {
      await beating(NODE);
      await running();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);
      await heartbeatNode(clock.ctx, NODE);

      expect((await planReap(clock.ctx, opts)).deploys).toEqual([]);
    });

    it("is spared when it is reopened between the plan and the run", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);
      const plan = await planReap(clock.ctx, opts);
      /* Another deploy takes the id's place in the window the plan was made in. */
      await store.del(deployKey(APPLICATION, FINISHED));
      await createDeployRecord(clock.ctx, APPLICATION, { id: FINISHED, node: NODE });

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.deleted).not.toContain(deployKey(APPLICATION, FINISHED));
      expect(result.skipped).toContainEqual({
        target: deployKey(APPLICATION, FINISHED),
        reason: expect.stringContaining("retention"),
      });
    });

    it("is skipped once something else has already deleted it", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);
      const plan = await planReap(clock.ctx, opts);
      await inner.del(deployKey(APPLICATION, FINISHED));

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.skipped).toContainEqual({
        target: deployKey(APPLICATION, FINISHED),
        reason: expect.stringContaining("no longer exists"),
      });
    });

    it("deletes nothing once the coordinator lease is superseded", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);
      const plan = await planReap(clock.ctx, opts);
      expect(await acquireLease(clock.ctx, "node-b")).not.toBeNull();

      await rejectsWith(() => executeReap(clock.ctx, plan, lease, opts), "lease-lost");

      await expect(getDeployRecord(clock.ctx, APPLICATION, FINISHED)).resolves.toMatchObject({
        state: "deployed",
      });
    });
  });

  it("goes with the application the deploys were made into", async () => {
    await running();
    await finished();
    await retireApplication(clock.ctx, APPLICATION);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

    const result = await executeReap(clock.ctx, await planReap(clock.ctx, opts), lease, opts);

    expect(result.deleted).toContain(deployKey(APPLICATION, RUNNING));
    expect(result.deleted).toContain(deployKey(APPLICATION, FINISHED));
  });

  it("stays behind when another application of the fleet is deleted", async () => {
    await createDeployRecord(clock.ctx, KEEPER, { id: NEIGHBOURS, node: NODE });
    await retireApplication(clock.ctx, APPLICATION);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

    await executeReap(clock.ctx, await planReap(clock.ctx, opts), lease, opts);

    await expect(getDeployRecord(clock.ctx, KEEPER, NEIGHBOURS)).resolves.toMatchObject({
      application: KEEPER,
    });
  });
});
