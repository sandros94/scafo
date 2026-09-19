/*
 * The coordinator's other duty: deciding which nodes serve which application, and writing that
 * down only when it changed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { type Coordinator, createCoordinator } from "../src/daemon/coordinator.ts";
import {
  acquireLease,
  blockApplication,
  createApplication,
  createDeployment,
  getApplication,
  heartbeatNode,
  NODE_LIVENESS_WINDOW_MS,
  readPlacement,
  registerNode,
  retireApplication,
  setNodeSelector,
  setReplicas,
  unblockApplication,
  unretireApplication,
} from "../src/core/registry/index.ts";
import { deleteKey } from "../src/core/registry/cas.ts";
import { applicationKey, placementKey } from "../src/core/registry/paths.ts";
import type { NodeRecord, NodeSelector, PlacementRecord } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { hintingStore } from "../src/core/registry/changes.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const APP = "shop";
const OTHER = "blog";
const VERSION = "b1b1b1b1";
const TTL_MS = 15_000;
const NODE_A = "node-a";
const NODE_B = "node-b";

let store: FaultStore;
let clock: ManualClock;
/** Every key written since the last reset; what "no write" is asserted against. */
let written: string[];

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  /* Hinting, as `createRegistry` builds every registry: a coordinator decides
     from its view, and a view only re-reads what it is told has moved. */
  clock = ctxWith(hintingStore(store));
  written = [];
  store.onBeforePut = (key: string): void => {
    written.push(key);
  };

  for (const id of [NODE_A, NODE_B]) await register(id);
});

describe("assigning applications to nodes", () => {
  it("places a long-lived application on every live node, as it was served before", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, APP)).toMatchObject({
      nodes: [NODE_A, NODE_B],
      fence: 1,
    });
  });

  it("places on as many nodes as the application asks for", async () => {
    await deployed(APP);
    await setReplicas(clock.ctx, APP, 1);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toHaveLength(1);
  });

  it("writes NOTHING on a tick that decided the same thing again", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    clock.tick(TTL_MS / 3);
    written = [];
    await coordinator.runOnce();

    expect(placementWrites()).toEqual([]);
    expect(coordinator.status().lastAssignment?.skipped).toEqual([
      { target: APP, reason: "unchanged" },
    ]);
  });

  it("moves an application off a node that stopped beating", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A, NODE_B]);

    clock.tick(NODE_LIVENESS_WINDOW_MS);
    await heartbeatNode(clock.ctx, NODE_A);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A]);
    expect(coordinator.status().lastAssignment?.live).toEqual([NODE_A]);
    expect(coordinator.status().lastAssignFailure).toBeNull();
  });

  it("takes a node back into service the moment it beats again", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    clock.tick(NODE_LIVENESS_WINDOW_MS);
    await heartbeatNode(clock.ctx, NODE_A);
    await coordinator.runOnce();
    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A]);

    await heartbeatNode(clock.ctx, NODE_B);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A, NODE_B]);
  });
});

describe("assigning under a node selector", () => {
  const FAST: NodeSelector = { tier: "fast" };

  beforeEach(async () => {
    await register(NODE_A, { tier: "fast", region: "eu-west-1" });
    await register(NODE_B, { tier: "slow", region: "eu-west-1" });
  });

  it("places it only on the nodes whose labels the selector names", async () => {
    await deployed(APP, { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A]);
    expect(coordinator.status().lastAssignment?.unplaced).toEqual([]);
  });

  it("picks the replicas it was asked for out of the matching nodes alone", async () => {
    await register("node-c", { tier: "fast", region: "us-east-1" });
    await deployed(APP, { nodeSelector: FAST });
    await setReplicas(clock.ctx, APP, 1);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    const placed = (await readPlacement(clock.ctx, APP))?.nodes ?? [];
    expect(placed).toHaveLength(1);
    expect([NODE_A, "node-c"]).toContain(placed[0]);
  });

  it("leaves an unconstrained application beside it over the whole fleet", async () => {
    await deployed(APP, { nodeSelector: FAST });
    await deployed(OTHER);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A]);
    expect((await readPlacement(clock.ctx, OTHER))?.nodes).toEqual([NODE_A, NODE_B]);
  });

  it("moves the application on the next tick after the selector changes", async () => {
    await deployed(APP, { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A]);

    await setNodeSelector(clock.ctx, APP, { tier: "slow" });
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_B]);
  });

  it("puts it back over the whole fleet when the selector is cleared", async () => {
    await deployed(APP, { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await setNodeSelector(clock.ctx, APP, null);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A, NODE_B]);
  });
});

