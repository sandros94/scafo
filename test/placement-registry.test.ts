/*
 * Placement as the registry holds it: the heartbeat a node keeps, the window
 * that reads it as alive, the conditional write the coordinator records a
 * decision with, and what an environment's deletion takes with it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  deleteEnvironment,
  deletePlacement,
  flipAlias,
  getEnvironment,
  heartbeatNode,
  isNodeLive,
  type LeaseHandle,
  listNodeRecords,
  listPlacements,
  NODE_HEARTBEAT_INTERVAL_MS,
  NODE_LIVENESS_WINDOW_MS,
  readPlacement,
  registerNode,
  setNodeSelector,
  setReplicas,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { environmentKey, placementKey } from "../src/core/registry/paths.ts";
import type { NodeRecord, PlacementRecord } from "../src/core/types/registry.ts";
import { DEFAULT_CONCURRENCY } from "../src/core/utils/concurrency.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  CLOCK_START_MS,
  ctxWith,
  FaultStore,
  type ManualClock,
  ObservingStore,
  rejectsWith,
} from "./_helpers.ts";

const PROJECT = "app";
const ENV = "prod";
const BUILD = "b1b1b1b1";
const NODE_A = "node-a";
const NODE_B = "node-b";

let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: ENV });
  await createBuild(clock.ctx, PROJECT, { id: BUILD, runtimeConfigurable: true });
  await flipAlias(clock.ctx, PROJECT, ENV, BUILD);

  const acquired = await acquireLease(clock.ctx, NODE_A);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("isNodeLive", () => {
  it("counts a node that beat within the window", () => {
    const record = node(NODE_A, { heartbeatAt: iso(0) });

    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS - 1))).toBe(true);
  });

  it("counts one out at the window, not a millisecond earlier", () => {
    const record = node(NODE_A, { heartbeatAt: iso(0) });

    /* Three intervals: two beats may be lost to a slow bucket before a healthy
       node has its environments taken away from it. */
    expect(NODE_LIVENESS_WINDOW_MS).toBe(3 * NODE_HEARTBEAT_INTERVAL_MS);
    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS - 1))).toBe(true);
    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS))).toBe(false);
  });

  it("takes the window a caller states over the default", () => {
    const record = node(NODE_A, { heartbeatAt: iso(0) });

    expect(isNodeLive(record, at(5000), { windowMs: 1000 })).toBe(false);
    expect(isNodeLive(record, at(5000), { windowMs: 10_000 })).toBe(true);
  });

  it("falls back to the capacity probe on a record from a node that beats none", () => {
    /* A rolling upgrade: the node is running an older build that never wrote a
       heartbeat, and reading the fleet as empty would be the worse answer. */
    const record = node(NODE_A, { probedAt: iso(0) });

    expect(isNodeLive(record, at(1000))).toBe(true);
    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS))).toBe(false);
  });

  it("prefers the heartbeat over the probe when the record carries both", () => {
    const record = node(NODE_A, { heartbeatAt: iso(NODE_LIVENESS_WINDOW_MS), probedAt: iso(0) });

    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS + 1000))).toBe(true);
  });

  it("refuses a record that says nothing about when the node was last seen", () => {
    /* Guessing "recently" would hand environments to a node that may be years
       gone; the record carries no evidence either way. */
    expect(isNodeLive(node(NODE_A, {}), at(0))).toBe(false);
    expect(isNodeLive(node(NODE_A, { heartbeatAt: "not a date" }), at(0))).toBe(false);
  });
});

describe("heartbeatNode", () => {
  it("touches the heartbeat and nothing else in the record", async () => {
    const registered = await registerNode(clock.ctx, node(NODE_A, { probedAt: iso(0) }));
    clock.tick(NODE_HEARTBEAT_INTERVAL_MS);

    const at = await heartbeatNode(clock.ctx, NODE_A);

    const [record] = await listNodeRecords(clock.ctx);
    expect(at).toBe(iso(NODE_HEARTBEAT_INTERVAL_MS));
    expect(record).toEqual({ ...registered, heartbeatAt: at });
  });

  it("keeps a node live across a window it would otherwise have fallen out of", async () => {
    await registerNode(clock.ctx, node(NODE_A, { heartbeatAt: iso(0) }));

    for (let beat = 1; beat <= 4; beat++) {
      clock.tick(NODE_HEARTBEAT_INTERVAL_MS);
      await heartbeatNode(clock.ctx, NODE_A);
    }

    const [record] = await listNodeRecords(clock.ctx);
    expect(isNodeLive(record, new Date(clock.nowMs()))).toBe(true);
  });

  it("refuses to beat for a node that has never registered", async () => {
    /* A heartbeat cannot bring a record into being: the record says what the
       node IS, and only registration knows that. */
    const error = await rejectsWith(() => heartbeatNode(clock.ctx, "ghost"), "not-found");

    expect(error.detail).toContain("ghost");
  });
});

