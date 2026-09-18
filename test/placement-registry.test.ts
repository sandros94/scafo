/*
 * Placement as the registry holds it: the heartbeat a node keeps, the window that reads it as
 * alive, the conditional write the coordinator records a decision with, and what an application's
 * deletion takes with it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  blockApplication,
  createApplication,
  createDeployment,
  deleteApplication,
  deletePlacement,
  getApplication,
  heartbeatNode,
  isNodeLive,
  type LeaseHandle,
  listNodeRecords,
  listPlacements,
  NODE_HEARTBEAT_INTERVAL_MS,
  NODE_LIVENESS_WINDOW_MS,
  readPlacement,
  registerNode,
  setApplicationLabels,
  setNodeSelector,
  setReplicas,
  unblockApplication,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { applicationKey, placementKey } from "../src/core/registry/paths.ts";
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

const APPLICATION = "app";
const VERSION = "b1b1b1b1";
const NODE_A = "node-a";
const NODE_B = "node-b";

let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);

  await createApplication(clock.ctx, { name: APPLICATION });
  await createDeployment(clock.ctx, APPLICATION, { version: VERSION });
  await recordRevision(clock.ctx, APPLICATION, VERSION);

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
       node has its applications taken away from it. */
    expect(NODE_LIVENESS_WINDOW_MS).toBe(3 * NODE_HEARTBEAT_INTERVAL_MS);
    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS - 1))).toBe(true);
    expect(isNodeLive(record, at(NODE_LIVENESS_WINDOW_MS))).toBe(false);
  });

  it("takes the window a caller states over the default", () => {
    const record = node(NODE_A, { heartbeatAt: iso(0) });

    expect(isNodeLive(record, at(5000), { windowMs: 1000 })).toBe(false);
    expect(isNodeLive(record, at(5000), { windowMs: 10_000 })).toBe(true);
  });

  it("refuses a record that says nothing about when the node was last seen", () => {
    /* Guessing "recently" would hand applications to a node that may be years
       gone; the record carries no evidence either way. */
    expect(isNodeLive(node(NODE_A, {}), at(0))).toBe(false);
    expect(isNodeLive(node(NODE_A, { heartbeatAt: "not a date" }), at(0))).toBe(false);
  });
});

describe("heartbeatNode", () => {
  it("touches the heartbeat and nothing else in the record", async () => {
    const registered = await registerNode(clock.ctx, node(NODE_A, {}));
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
    const write = await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);

    expect(write.outcome).toBe("written");
    expect(write.record).toEqual({
      v: 1,
      nodes: [NODE_A],
      decidedAt: iso(0),
      fence: lease.lease.fence,
    });
    expect(await readPlacement(clock.ctx, APPLICATION)).toEqual(write.record);
  });

  it("writes NOTHING when the decision is the one already recorded", async () => {
    await writePlacement(clock.ctx, APPLICATION, [NODE_A, NODE_B], lease);
    const putsBefore = store.puts;
    clock.tick(60_000);

    const write = await writePlacement(clock.ctx, APPLICATION, [NODE_A, NODE_B], lease);

    /* Every tick would otherwise rewrite every placement in the installation,
       churning objects and ETags for a decision that has not moved. */
    expect(write.outcome).toBe("unchanged");
    expect(store.puts).toBe(putsBefore);
    expect((await readPlacement(clock.ctx, APPLICATION))?.decidedAt).toBe(iso(0));
  });

  it("rewrites the decision when it changes, at the writer's own fence", async () => {
    await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);
    clock.tick(30_000);
    const second = await acquireLease(clock.ctx, NODE_B);
    if (second === null) throw new Error("the second lease was refused");

    const write = await writePlacement(clock.ctx, APPLICATION, [NODE_B], second);

    expect(write.outcome).toBe("written");
    expect(write.record).toMatchObject({ nodes: [NODE_B], fence: second.lease.fence });
    expect(second.lease.fence).toBeGreaterThan(lease.lease.fence);
  });

  it("refuses to undo a decision made at a higher fence than its own", async () => {
    /* The node that superseded this one has already decided. A stale coordinator
       that overwrote it would move applications back to a fleet it last saw. */
    clock.tick(30_000);
    const newer = await acquireLease(clock.ctx, NODE_B);
    if (newer === null) throw new Error("the second lease was refused");
    await writePlacement(clock.ctx, APPLICATION, [NODE_B], newer);
    const putsBefore = store.puts;

    const write = await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);

    expect(write.outcome).toBe("stale");
    expect(store.puts).toBe(putsBefore);
    expect(await readPlacement(clock.ctx, APPLICATION)).toMatchObject({ nodes: [NODE_B] });
  });

  it("skips a decision another writer landed first, leaving theirs standing", async () => {
    await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);

    /* The competing write lands between this one's read and its own put, so the
       If-Match fails. The loser does not retry: the winner is another
       coordinator, and the next tick re-reads rather than arguing. */
    store.onBeforePut = async (key: string): Promise<void> => {
      if (key !== placementKey(APPLICATION)) return;
      store.onBeforePut = undefined;
      await store.put(key, JSON.stringify(placement([NODE_A, NODE_B], lease.lease.fence)));
    };

    const write = await writePlacement(clock.ctx, APPLICATION, [NODE_B], lease);

    expect(write.outcome).toBe("cas-conflict");
    expect(await readPlacement(clock.ctx, APPLICATION)).toMatchObject({
      nodes: [NODE_A, NODE_B],
    });
  });
});

