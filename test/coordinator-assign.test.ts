/*
 * The coordinator's other duty: deciding which nodes serve which environment, and writing that
 * down only when it changed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { type Coordinator, createCoordinator } from "../src/daemon/coordinator.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  getEnvironment,
  heartbeatNode,
  NODE_LIVENESS_WINDOW_MS,
  readPlacement,
  registerNode,
  retireEnvironment,
  setNodeSelector,
  setReplicas,
  unretireEnvironment,
} from "../src/core/registry/index.ts";
import { deleteKey } from "../src/core/registry/cas.ts";
import { environmentKey, placementKey } from "../src/core/registry/paths.ts";
import type { NodeRecord, NodeSelector, PlacementRecord } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const BUILD = "b1b1b1b1";
const TTL_MS = 15_000;
const NODE_A = "node-a";
const NODE_B = "node-b";

let store: FaultStore;
let clock: ManualClock;
/** Every key written since the last reset; what "no write" is asserted against. */
let written: string[];

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);
  written = [];
  store.onBeforePut = (key: string): void => {
    written.push(key);
  };

  await createProject(clock.ctx, { slug: PROJECT });
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
  for (const id of [NODE_A, NODE_B]) await register(id);
});

describe("assigning environments to nodes", () => {
  it("places a long-lived environment on every live node, as it was served before", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toMatchObject({
      nodes: [NODE_A, NODE_B],
      fence: 1,
    });
  });

  it("places an ephemeral one on a single node", async () => {
    await environmentNamed("preview", { ephemeral: true });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    const placement = await readPlacement(clock.ctx, PROJECT, "preview");
    expect(placement?.nodes).toHaveLength(1);
    expect([NODE_A, NODE_B]).toContain(placement?.nodes[0]);
  });

  it("places on as many nodes as the environment asks for", async () => {
    await environmentNamed("prod");
    await setReplicas(clock.ctx, PROJECT, "prod", 1);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toHaveLength(1);
  });

  it("writes NOTHING on a tick that decided the same thing again", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    clock.tick(TTL_MS / 3);
    written = [];
    await coordinator.runOnce();

    expect(written.filter((key) => key.startsWith("_scafo/placement/"))).toEqual([]);
    expect(coordinator.status().lastAssignment?.skipped).toEqual([
      { target: `${PROJECT}/prod`, reason: "unchanged" },
    ]);
  });

  it("moves an environment off a node that stopped beating", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A, NODE_B]);

    clock.tick(NODE_LIVENESS_WINDOW_MS);
    await heartbeatNode(clock.ctx, NODE_A);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A]);
    expect(coordinator.status().lastAssignment?.live).toEqual([NODE_A]);
    expect(coordinator.status().lastAssignFailure).toBeNull();
  });

  it("takes a node back into service the moment it beats again", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    clock.tick(NODE_LIVENESS_WINDOW_MS);
    await heartbeatNode(clock.ctx, NODE_A);
    await coordinator.runOnce();
    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A]);

    await heartbeatNode(clock.ctx, NODE_B);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A, NODE_B]);
  });
});

describe("assigning under a node selector", () => {
  const FAST: NodeSelector = { tier: "fast" };

  beforeEach(async () => {
    await register(NODE_A, { tier: "fast", region: "eu-west-1" });
    await register(NODE_B, { tier: "slow", region: "eu-west-1" });
  });

  it("places it only on the nodes whose labels the selector names", async () => {
    await environmentNamed("prod", { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A]);
    expect(coordinator.status().lastAssignment?.unplaced).toEqual([]);
  });

  it("picks the replicas it was asked for out of the matching nodes alone", async () => {
    await register("node-c", { tier: "fast", region: "us-east-1" });
    await environmentNamed("prod", { nodeSelector: FAST });
    await setReplicas(clock.ctx, PROJECT, "prod", 1);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    const placed = (await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes ?? [];
    expect(placed).toHaveLength(1);
    expect([NODE_A, "node-c"]).toContain(placed[0]);
  });

  it("leaves an unconstrained environment beside it over the whole fleet", async () => {
    await environmentNamed("prod", { nodeSelector: FAST });
    await environmentNamed("staging");
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A]);
    expect((await readPlacement(clock.ctx, PROJECT, "staging"))?.nodes).toEqual([NODE_A, NODE_B]);
  });

  it("moves the environment on the next tick after the selector changes", async () => {
    await environmentNamed("prod", { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A]);

    await setNodeSelector(clock.ctx, PROJECT, "prod", { tier: "slow" });
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_B]);
  });

  it("puts it back over the whole fleet when the selector is cleared", async () => {
    await environmentNamed("prod", { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await setNodeSelector(clock.ctx, PROJECT, "prod", null);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A, NODE_B]);
  });
});