describe("writePlacement", () => {
  it("records a decision that was never made before", async () => {
    const write = await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);

    expect(write.outcome).toBe("written");
    expect(write.record).toEqual({
      v: 1,
      nodes: [NODE_A],
      decidedAt: iso(0),
      fence: lease.lease.fence,
    });
    expect(await readPlacement(clock.ctx, PROJECT, ENV)).toEqual(write.record);
  });

  it("writes NOTHING when the decision is the one already recorded", async () => {
    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A, NODE_B], lease);
    const putsBefore = store.puts;
    clock.tick(60_000);

    const write = await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A, NODE_B], lease);

    /* Every tick would otherwise rewrite every placement in the installation,
       churning objects and ETags for a decision that has not moved. */
    expect(write.outcome).toBe("unchanged");
    expect(store.puts).toBe(putsBefore);
    expect((await readPlacement(clock.ctx, PROJECT, ENV))?.decidedAt).toBe(iso(0));
  });

  it("rewrites the decision when it changes, at the writer's own fence", async () => {
    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);
    clock.tick(30_000);
    const second = await acquireLease(clock.ctx, NODE_B);
    if (second === null) throw new Error("the second lease was refused");

    const write = await writePlacement(clock.ctx, PROJECT, ENV, [NODE_B], second);

    expect(write.outcome).toBe("written");
    expect(write.record).toMatchObject({ nodes: [NODE_B], fence: second.lease.fence });
    expect(second.lease.fence).toBeGreaterThan(lease.lease.fence);
  });

  it("refuses to undo a decision made at a higher fence than its own", async () => {
    /* The node that superseded this one has already decided. A stale coordinator
       that overwrote it would move environments back to a fleet it last saw. */
    clock.tick(30_000);
    const newer = await acquireLease(clock.ctx, NODE_B);
    if (newer === null) throw new Error("the second lease was refused");
    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_B], newer);
    const putsBefore = store.puts;

    const write = await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);

    expect(write.outcome).toBe("stale");
    expect(store.puts).toBe(putsBefore);
    expect(await readPlacement(clock.ctx, PROJECT, ENV)).toMatchObject({ nodes: [NODE_B] });
  });

  it("skips a decision another writer landed first, leaving theirs standing", async () => {
    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);

    /* The competing write lands between this one's read and its own put, so the
       If-Match fails. The loser does not retry: the winner is another
       coordinator, and the next tick re-reads rather than arguing. */
    store.onBeforePut = async (key: string): Promise<void> => {
      if (key !== placementKey(PROJECT, ENV)) return;
      store.onBeforePut = undefined;
      await store.put(key, JSON.stringify(placement([NODE_A, NODE_B], lease.lease.fence)));
    };

    const write = await writePlacement(clock.ctx, PROJECT, ENV, [NODE_B], lease);

    expect(write.outcome).toBe("cas-conflict");
    expect(await readPlacement(clock.ctx, PROJECT, ENV)).toMatchObject({
      nodes: [NODE_A, NODE_B],
    });
  });
});

describe("listPlacements", () => {
  it("answers one map for the whole project, and an empty one before anything is decided", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "staging" });

    expect(await listPlacements(clock.ctx, PROJECT)).toEqual(new Map());

    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);
    const placements = await listPlacements(clock.ctx, PROJECT);

    /* One listing, and a read only for the environments that HAVE a decision. */
    expect([...placements.keys()]).toEqual([ENV]);
    expect(placements.get(ENV)).toMatchObject({ nodes: [NODE_A] });
  });

  it("reads the decisions it found at once, and keys them in listing order all the same", async () => {
    const { ctx, observing, names } = await decidedProject();
    /* The first one answers LAST, so a map assembled as the reads came back
       would not be in the order below. */
    observing.delays.set(placementKey(PROJECT, names[0]), 20);
    observing.reset();

    const placements = await listPlacements(ctx, PROJECT);

    expect([...placements.keys()]).toEqual(names);
    expect(observing.peakReads).toBeGreaterThan(1);
    expect(observing.peakReads).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("reads them one at a time when the caller bounds it to one", async () => {
    const { ctx, observing, names } = await decidedProject();
    observing.reset();

    const placements = await listPlacements(ctx, PROJECT, { concurrency: 1 });

    expect([...placements.keys()]).toEqual(names);
    expect(observing.peakReads).toBe(1);
  });

  it("surfaces the failure of the FIRST decision that could not be read", async () => {
    const { ctx, observing, names } = await decidedProject();
    /* The later one fails at once and the earlier one takes its time, so the
       failure that settles first is not the one a sequential read would hit. */
    observing.delays.set(placementKey(PROJECT, names[1]), 20);
    observing.faults.set(placementKey(PROJECT, names[1]), new Error("second"));
    observing.faults.set(placementKey(PROJECT, names[3]), new Error("fourth"));

    await expect(listPlacements(ctx, PROJECT)).rejects.toThrow("second");
  });
});

