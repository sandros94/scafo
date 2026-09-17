/* A node that is stopping on purpose, and the difference it makes. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { runAssignment } from "../src/daemon/_assign.ts";
import { drainThisNode } from "../src/cli/_bootstrap.ts";
import {
  acquireLease,
  createDeployment,
  createEnvironment,
  createProject,
  drainNode,
  getNode,
  heartbeatNode,
  isNodeLive,
  type LeaseHandle,
  NODE_LIVENESS_WINDOW_MS,
  readPlacement,
  registerNode,
} from "../src/core/registry/index.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectionOf, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const VERSION = "b1b1b1b1";
const NODE_A = "node-a";
const NODE_B = "node-b";

let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;
/** Drain results distinguish a silent shutdown from an announced one. */
let logged: string[];

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);
  logged = [];

  await createProject(clock.ctx, { slug: PROJECT });
  await createDeployment(clock.ctx, PROJECT, { version: VERSION });
  for (const id of [NODE_A, NODE_B]) await register(id);

  const acquired = await acquireLease(clock.ctx, NODE_A);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("isNodeLive", () => {
  it("counts a draining node out however fresh its heartbeat is", async () => {
    await heartbeatNode(clock.ctx, NODE_B);
    await drainNode(clock.ctx, NODE_B);
    const record = await getNode(clock.ctx, NODE_B);

    /*
     * The heartbeat is from this instant, so every other rule in `isNodeLive`
     * says live. A node's own word about where it is going outranks the
     * timestamp of the last thing it did.
     */
    expect(record.heartbeatAt).toBe(new Date(clock.nowMs()).toISOString());
    expect(isNodeLive(record, new Date(clock.nowMs()))).toBe(false);
  });

  it("keeps counting it out however wide the window is opened", async () => {
    await drainNode(clock.ctx, NODE_B);
    const record = await getNode(clock.ctx, NODE_B);

    /* Draining is not a slow heartbeat, so no window makes it live again. */
    expect(isNodeLive(record, new Date(clock.nowMs()), { windowMs: 86_400_000 })).toBe(false);
  });

  it("leaves a node that is merely quiet judged by its heartbeat, as before", async () => {
    const record = await getNode(clock.ctx, NODE_B);

    expect(isNodeLive(record, new Date(clock.nowMs()))).toBe(true);
    expect(isNodeLive(record, new Date(clock.nowMs() + NODE_LIVENESS_WINDOW_MS))).toBe(false);
  });
});

describe("drainNode", () => {
  it("touches drainingAt and nothing else about the record", async () => {
    const before = await getNode(clock.ctx, NODE_B);

    const at = await drainNode(clock.ctx, NODE_B);

    expect(await getNode(clock.ctx, NODE_B)).toEqual({ ...before, drainingAt: at });
  });

  it("refuses a node with no record, because it states something about one", async () => {
    expect((await rejectionOf(() => drainNode(clock.ctx, "node-ghost"))).code).toBe("not-found");
  });
});

describe("registering again", () => {
  it("clears a leftover drainingAt, because a node that has started serves again", async () => {
    await drainNode(clock.ctx, NODE_B);
    expect((await getNode(clock.ctx, NODE_B)).drainingAt).toBeDefined();

    await register(NODE_B);

    /* The record is rewritten wholesale on every boot, which is what takes the
       node back into service: a restart that left the flag behind would leave a
       perfectly healthy node running nothing at all, forever. */
    const record = await getNode(clock.ctx, NODE_B);
    expect(record.drainingAt).toBeUndefined();
    expect(isNodeLive(record, new Date(clock.nowMs()))).toBe(true);
  });
});