describe("listPlacements", () => {
  it("answers one map for the whole installation, and an empty one before anything is decided", async () => {
    await createApplication(clock.ctx, { name: "staging" });

    expect(await listPlacements(clock.ctx)).toEqual(new Map());

    await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);
    const placements = await listPlacements(clock.ctx);

    /* One listing, and a read only for the applications that have a decision. */
    expect([...placements.keys()]).toEqual([APPLICATION]);
    expect(placements.get(APPLICATION)).toMatchObject({ nodes: [NODE_A] });
  });

  it("reads the decisions it found at once, and keys them in listing order all the same", async () => {
    const { ctx, observing, names } = await decidedFleet();
    /* The first one answers last, so a map assembled as the reads came back
       would not be in the order below. */
    observing.delays.set(placementKey(names[0]), 20);
    observing.reset();

    const placements = await listPlacements(ctx);

    expect([...placements.keys()]).toEqual(names);
    expect(observing.peakReads).toBeGreaterThan(1);
    expect(observing.peakReads).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("reads them one at a time when the caller bounds it to one", async () => {
    const { ctx, observing, names } = await decidedFleet();
    observing.reset();

    const placements = await listPlacements(ctx, { concurrency: 1 });

    expect([...placements.keys()]).toEqual(names);
    expect(observing.peakReads).toBe(1);
  });

  it("surfaces the failure of the FIRST decision that could not be read", async () => {
    const { ctx, observing, names } = await decidedFleet();
    /* The later one fails at once and the earlier one takes its time, so the
       failure that settles first is not the one a sequential read would hit. */
    observing.delays.set(placementKey(names[1]), 20);
    observing.faults.set(placementKey(names[1]), new Error("second"));
    observing.faults.set(placementKey(names[3]), new Error("fourth"));

    await expect(listPlacements(ctx)).rejects.toThrow("second");
  });
});

describe("deletePlacement", () => {
  it("removes the decision, and says so once there is nothing left to remove", async () => {
    await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);

    expect(await deletePlacement(clock.ctx, APPLICATION, lease)).toBe(placementKey(APPLICATION));
    expect(await readPlacement(clock.ctx, APPLICATION)).toBeNull();
    expect(await deletePlacement(clock.ctx, APPLICATION, lease)).toBeNull();
  });

  it("deletes nothing once the lease has been taken away", async () => {
    await writePlacement(clock.ctx, APPLICATION, [NODE_A], lease);
    clock.tick(3_600_000);
    expect(await acquireLease(clock.ctx, NODE_B)).not.toBeNull();
    const deletesBefore = store.dels;

    await rejectsWith(() => deletePlacement(clock.ctx, APPLICATION, lease), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    expect(await readPlacement(clock.ctx, APPLICATION)).not.toBeNull();
  });
});

describe("an application that is deleted", () => {
  it("takes its placement with it, before the record that named it", async () => {
    await createApplication(clock.ctx, { name: "preview" });
    await writePlacement(clock.ctx, "preview", [NODE_A], lease);

    const { deleted } = await deleteApplication(clock.ctx, "preview", lease, { force: true });

    /* Before the record: a placement left behind names an application that is
       gone, and nothing iterates an application that no longer exists. */
    expect(deleted).toEqual([placementKey("preview"), applicationKey("preview")]);
    expect(await readPlacement(clock.ctx, "preview")).toBeNull();
  });

  it("deletes nothing extra for an application that was never placed", async () => {
    await createApplication(clock.ctx, { name: "preview" });

    const { deleted } = await deleteApplication(clock.ctx, "preview", lease, { force: true });

    expect(deleted).toEqual([applicationKey("preview")]);
  });
});

describe("setReplicas", () => {
  it("states how many nodes serve an application, leaving everything else alone", async () => {
    const before = await getApplication(clock.ctx, APPLICATION);

    const updated = await setReplicas(clock.ctx, APPLICATION, 2);

    expect(updated).toEqual({ ...before, replicas: 2 });
    expect((await getApplication(clock.ctx, APPLICATION)).replicas).toBe(2);
  });

  it('takes "all" back off a count', async () => {
    await setReplicas(clock.ctx, APPLICATION, 1);

    expect((await setReplicas(clock.ctx, APPLICATION, "all")).replicas).toBe("all");
  });

  it.each([0, -2, 2.5, "1", "every"])("refuses %p and writes nothing", async (value) => {
    const putsBefore = store.puts;

    await rejectsWith(() => setReplicas(clock.ctx, APPLICATION, value as never), "invalid-input");

    expect(store.puts).toBe(putsBefore);
    expect((await getApplication(clock.ctx, APPLICATION)).replicas).toBeUndefined();
  });

  it("refuses an application that is not there", async () => {
    const error = await rejectsWith(() => setReplicas(clock.ctx, "ghost", 1), "not-found");

    expect(error.detail).toContain(applicationKey("ghost"));
  });

  it("leaves a block and the fleet's labels standing", async () => {
    /* A deploy-side setter owns the replica count and nothing else: dropping an
       admin's block or labels here would undo an admin decision. */
    const blocked = await blockedAndLabelled();

    const updated = await setReplicas(blocked.ctx, APPLICATION, 3);

    expect(updated).toMatchObject({
      replicas: 3,
      blocked: true,
      labels: { tier: "gold", owner: "platform" },
    });
  });
});

describe("setNodeSelector", () => {
  it("states which nodes may serve an application, leaving everything else alone", async () => {
    const before = await getApplication(clock.ctx, APPLICATION);

    const updated = await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast" });

    expect(updated).toEqual({ ...before, nodeSelector: { tier: "fast" } });
    expect((await getApplication(clock.ctx, APPLICATION)).nodeSelector).toEqual({ tier: "fast" });
  });

  it("replaces the whole selector rather than merging into it", async () => {
    await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast", region: "eu-west-1" });

    const updated = await setNodeSelector(clock.ctx, APPLICATION, { region: "us-east-1" });

    /* A selector is one statement about where an application runs; merging would
       leave an operator unable to take a requirement back off. */
    expect(updated.nodeSelector).toEqual({ region: "us-east-1" });
  });

  it("clears it by REMOVING the field, not by storing an empty one", async () => {
    await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast" });

    const cleared = await setNodeSelector(clock.ctx, APPLICATION, null);

    /* The selector's presence is semantic: an empty object left behind would
       read as a constraint that happens to match every node. */
    expect("nodeSelector" in cleared).toBe(false);
    expect(await getApplication(clock.ctx, APPLICATION)).toEqual(cleared);
  });

  it("clears one that was never set, without complaint", async () => {
    const cleared = await setNodeSelector(clock.ctx, APPLICATION, null);

    expect("nodeSelector" in cleared).toBe(false);
  });

  it.each([{}, { Tier: "fast" }, { tier: "very fast" }, { tier: 1 }, [], "tier=fast"])(
    "refuses %p and writes nothing",
    async (value) => {
      const putsBefore = store.puts;

      await rejectsWith(
        () => setNodeSelector(clock.ctx, APPLICATION, value as never),
        "invalid-input",
      );

      expect(store.puts).toBe(putsBefore);
      expect((await getApplication(clock.ctx, APPLICATION)).nodeSelector).toBeUndefined();
    },
  );

  it("refuses an application that is not there", async () => {
    const error = await rejectsWith(
      () => setNodeSelector(clock.ctx, "ghost", { tier: "fast" }),
      "not-found",
    );

    expect(error.detail).toContain(applicationKey("ghost"));
  });

  it("leaves the replica count it sits beside untouched", async () => {
    await setReplicas(clock.ctx, APPLICATION, 2);

    const updated = await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast" });

    /* The two compose: how many nodes, and which nodes they may be. */
    expect(updated.replicas).toBe(2);
    expect(updated.nodeSelector).toEqual({ tier: "fast" });
  });

  it("leaves a block and the fleet's labels standing", async () => {
    const blocked = await blockedAndLabelled();

    const updated = await setNodeSelector(blocked.ctx, APPLICATION, { tier: "fast" });

    expect(updated).toMatchObject({
      nodeSelector: { tier: "fast" },
      blocked: true,
      labels: { tier: "gold", owner: "platform" },
    });
  });
});

describe("recordRevision", () => {
  it("advances the deployment notice without dropping a block or the fleet's labels", async () => {
    const blocked = await blockedAndLabelled();
    await createDeployment(blocked.ctx, APPLICATION, { version: "c2c2c2c2" });

    const { application } = await recordRevision(blocked.ctx, APPLICATION, "c2c2c2c2");

    expect(application).toMatchObject({
      deployment: { revision: 2 },
      blocked: true,
      labels: { tier: "gold", owner: "platform" },
    });
  });
});

describe("blockApplication and setApplicationLabels", () => {
  it("leave the replicas, selector and deployment notice a deploy owns untouched", async () => {
    /* The admin half of the record and the deploy half compose in both
       directions: neither functional update may drop what it does not own. */
    await setReplicas(clock.ctx, APPLICATION, 4);
    await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast" });
    const deployed = await getApplication(clock.ctx, APPLICATION);

    await blockApplication(clock.ctx, APPLICATION);
    const labelled = await setApplicationLabels(clock.ctx, APPLICATION, { tier: "gold" });

    expect(labelled).toEqual({
      ...deployed,
      blocked: true,
      labels: { tier: "gold" },
    });
  });

  it("lift a block without touching anything the deploy side wrote", async () => {
    await setReplicas(clock.ctx, APPLICATION, 4);
    await blockApplication(clock.ctx, APPLICATION);
    await setApplicationLabels(clock.ctx, APPLICATION, { tier: "gold" });

    const unblocked = await unblockApplication(clock.ctx, APPLICATION);

    expect("blocked" in unblocked).toBe(false);
    expect(unblocked).toMatchObject({ replicas: 4, labels: { tier: "gold" } });
    expect(unblocked.deployment).toMatchObject({ revision: 1 });
  });
});

describe("createApplication", () => {
  it("carries a node selector into the record, and leaves it off when none was given", async () => {
    const stated = await createApplication(clock.ctx, {
      name: "targeted",
      nodeSelector: { tier: "fast" },
    });
    const silent = await createApplication(clock.ctx, { name: "anywhere" });

    expect(stated.nodeSelector).toEqual({ tier: "fast" });
    expect("nodeSelector" in silent).toBe(false);
  });

  it("carries a replica count into the record, and leaves it off when none was given", async () => {
    const stated = await createApplication(clock.ctx, { name: "one", replicas: 1 });
    const silent = await createApplication(clock.ctx, { name: "two" });

    expect(stated.replicas).toBe(1);
    /* A record that never mentions replicas resolves to every live node that may
       serve it, rather than to a count written at creation. */
    expect("replicas" in silent).toBe(false);
  });

  it("returns the existing application unchanged, settings and all", async () => {
    const first = await createApplication(clock.ctx, { name: "one", replicas: 1 });
    clock.tick(60_000);

    const again = await createApplication(clock.ctx, { name: "one", replicas: 3 });

    /* The first deploy creates it; a second one is not a chance to restate what
       the application is, or a retry would rewrite a count an operator has since
       changed. */
    expect(again).toEqual(first);
  });
});

/** A node record with whatever evidence of life the case is about. */
function node(id: string, opts: { heartbeatAt?: string }): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "key" },
    addresses: { internal: "10.0.0.1", apiPort: 7400 },
    ...(opts.heartbeatAt === undefined ? {} : { heartbeatAt: opts.heartbeatAt }),
  };
}

function placement(nodes: string[], fence: number): PlacementRecord {
  return { v: 1, nodes, decidedAt: iso(0), fence };
}

/** The shared fixture's application, blocked and labelled by an admin. */
async function blockedAndLabelled(): Promise<{ ctx: RegistryContext }> {
  await blockApplication(clock.ctx, APPLICATION);
  await setApplicationLabels(clock.ctx, APPLICATION, { tier: "gold", owner: "platform" });
  return { ctx: clock.ctx };
}

/** Five decided applications, over a store that watches its reads. */
async function decidedFleet(): Promise<{
  ctx: RegistryContext;
  observing: ObservingStore;
  names: string[];
}> {
  const observing = new ObservingStore(new MemoryCasStore());
  const { ctx } = ctxWith(observing);

  const taken = await acquireLease(ctx, NODE_A);
  if (taken === null) throw new Error("the fixture could not take the lease");

  const names = ["alpha", "bravo", "charlie", "delta", "echo"];
  for (const name of names) {
    await createApplication(ctx, { name });
    await writePlacement(ctx, name, [NODE_A], taken);
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