describe("deletePlacement", () => {
  it("removes the decision, and says so once there is nothing left to remove", async () => {
    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);

    expect(await deletePlacement(clock.ctx, PROJECT, ENV, lease)).toBe(placementKey(PROJECT, ENV));
    expect(await readPlacement(clock.ctx, PROJECT, ENV)).toBeNull();
    expect(await deletePlacement(clock.ctx, PROJECT, ENV, lease)).toBeNull();
  });

  it("deletes nothing once the lease has been taken away", async () => {
    await writePlacement(clock.ctx, PROJECT, ENV, [NODE_A], lease);
    clock.tick(3_600_000);
    expect(await acquireLease(clock.ctx, NODE_B)).not.toBeNull();
    const deletesBefore = store.dels;

    await rejectsWith(() => deletePlacement(clock.ctx, PROJECT, ENV, lease), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    expect(await readPlacement(clock.ctx, PROJECT, ENV)).not.toBeNull();
  });
});

describe("an environment that is deleted", () => {
  it("takes its placement with it, before the record that named it", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "preview", ephemeral: true });
    await writePlacement(clock.ctx, PROJECT, "preview", [NODE_A], lease);

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    /* Before the record: a placement left behind names an environment that is
       gone, and nothing iterates an environment that no longer exists. */
    expect(deleted).toEqual([placementKey(PROJECT, "preview"), environmentKey(PROJECT, "preview")]);
    expect(await readPlacement(clock.ctx, PROJECT, "preview")).toBeNull();
  });

  it("deletes nothing extra for an environment that was never placed", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "preview", ephemeral: true });

    const { deleted } = await deleteEnvironment(clock.ctx, PROJECT, "preview", lease);

    expect(deleted).toEqual([environmentKey(PROJECT, "preview")]);
  });
});

describe("setReplicas", () => {
  it("states how many nodes serve an environment, leaving everything else alone", async () => {
    const before = await getEnvironment(clock.ctx, PROJECT, ENV);

    const updated = await setReplicas(clock.ctx, PROJECT, ENV, 2);

    expect(updated).toEqual({ ...before, replicas: 2 });
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).replicas).toBe(2);
  });

  it('takes "all" back off a count', async () => {
    await setReplicas(clock.ctx, PROJECT, ENV, 1);

    expect((await setReplicas(clock.ctx, PROJECT, ENV, "all")).replicas).toBe("all");
  });

  it.each([0, -2, 2.5, "1", "every"])("refuses %p and writes nothing", async (value) => {
    const putsBefore = store.puts;

    await rejectsWith(() => setReplicas(clock.ctx, PROJECT, ENV, value as never), "invalid-input");

    expect(store.puts).toBe(putsBefore);
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).replicas).toBeUndefined();
  });

  it("refuses an environment that is not there", async () => {
    const error = await rejectsWith(() => setReplicas(clock.ctx, PROJECT, "ghost", 1), "not-found");

    expect(error.detail).toContain(environmentKey(PROJECT, "ghost"));
  });
});