describe("an application whose selector no live node satisfies", () => {
  const IMPOSSIBLE: NodeSelector = { gpu: "a100" };

  beforeEach(async () => {
    await register(NODE_A, { tier: "fast" });
    await register(NODE_B, { tier: "slow" });
  });

  it("KEEPS the placement it already had, writing nothing and deleting nothing", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    const before = await readPlacement(clock.ctx, APP);
    expect(before?.nodes).toEqual([NODE_A, NODE_B]);

    await setNodeSelector(clock.ctx, APP, IMPOSSIBLE);
    clock.tick(TTL_MS / 3);
    written = [];
    const deletesBefore = store.dels;
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, APP)).toEqual(before);
    expect(placementWrites()).toEqual([]);
    expect(store.dels).toBe(deletesBefore);
  });

  it("records the failure against that application, naming the selector", async () => {
    await deployed(APP, { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    const unplaced = coordinator.status().lastAssignment?.unplaced ?? [];
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0].target).toBe(APP);
    expect(unplaced[0].reason).toBe("placement-unavailable");
    expect(unplaced[0].detail).toContain(APP);
    expect(unplaced[0].detail).toContain("gpu=a100");
  });

  it("writes no placement at all for one that was never placed", async () => {
    await deployed(APP, { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, APP)).toBeNull();
    expect(placementWrites()).toEqual([]);
  });

  it("is not a failure of the PASS: everything else is placed as usual", async () => {
    await deployed(APP, { nodeSelector: IMPOSSIBLE });
    await deployed(OTHER);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(coordinator.status().holding).toBe(true);
    expect((await readPlacement(clock.ctx, OTHER))?.nodes).toEqual([NODE_A, NODE_B]);
    expect(coordinator.status().lastAssignment?.changed).toEqual([
      { target: OTHER, nodes: [NODE_A, NODE_B] },
    ]);
  });

  it("places it the moment a node that satisfies it turns up", async () => {
    await deployed(APP, { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, APP)).toBeNull();

    await register("node-gpu", { gpu: "a100" });
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual(["node-gpu"]);
    expect(coordinator.status().lastAssignment?.unplaced).toEqual([]);
  });

  it("still removes the placement of one that is RETIRED, selector or not", async () => {
    await deployed(APP, { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);
    await register("node-gpu", { gpu: "a100" });
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, APP)).not.toBeNull();

    await retireApplication(clock.ctx, APP);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, APP)).toBeNull();
  });
});

describe("what the coordinator refuses to decide", () => {
  it("leaves every placement standing when NO node is live", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    const before = await readPlacement(clock.ctx, APP);

    clock.tick(NODE_LIVENESS_WINDOW_MS * 10);
    written = [];
    await coordinator.runOnce();

    expect(coordinator.status().lastAssignFailure).toContain("No node is live");
    expect(coordinator.status().lastAssignment).toBeNull();
    expect(placementWrites()).toEqual([]);
    expect(await readPlacement(clock.ctx, APP)).toEqual(before);
  });

  it("decides nothing at all while another node holds the lease", async () => {
    await deployed(APP);
    expect(await acquireLease(clock.ctx, NODE_B, { ttlMs: TTL_MS })).not.toBeNull();
    const candidate = coordinatorFor(NODE_A);

    await candidate.runOnce();

    expect(candidate.status().holding).toBe(false);
    expect(candidate.status().lastAssignAt).toBeNull();
    expect(await readPlacement(clock.ctx, APP)).toBeNull();
  });

  it("stops before deciding anything once its renewal is refused", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    clock.tick(3_600_000);
    expect(await acquireLease(clock.ctx, NODE_B, { ttlMs: TTL_MS })).not.toBeNull();
    await heartbeatNode(clock.ctx, NODE_A);
    written = [];
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(false);
    expect(placementWrites()).toEqual([]);
  });

  it("keeps the lease and reaps anyway when the assignment fails", async () => {
    await deployed(APP);
    await retireApplication(clock.ctx, APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    clock.tick(86_400_001);
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(true);
    expect(coordinator.status().lastAssignFailure).toContain("No node is live");
    expect(coordinator.status().lastReapFailure).toBeNull();
    await rejectsWith(() => getApplication(clock.ctx, APP), "not-found");
    expect(await readPlacement(clock.ctx, APP)).toBeNull();
  });
});