describe("an environment whose selector no live node satisfies", () => {
  const IMPOSSIBLE: NodeSelector = { gpu: "a100" };

  beforeEach(async () => {
    await register(NODE_A, { tier: "fast" });
    await register(NODE_B, { tier: "slow" });
  });

  it("KEEPS the placement it already had, writing nothing and deleting nothing", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    const before = await readPlacement(clock.ctx, PROJECT, "prod");
    expect(before?.nodes).toEqual([NODE_A, NODE_B]);

    await setNodeSelector(clock.ctx, PROJECT, "prod", IMPOSSIBLE);
    clock.tick(TTL_MS / 3);
    written = [];
    const deletesBefore = store.dels;
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toEqual(before);
    expect(placementWrites()).toEqual([]);
    expect(store.dels).toBe(deletesBefore);
  });

  it("records the failure against that environment, naming the selector", async () => {
    await environmentNamed("prod", { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    const unplaced = coordinator.status().lastAssignment?.unplaced ?? [];
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0].target).toBe(`${PROJECT}/prod`);
    expect(unplaced[0].reason).toBe("placement-unavailable");
    expect(unplaced[0].detail).toContain(`${PROJECT}/prod`);
    expect(unplaced[0].detail).toContain("gpu=a100");
  });

  it("writes no placement at all for one that was never placed", async () => {
    await environmentNamed("prod", { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();
    expect(placementWrites()).toEqual([]);
  });

  it("is not a failure of the PASS: everything else is placed as usual", async () => {
    await environmentNamed("prod", { nodeSelector: IMPOSSIBLE });
    await environmentNamed("staging");
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(coordinator.status().holding).toBe(true);
    expect((await readPlacement(clock.ctx, PROJECT, "staging"))?.nodes).toEqual([NODE_A, NODE_B]);
    expect(coordinator.status().lastAssignment?.changed).toEqual([
      { target: `${PROJECT}/staging`, nodes: [NODE_A, NODE_B] },
    ]);
  });

  it("places it the moment a node that satisfies it turns up", async () => {
    await environmentNamed("prod", { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();

    await register("node-gpu", { gpu: "a100" });
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual(["node-gpu"]);
    expect(coordinator.status().lastAssignment?.unplaced).toEqual([]);
  });

  it("still removes the placement of one that is RETIRED, selector or not", async () => {
    await environmentNamed("prod", { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);
    await register("node-gpu", { gpu: "a100" });
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).not.toBeNull();

    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();
  });
});

describe("what the coordinator refuses to decide", () => {
  it("leaves every placement standing when NO node is live", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    const before = await readPlacement(clock.ctx, PROJECT, "prod");

    clock.tick(NODE_LIVENESS_WINDOW_MS * 10);
    written = [];
    await coordinator.runOnce();

    expect(coordinator.status().lastAssignFailure).toContain("No node is live");
    expect(coordinator.status().lastAssignment).toBeNull();
    expect(written.filter((key) => key.startsWith("_scafo/placement/"))).toEqual([]);
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toEqual(before);
  });

  it("decides nothing at all while another node holds the lease", async () => {
    await environmentNamed("prod");
    expect(await acquireLease(clock.ctx, NODE_B, { ttlMs: TTL_MS })).not.toBeNull();
    const candidate = coordinatorFor(NODE_A);

    await candidate.runOnce();

    expect(candidate.status().holding).toBe(false);
    expect(candidate.status().lastAssignAt).toBeNull();
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();
  });

  it("stops before deciding anything once its renewal is refused", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    clock.tick(3_600_000);
    expect(await acquireLease(clock.ctx, NODE_B, { ttlMs: TTL_MS })).not.toBeNull();
    await heartbeatNode(clock.ctx, NODE_A);
    written = [];
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(false);
    expect(written.filter((key) => key.startsWith("_scafo/placement/"))).toEqual([]);
  });

  it("keeps the lease and reaps anyway when the assignment fails", async () => {
    await environmentNamed("preview", { ephemeral: true });
    await retireEnvironment(clock.ctx, PROJECT, "preview");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    clock.tick(86_400_001);
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(true);
    expect(coordinator.status().lastAssignFailure).toContain("No node is live");
    expect(coordinator.status().lastReapFailure).toBeNull();
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    expect(await readPlacement(clock.ctx, PROJECT, "preview")).toBeNull();
  });
});

describe("a decision another coordinator got to first", () => {
  it("skips the raced decision and continues the independent assignment pass", async () => {
    await environmentNamed("prod");
    await environmentNamed("staging");
    await setReplicas(clock.ctx, PROJECT, "prod", 1);
    await setReplicas(clock.ctx, PROJECT, "staging", 1);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    const key = placementKey(PROJECT, "prod");
    await setReplicas(clock.ctx, PROJECT, "prod", 2);
    await setReplicas(clock.ctx, PROJECT, "staging", 2);
    store.onBeforePut = async (touched: string): Promise<void> => {
      written.push(touched);
      if (touched !== key) return;
      store.onBeforePut = (again: string): void => {
        written.push(again);
      };
      await store.put(key, JSON.stringify(rival()));
    };

    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment).toMatchObject({
      changed: [{ target: `${PROJECT}/staging`, nodes: [NODE_A, NODE_B] }],
      skipped: [{ target: `${PROJECT}/prod`, reason: "cas-conflict" }],
    });
    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toMatchObject({ nodes: [NODE_B] });
    expect(await readPlacement(clock.ctx, PROJECT, "staging")).toMatchObject({
      nodes: [NODE_A, NODE_B],
    });
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();
    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(coordinator.status().lastAssignment?.changed).toEqual([
      { target: `${PROJECT}/prod`, nodes: [NODE_A, NODE_B] },
    ]);
    expect(coordinator.status().holding).toBe(true);
  });
});

