/* The reaper only deletes retired environments and old deployment history. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createDeployment,
  createDeployRecord,
  createEnvironment,
  createProject,
  DEFAULT_RETIREMENT_GRACE_MS,
  DEPLOY_RECORD_RETENTION_MS,
  executeReap,
  getDeployRecord,
  getEnvironment,
  heartbeatNode,
  type LeaseHandle,
  NODE_LIVENESS_WINDOW_MS,
  planReap,
  type ReapOptions,
  registerNode,
  retireEnvironment,
  unretireEnvironment,
  updateDeployRecord,
} from "../src/core/registry/index.ts";
import {
  deploymentKey,
  deployKey,
  domainKey,
  environmentKey,
  fleetPrefix,
} from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const VERSION = "b1b1b1b1";
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
  await createDeployment(clock.ctx, PROJECT, { version: VERSION });
  await recordRevision(clock.ctx, PROJECT, "preview", VERSION);
  for (const key of [...FLEET_KEYS, SURVIVOR]) await store.put(key, "{}");

  clock.tick(HOUR_MS);
  const acquired = await acquireLease(clock.ctx, "node-a");
  if (acquired === null) throw new Error("the reaper fixture could not take the lease");
  lease = acquired;
  opts = { deploymentRetention: { maxAgeMs: RETENTION_MS } };
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

  it("treats deployments as immutable history governed only by retention", async () => {
    expect((await planReap(clock.ctx)).deployments).toEqual([]);
    expect((await planReap(clock.ctx, opts)).deployments).toEqual([
      expect.objectContaining({ version: VERSION, reason: expect.stringContaining("old") }),
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
      deploymentKey(PROJECT, VERSION),
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

describe("deploy records", () => {
  const NODE = "node-a";
  const RUNNING = `${PROJECT}.a1b2c3d4e5f60718`;
  const FINISHED = `${PROJECT}.00112233445566ff`;

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
    await createDeployRecord(clock.ctx, PROJECT, {
      id: RUNNING,
      environment: "preview",
      node,
    });
  }

  /** A deploy that finished, and has been sitting in the registry ever since. */
  async function finished(): Promise<void> {
    await createDeployRecord(clock.ctx, PROJECT, {
      id: FINISHED,
      environment: "preview",
      node: NODE,
    });
    await updateDeployRecord(clock.ctx, PROJECT, FINISHED, {
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
        expect.objectContaining({ project: PROJECT, id: RUNNING }),
      ]);

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.failed).toEqual([deployKey(PROJECT, RUNNING)]);
      await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
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

      await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
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
      await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
        state: "accepted",
      });
    });

    it("leaves a deploy alone that has moved inside the liveness window", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      /* The node is quiet, but the deploy itself wrote a moment ago. */
      await updateDeployRecord(clock.ctx, PROJECT, RUNNING, { state: "uploading" });

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
        target: deployKey(PROJECT, RUNNING),
        reason: expect.stringContaining("answering"),
      });
      await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
        state: "accepted",
      });
    });

    it("spares one that finished between the plan and the run", async () => {
      await beating(NODE);
      await running();
      clock.tick(NODE_LIVENESS_WINDOW_MS + 1);
      const plan = await planReap(clock.ctx, opts);
      await updateDeployRecord(clock.ctx, PROJECT, RUNNING, {
        state: "deployed",
        deployment: VERSION,
      });

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.failed).toEqual([]);
      await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
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

      await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
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
        expect.objectContaining({ project: PROJECT, id: FINISHED, reason: "604800s old" }),
      ]);

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.deleted).toContain(deployKey(PROJECT, FINISHED));
      await rejectsWith(() => getDeployRecord(clock.ctx, PROJECT, FINISHED), "not-found");
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
      await store.del(deployKey(PROJECT, FINISHED));
      await createDeployRecord(clock.ctx, PROJECT, {
        id: FINISHED,
        environment: "preview",
        node: NODE,
      });

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.deleted).not.toContain(deployKey(PROJECT, FINISHED));
      expect(result.skipped).toContainEqual({
        target: deployKey(PROJECT, FINISHED),
        reason: expect.stringContaining("retention"),
      });
    });

    it("is skipped once something else has already deleted it", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);
      const plan = await planReap(clock.ctx, opts);
      await inner.del(deployKey(PROJECT, FINISHED));

      const result = await executeReap(clock.ctx, plan, lease, opts);

      expect(result.skipped).toContainEqual({
        target: deployKey(PROJECT, FINISHED),
        reason: expect.stringContaining("no longer exists"),
      });
    });

    it("deletes nothing once the coordinator lease is superseded", async () => {
      await finished();
      clock.tick(DEPLOY_RECORD_RETENTION_MS);
      const plan = await planReap(clock.ctx, opts);
      expect(await acquireLease(clock.ctx, "node-b")).not.toBeNull();

      await rejectsWith(() => executeReap(clock.ctx, plan, lease, opts), "lease-lost");

      await expect(getDeployRecord(clock.ctx, PROJECT, FINISHED)).resolves.toMatchObject({
        state: "deployed",
      });
    });
  });

  it("goes with the environment the deploys were made into", async () => {
    await running();
    await finished();
    await retireEnvironment(clock.ctx, PROJECT, "preview");
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

    const result = await executeReap(clock.ctx, await planReap(clock.ctx, opts), lease, opts);

    expect(result.deleted).toContain(deployKey(PROJECT, RUNNING));
    expect(result.deleted).toContain(deployKey(PROJECT, FINISHED));
  });

  it("stays behind when another environment of the project is deleted", async () => {
    await running();
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS);

    await executeReap(clock.ctx, await planReap(clock.ctx, opts), lease, opts);

    await expect(getDeployRecord(clock.ctx, PROJECT, RUNNING)).resolves.toMatchObject({
      environment: "preview",
    });
  });
});