describe("a decision another coordinator got to first", () => {
  it("skips the raced decision and continues the independent assignment pass", async () => {
    await deployed(APP);
    await deployed(OTHER);
    await setReplicas(clock.ctx, APP, 1);
    await setReplicas(clock.ctx, OTHER, 1);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    const key = placementKey(APP);
    await setReplicas(clock.ctx, APP, 2);
    await setReplicas(clock.ctx, OTHER, 2);
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
      changed: [{ target: OTHER, nodes: [NODE_A, NODE_B] }],
      skipped: [{ target: APP, reason: "cas-conflict" }],
    });
    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(await readPlacement(clock.ctx, APP)).toMatchObject({ nodes: [NODE_B] });
    expect(await readPlacement(clock.ctx, OTHER)).toMatchObject({
      nodes: [NODE_A, NODE_B],
    });
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();
    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(coordinator.status().lastAssignment?.changed).toEqual([
      { target: APP, nodes: [NODE_A, NODE_B] },
    ]);
    expect(coordinator.status().holding).toBe(true);
  });
});

describe("placements of applications that are gone", () => {
  it("removes the decision of an application that vanished without being deleted here", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await deleteKey(clock.ctx, applicationKey(APP));
    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment?.removed).toEqual([placementKey(APP)]);
    expect(await readPlacement(clock.ctx, APP)).toBeNull();
  });

  it("leaves the placements of applications that are still there alone", async () => {
    await deployed(APP);
    await deployed(OTHER);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await deleteKey(clock.ctx, applicationKey(OTHER));
    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment?.removed).toEqual([placementKey(OTHER)]);
    expect(await readPlacement(clock.ctx, APP)).not.toBeNull();
  });
});

describe("placements of applications that are retired", () => {
  it("gives a retired application no nodes, and takes its placement away", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, APP)).not.toBeNull();

    await retireApplication(clock.ctx, APP);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, APP)).toBeNull();
    expect(coordinator.status().lastAssignment?.removed).toEqual([placementKey(APP)]);
    expect(coordinator.status().lastAssignment?.changed).toEqual([]);
  });

  it("writes no placement for one that was retired before it was ever placed", async () => {
    await deployed(APP);
    await retireApplication(clock.ctx, APP);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, APP)).toBeNull();
    expect(placementWrites()).toEqual([]);
  });

  it("places it again on the next tick after it is taken back", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await retireApplication(clock.ctx, APP);
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, APP)).toBeNull();

    await unretireApplication(clock.ctx, APP);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A, NODE_B]);
  });

  it("leaves the applications beside it entirely alone", async () => {
    await deployed(APP);
    await deployed(OTHER);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    await retireApplication(clock.ctx, OTHER);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(await readPlacement(clock.ctx, OTHER)).toBeNull();
    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A, NODE_B]);
  });
});

describe("placements of applications that are blocked", () => {
  it("KEEPS the decision of a blocked application, so unblocking takes it straight back", async () => {
    await deployed(APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    const before = await readPlacement(clock.ctx, APP);

    await blockApplication(clock.ctx, APP);
    clock.tick(TTL_MS / 3);
    written = [];
    const deletesBefore = store.dels;
    await coordinator.runOnce();

    /* Blocking is reversible, so its placement is neither rewritten nor removed:
       the nodes stop serving it, and the decision waits for the block to lift. */
    expect(await readPlacement(clock.ctx, APP)).toEqual(before);
    expect(placementWrites()).toEqual([]);
    expect(store.dels).toBe(deletesBefore);
    expect(coordinator.status().lastAssignment?.removed).toEqual([]);
    expect(coordinator.status().lastAssignment?.changed).toEqual([]);
  });

  it("decides for it again the moment the block is lifted", async () => {
    await deployed(APP);
    await blockApplication(clock.ctx, APP);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();
    expect(await readPlacement(clock.ctx, APP)).toBeNull();

    await unblockApplication(clock.ctx, APP);
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect((await readPlacement(clock.ctx, APP))?.nodes).toEqual([NODE_A, NODE_B]);
  });

  it("leaves the applications beside it decided as usual", async () => {
    await deployed(APP);
    await deployed(OTHER);
    await blockApplication(clock.ctx, APP);
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment?.changed).toEqual([
      { target: OTHER, nodes: [NODE_A, NODE_B] },
    ]);
    expect(await readPlacement(clock.ctx, APP)).toBeNull();
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
    versions: { scafo: "0.0.0-test", celld: "0.5.0" },
    ...(observability === undefined ? {} : { observability }),
  };
}

/** An application with a deployment to serve, so it is a real placement target. */
async function deployed(name: string, opts?: { nodeSelector?: NodeSelector }): Promise<void> {
  await createApplication(clock.ctx, {
    name,
    ...(opts?.nodeSelector === undefined ? {} : { nodeSelector: opts.nodeSelector }),
  });
  await createDeployment(clock.ctx, name, { version: VERSION });
  await recordRevision(clock.ctx, name, VERSION);
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
    forget: () => {},
    onExit: () => {},
  };
}