describe("what the coordinator does about it", () => {
  it("moves an environment off a draining node on the very next pass", async () => {
    await deployed("prod");
    await runAssignment(clock.ctx, lease);
    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A, NODE_B]);

    /* No time passes at all: this is the difference between a graceful stop and
       a crash, which would have to wait out the whole liveness window first. */
    await drainNode(clock.ctx, NODE_B);
    await runAssignment(clock.ctx, lease);

    expect((await readPlacement(clock.ctx, PROJECT, "prod"))?.nodes).toEqual([NODE_A]);
  });

  it("hands a single-replica environment to the node that is staying", async () => {
    await deployed("solo");
    await createEnvironment(clock.ctx, PROJECT, { name: "ignored" });
    const first = await runAssignment(clock.ctx, lease);
    const holder = (await readPlacement(clock.ctx, PROJECT, "solo"))?.nodes ?? [];
    expect(first.live).toEqual([NODE_A, NODE_B]);

    await drainNode(clock.ctx, holder[0] === NODE_A ? NODE_A : NODE_B);
    await runAssignment(clock.ctx, lease);

    /* Whichever node held it, it is now on the other one — and "all" is what
       "solo" resolves to here, so the assertion is about the fleet shrinking. */
    const after = (await readPlacement(clock.ctx, PROJECT, "solo"))?.nodes ?? [];
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(holder[0]);
  });

  it("refuses to decide anything when every node is draining", async () => {
    await deployed("prod");
    await runAssignment(clock.ctx, lease);
    const before = await readPlacement(clock.ctx, PROJECT, "prod");

    for (const id of [NODE_A, NODE_B]) await drainNode(clock.ctx, id);

    /*
     * A whole fleet restarting at once reads as an empty node list, and the
     * decision that follows from an empty list — "nothing is served anywhere" —
     * is the one no outage is entitled to make. The last decision stands.
     */
    const error = await rejectsWith(() => runAssignment(clock.ctx, lease), "placement-unavailable");
    expect(error.detail).toContain("no registered node");
    expect(await readPlacement(clock.ctx, PROJECT, "prod")).toEqual(before);
  });
});

describe("drainThisNode, as a shutdown calls it", () => {
  it("writes the flag and says so", async () => {
    const at = await drainThisNode(clock.ctx, NODE_A, { log: (message) => logged.push(message) });

    expect(at).toBe(new Date(clock.nowMs()).toISOString());
    expect((await getNode(clock.ctx, NODE_A)).drainingAt).toBe(at);
    expect(logged.join("\n")).toContain("draining");
  });

  it("retries a write the bucket refused once, within its bounded budget", async () => {
    let tries = 0;
    store.failAfter(0);
    store.onBeforePut = (): void => {
      tries++;
      /* The bucket comes back for the second attempt. */
      if (tries >= 2) store.clearFaults();
    };

    const at = await drainThisNode(clock.ctx, NODE_A, {
      log: (message) => logged.push(message),
      sleep: async () => {},
    });

    expect(tries).toBe(2);
    expect(at).not.toBeNull();
    expect((await getNode(clock.ctx, NODE_A)).drainingAt).toBe(at);
  });

  it("NEVER throws, so an unreachable bucket cannot hold a shutdown open", async () => {
    store.failAfter(0);

    const at = await drainThisNode(clock.ctx, NODE_A, {
      log: (message) => logged.push(message),
      sleep: async () => {},
    });

    /* The node leaves either way; the fleet falls back to counting it out after
       the liveness window, exactly as it did before draining existed. */
    expect(at).toBeNull();
    expect(logged.join("\n")).toContain("liveness window");
    expect((await getNode(clock.ctx, NODE_A)).drainingAt).toBeUndefined();
  });

  it("gives up rather than retrying forever", async () => {
    let tries = 0;
    store.failAfter(0);
    store.onBeforePut = (): void => {
      tries++;
    };

    await drainThisNode(clock.ctx, NODE_A, {
      attempts: 2,
      log: (message) => logged.push(message),
      sleep: async () => {},
    });

    expect(tries).toBe(2);
  });
});

/** An environment with a deployment to serve, so it is a real placement target. */
async function deployed(name: string): Promise<void> {
  await createEnvironment(clock.ctx, PROJECT, { name });
  await recordRevision(clock.ctx, PROJECT, name, VERSION);
}

/** Registers `id` as a node that has just beaten, exactly as a boot does. */
async function register(id: string): Promise<NodeRecord> {
  return registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `key-${id}` },
    addresses: { internal: `10.0.0.${id === NODE_A ? "1" : "2"}`, apiPort: 7400 },
    heartbeatAt: new Date(clock.nowMs()).toISOString(),
  });
}