describe("placements of environments that are gone", () => {
  it("removes the decision of an environment that vanished without being deleted here", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await deleteKey(clock.ctx, environmentKey(PROJECT, "prod"));
    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment?.removed).toEqual([placementKey(PROJECT, "prod")]);
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();
  });

  it("leaves the placements of environments that are still there alone", async () => {
    await environmentNamed("prod");
    await environmentNamed("staging");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await deleteKey(clock.ctx, environmentKey(PROJECT, "staging"));
    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment?.removed).toEqual([
      placementKey(PROJECT, "staging"),
    ]);
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).not.toBeNull();
  });
});

describe("placements of environments that are retired", () => {
  it("gives a retired environment no nodes, and takes its placement away", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).not.toBeNull();

    await retireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();
    expect(coordinator.status().lastAssignment?.removed).toEqual([placementKey(PROJECT, "prod")]);
    expect(coordinator.status().lastAssignment?.changed).toEqual([]);
  });

  it("writes no placement for one that was retired before it was ever placed", async () => {
    await environmentNamed("prod");
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();
    expect(written.filter((key) => key.startsWith("_scafo/placement/"))).toEqual([]);
  });

  it("places it again on the next tick after it is taken back", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await retireEnvironment(clock.ctx, PROJECT, "prod");
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toBeNull();

    await unretireEnvironment(clock.ctx, PROJECT, "prod");
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A, NODE_B]);
  });

  it("leaves the environments beside it entirely alone", async () => {
    await environmentNamed("prod");
    await environmentNamed("staging");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await retireEnvironment(clock.ctx, PROJECT, "staging");
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, PROJECT, "staging")).toBeNull();
    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A, NODE_B]);
  });
});

/** A coordinator for `nodeId`, assigning on every tick against the shared store. */
function coordinatorFor(nodeId: string): Coordinator {
  return createCoordinator(daemonFor(nodeId), { ttlMs: TTL_MS, reapIntervalMs: 0 });
}

function daemonFor(nodeId: string, observability?: DaemonContext["observability"]): DaemonContext {
  return {
    config: daemonConfig(nodeId),
    nodeId,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: "0.0.0-test",
    versions: { scafo: "0.0.0-test", celld: "0.5.0" },
    ...(observability === undefined ? {} : { observability }),
  };
}

/** An environment with a build to serve, so it is a real placement target. */
async function environmentNamed(
  name: string,
  opts?: { ephemeral?: boolean; nodeSelector?: NodeSelector },
): Promise<void> {
  await createEnvironment(clock.ctx, PROJECT, {
    name,
    ...(opts?.ephemeral === undefined ? {} : { ephemeral: opts.ephemeral }),
    ...(opts?.nodeSelector === undefined ? {} : { nodeSelector: opts.nodeSelector }),
  });
  await recordDeployment(clock.ctx, PROJECT, name, BUILD);
}

/** Registers `id` as a node that has just beaten, carrying `labels` if any. */
async function register(id: string, labels?: Record<string, string>): Promise<NodeRecord> {
  return registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `key-${id}` },
    addresses: { internal: `10.0.0.${id === NODE_A ? "1" : "2"}`, apiPort: 7400 },
    heartbeatAt: new Date(clock.nowMs()).toISOString(),
    ...(labels === undefined ? {} : { labels }),
  });
}

/** The placement keys a pass wrote, which is what "wrote nothing" is asserted against. */
function placementWrites(): string[] {
  return written.filter((key) => key.startsWith("_scafo/placement/"));
}

/** The decision the competing coordinator wrote, at the same fence. */
function rival(): PlacementRecord {
  return {
    v: 1,
    nodes: [NODE_B],
    decidedAt: new Date(clock.nowMs()).toISOString(),
    fence: 1,
  };
}

function daemonConfig(nodeId: string): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: nodeId, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** Runs nothing: the coordinator loop never touches the supervisor. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
