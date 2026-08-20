/*
 * The coordinator's other duty: deciding which nodes serve which environment,
 * and writing that down only when it changed.
 *
 * The loop is driven a tick at a time and the clock is the injected one, so
 * every assertion is about what the coordinator decided rather than about how
 * long a test was willing to wait.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentContext } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { type Coordinator, createCoordinator } from "../src/agent/coordinator.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  flipAlias,
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
  await createBuild(clock.ctx, PROJECT, { id: BUILD, runtimeConfigurable: true });
  for (const id of [NODE_A, NODE_B]) await register(id);
});

describe("assigning environments to nodes", () => {
  it("places a long-lived environment on every live node, as it was served before", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    /* The default of a long-lived environment is "all", so placement changes
       nothing about which nodes run it — it only writes down what was already
       true, which is what makes the record safe to start filtering on. */
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

    /* The lease renewal is the only write a settled installation makes on a
       tick; rewriting every placement each time would churn the whole registry. */
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

    /* node-b goes quiet; node-a keeps beating right up to the moment it decides. */
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
    /* Re-registered with labels: registration replaces a node's record
       wholesale, which is exactly how an operator relabels a machine. */
    await register(NODE_A, { tier: "fast", region: "eu-west-1" });
    await register(NODE_B, { tier: "slow", region: "eu-west-1" });
  });

  it("places it only on the nodes whose labels the selector names", async () => {
    await environmentNamed("prod", { nodeSelector: FAST });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    /* A long-lived environment defaults to "all", and under a selector "all"
       means every MATCHING node — so the constraint is what narrows it here,
       not the replica count. */
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
    /* The selector narrowed the candidates and rendezvous chose among THOSE, so
       the one node it picked is necessarily a matching one. */
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

    /* Stating the intent is one act and placing it is another: the change lands
       on the coordinator's next pass, under the same fenced write as always. */
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

    /* The labels go away under it — a node not back from maintenance, a fleet
       mid-relabelling, a typo'd selector. */
    await setNodeSelector(clock.ctx, PROJECT, "prod", IMPOSSIBLE);
    clock.tick(TTL_MS / 3);
    written = [];
    const deletesBefore = store.dels;
    await coordinator.runOnce();

    /*
     * THE RULE THIS FEATURE HANGS FROM. An empty decision would stop the
     * environment on every node serving it, and removing the record would stop
     * it just as dead — a selector-bearing environment has no run-everywhere
     * fallback. A stale-but-serving placement beats an outage, so the last
     * decision stands untouched and the operator is told instead.
     */
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
    /* The detail has to carry what an operator acts on: which environment, and
       which labels nothing satisfied. */
    expect(unplaced[0].detail).toContain(`${PROJECT}/prod`);
    expect(unplaced[0].detail).toContain("gpu=a100");
  });

  it("writes no placement at all for one that was never placed", async () => {
    await environmentNamed("prod", { nodeSelector: IMPOSSIBLE });
    const coordinator = coordinatorFor(NODE_A);

    await coordinator.runOnce();

    /* Not an empty decision, and not a decision naming an arbitrary node: no
       record, which is the state the node-side reader refuses to serve on. */
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
    /* Retirement is a decision to stop; an unsatisfiable selector is a failure
       to decide. Only the second is a reason to leave a placement standing. */
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

    /* Nobody beats: a bucket that could not be reached, a fleet mid-restart, a
       clock that jumped. Every one of them reads as an empty node list. */
    clock.tick(NODE_LIVENESS_WINDOW_MS * 10);
    written = [];
    await coordinator.runOnce();

    /*
     * The refusal that keeps an installation up. Deciding from an empty fleet
     * would write "nobody serves this" against every environment, and every node
     * would then stop every process it runs — over what is far more likely a
     * registry hiccup than an actually empty fleet.
     */
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
    await environmentNamed("preview", { ephemeral: true, idleTtlS: 900 });
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    /* Long enough that the environment is reapable and both nodes are stale. */
    clock.tick(3_600_000);
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(true);
    expect(coordinator.status().lastAssignFailure).toContain("No node is live");
    /* The reap is a separate duty and is not held hostage by the other one. */
    expect(coordinator.status().lastReapFailure).toBeNull();
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    /* And the reap took the placement with it, so nothing is left naming it. */
    expect(await readPlacement(clock.ctx, PROJECT, "preview")).toBeNull();
  });
});

describe("a decision another coordinator got to first", () => {
  it("skips it, leaving the winner's decision standing", async () => {
    await environmentNamed("prod");
    await setReplicas(clock.ctx, PROJECT, "prod", 1);
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    /* A competing write lands between this coordinator's read and its own put. */
    const key = placementKey(PROJECT, "prod");
    await setReplicas(clock.ctx, PROJECT, "prod", 2);
    store.onBeforePut = async (touched: string): Promise<void> => {
      written.push(touched);
      if (touched !== key) return;
      store.onBeforePut = (again: string): void => {
        written.push(again);
      };
      await store.put(key, JSON.stringify(rival()));
    };

    await coordinator.runOnce();

    expect(coordinator.status().lastAssignment?.skipped).toEqual([
      { target: `${PROJECT}/prod`, reason: "cas-conflict" },
    ]);
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toMatchObject({ nodes: [NODE_B] });
    /* And it is not an error: the next tick simply re-reads and decides again. */
    expect(coordinator.status().lastAssignFailure).toBeNull();
    expect(coordinator.status().holding).toBe(true);
  });
});

describe("placements of environments that are gone", () => {
  it("removes the decision of an environment that vanished without being deleted here", async () => {
    await environmentNamed("prod");
    const coordinator = coordinatorFor(NODE_A);
    await coordinator.runOnce();

    /* Taken out from under the coordinator — another node's operator-ordered
       delete, a reap it did not run. Its placement is left pointing at nothing. */
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

    /*
     * An environment on its way out is served by no node, so it is given none.
     * The record goes with it: a decision naming nodes that have all stopped
     * running it is one nothing acts on, and every node would re-read it on
     * every pass until the reap finally arrived.
     */
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

    /* Decided from the same inputs as before, by a pure function of the
       environments and the live nodes — so unretiring restores exactly what
       retiring took away. */
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
  return createCoordinator(agentFor(nodeId), { ttlMs: TTL_MS, reapIntervalMs: 0 });
}

function agentFor(nodeId: string): AgentContext {
  return {
    config: agentConfig(nodeId),
    nodeId,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: "0.0.0-test",
  };
}

/** An environment with a build to serve, so it is a real placement target. */
async function environmentNamed(
  name: string,
  opts?: { ephemeral?: boolean; idleTtlS?: number; nodeSelector?: NodeSelector },
): Promise<void> {
  await createEnvironment(clock.ctx, PROJECT, {
    name,
    ...(opts?.ephemeral === undefined ? {} : { ephemeral: opts.ephemeral }),
    ...(opts?.idleTtlS === undefined ? {} : { idleTtlS: opts.idleTtlS }),
    ...(opts?.nodeSelector === undefined ? {} : { nodeSelector: opts.nodeSelector }),
  });
  await flipAlias(clock.ctx, PROJECT, name, BUILD);
}

/** Registers `id` as a node that has just beaten, carrying `labels` if any. */
async function register(id: string, labels?: Record<string, string>): Promise<NodeRecord> {
  return registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `key-${id}` },
    addresses: { internal: `10.0.0.${id === NODE_A ? "1" : "2"}`, agentPort: 7400 },
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

function agentConfig(nodeId: string): AgentConfig {
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
    runtime: { binPath: "celld", portRangeStart: 42_000, probePath: "/", bindHost: "127.0.0.1" },
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