describe("setNodeSelector", () => {
  it("states which nodes may serve an environment, leaving everything else alone", async () => {
    const before = await getEnvironment(clock.ctx, PROJECT, ENV);

    const updated = await setNodeSelector(clock.ctx, PROJECT, ENV, { tier: "fast" });

    expect(updated).toEqual({ ...before, nodeSelector: { tier: "fast" } });
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).nodeSelector).toEqual({ tier: "fast" });
  });

  it("replaces the whole selector rather than merging into it", async () => {
    await setNodeSelector(clock.ctx, PROJECT, ENV, { tier: "fast", region: "eu-west-1" });

    const updated = await setNodeSelector(clock.ctx, PROJECT, ENV, { region: "us-east-1" });

    /* A selector is one statement about where an environment runs; merging would
       leave an operator unable to take a requirement back off. */
    expect(updated.nodeSelector).toEqual({ region: "us-east-1" });
  });

  it("clears it by REMOVING the field, not by storing an empty one", async () => {
    await setNodeSelector(clock.ctx, PROJECT, ENV, { tier: "fast" });

    const cleared = await setNodeSelector(clock.ctx, PROJECT, ENV, null);

    /* The selector's presence is semantic. In particular, the explicit legacy
       fallback never runs selector-bearing work without a coordinator decision,
       so an empty object left behind would still constrain that read. */
    expect("nodeSelector" in cleared).toBe(false);
    expect(await getEnvironment(clock.ctx, PROJECT, ENV)).toEqual(cleared);
  });

  it("clears one that was never set, without complaint", async () => {
    const cleared = await setNodeSelector(clock.ctx, PROJECT, ENV, null);

    expect("nodeSelector" in cleared).toBe(false);
  });

  it.each([{}, { Tier: "fast" }, { tier: "very fast" }, { tier: 1 }, [], "tier=fast"])(
    "refuses %p and writes nothing",
    async (value) => {
      const putsBefore = store.puts;

      await rejectsWith(
        () => setNodeSelector(clock.ctx, PROJECT, ENV, value as never),
        "invalid-input",
      );

      expect(store.puts).toBe(putsBefore);
      expect((await getEnvironment(clock.ctx, PROJECT, ENV)).nodeSelector).toBeUndefined();
    },
  );

  it("refuses an environment that is not there", async () => {
    const error = await rejectsWith(
      () => setNodeSelector(clock.ctx, PROJECT, "ghost", { tier: "fast" }),
      "not-found",
    );

    expect(error.detail).toContain(environmentKey(PROJECT, "ghost"));
  });

  it("leaves the replica count it sits beside untouched", async () => {
    await setReplicas(clock.ctx, PROJECT, ENV, 2);

    const updated = await setNodeSelector(clock.ctx, PROJECT, ENV, { tier: "fast" });

    /* The two compose: how many nodes, and which nodes they may be. */
    expect(updated.replicas).toBe(2);
    expect(updated.nodeSelector).toEqual({ tier: "fast" });
  });
});

describe("createEnvironment", () => {
  it("carries a node selector into the record, and leaves it off when none was given", async () => {
    const stated = await createEnvironment(clock.ctx, PROJECT, {
      name: "targeted",
      nodeSelector: { tier: "fast" },
    });
    const silent = await createEnvironment(clock.ctx, PROJECT, { name: "anywhere" });

    expect(stated.nodeSelector).toEqual({ tier: "fast" });
    expect("nodeSelector" in silent).toBe(false);
  });

  it("refuses a selector that is not one, creating nothing", async () => {
    const error = await rejectsWith(
      () => createEnvironment(clock.ctx, PROJECT, { name: "bad", nodeSelector: {} }),
      "invalid-input",
    );

    expect(error.detail).toContain("clear the selector");
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "bad"), "not-found");
  });

  it("carries a replica count into the record, and leaves it off when none was given", async () => {
    const stated = await createEnvironment(clock.ctx, PROJECT, { name: "one", replicas: 1 });
    const silent = await createEnvironment(clock.ctx, PROJECT, { name: "two" });

    expect(stated.replicas).toBe(1);
    /* Additive: a record that never mentions replicas resolves to the default
       its kind implies, exactly as every environment written before this. */
    expect("replicas" in silent).toBe(false);
  });

  it("refuses a replica count that is not one, creating nothing", async () => {
    const error = await rejectsWith(
      () => createEnvironment(clock.ctx, PROJECT, { name: "bad", replicas: 0 }),
      "invalid-input",
    );

    expect(error.detail).toContain("at least 1");
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "bad"), "not-found");
  });
});

/** A node record with whatever evidence of life the case is about. */
function node(id: string, opts: { heartbeatAt?: string; probedAt?: string }): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "key" },
    addresses: { internal: "10.0.0.1", apiPort: 7400 },
    ...(opts.probedAt === undefined
      ? {}
      : { capacity: { cores: 4, memMb: 8192, cgroup: false, probedAt: opts.probedAt } }),
    ...(opts.heartbeatAt === undefined ? {} : { heartbeatAt: opts.heartbeatAt }),
  };
}

function placement(nodes: string[], fence: number): PlacementRecord {
  return { v: 1, nodes, decidedAt: iso(0), fence };
}

/** A project of five decided environments, over a store that watches its reads. */
async function decidedProject(): Promise<{
  ctx: RegistryContext;
  observing: ObservingStore;
  names: string[];
}> {
  const observing = new ObservingStore(new MemoryCasStore());
  const { ctx } = ctxWith(observing);
  await createProject(ctx, { slug: PROJECT });

  const taken = await acquireLease(ctx, NODE_A);
  if (taken === null) throw new Error("the fixture could not take the lease");

  const names = ["alpha", "bravo", "charlie", "delta", "echo"];
  for (const name of names) {
    await createEnvironment(ctx, PROJECT, { name });
    await writePlacement(ctx, PROJECT, name, [NODE_A], taken);
  }
  return { ctx, observing, names };
}

/** An ISO stamp `offsetMs` after the shared clock's start. */
function iso(offsetMs: number): string {
  return new Date(CLOCK_START_MS + offsetMs).toISOString();
}

function at(offsetMs: number): Date {
  return new Date(CLOCK_START_MS + offsetMs);
}
