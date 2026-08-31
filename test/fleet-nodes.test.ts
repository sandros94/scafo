/*
 * `scafo fleet nodes`: the machines of one installation, read straight out of
 * the bucket.
 *
 * THE FAILURE CASE IS THE CASE. An operator runs this when a node has stopped
 * answering, so the reading must not depend on a node answering — and the
 * liveness it reports has to be the SAME judgement placement makes, or it
 * becomes a second opinion an operator has to reconcile against the behaviour
 * they are actually seeing.
 */

import { describe, expect, it } from "vitest";
import { formatNodeTable, listFleetNodes } from "../src/cli/_nodes.ts";
import {
  NODE_HEARTBEAT_INTERVAL_MS,
  NODE_LIVENESS_WINDOW_MS,
  drainNode,
  heartbeatNode,
  registerNode,
} from "../src/core/registry/nodes.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

describe("what the listing reads", () => {
  it("names every registered node, in id order, with its address and its labels", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await register(clock, "node-b", { labels: { tier: "fast", region: "eu-west-1" } });
    await register(clock, "node-a", {});

    const listing = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });

    expect(listing.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(listing[1]).toMatchObject({
      internal: "10.0.0.2",
      apiPort: 7400,
      labels: { region: "eu-west-1", tier: "fast" },
    });
  });

  it("counts a node live for exactly as long as placement does", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await register(clock, "node-a", {});
    await heartbeatNode(clock.ctx, "node-a");

    clock.tick(NODE_LIVENESS_WINDOW_MS - 1);
    const inside = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });
    clock.tick(2);
    const outside = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });

    expect(inside[0]?.state).toBe("live");
    expect(outside[0]?.state).toBe("lost");
  });

  it("says draining rather than lost for a node that announced it was leaving", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await register(clock, "node-a", {});
    await heartbeatNode(clock.ctx, "node-a");
    await drainNode(clock.ctx, "node-a");

    const listing = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });

    /* A draining node has usually just beaten — it is stopping in order, not
       failing — and reading it as lost would hide the difference that matters. */
    expect(listing[0]).toMatchObject({ state: "draining" });
    expect(listing[0]?.drainingAt).toBeTypeOf("string");
  });

  it("is NOT live when nothing in the record says when the node was last seen", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await register(clock, "node-a", {});

    const listing = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });

    /* Guessing "recently" would hand work to a machine that may be years gone. */
    expect(listing[0]?.state).toBe("lost");
    expect(listing[0]?.seenAt).toBeUndefined();
  });
});

describe("what the listing prints", () => {
  it("puts the count and the liveness window first, then a row per machine", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await register(clock, "node-a", { labels: { tier: "fast" } });
    await heartbeatNode(clock.ctx, "node-a");
    await register(clock, "node-b", {});
    clock.tick(NODE_HEARTBEAT_INTERVAL_MS);

    const printed = formatNodeTable(
      await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) }),
      new Date(clock.nowMs()),
    );

    expect(printed).toContain("2 nodes, 1 live");
    expect(printed).toContain(String(NODE_LIVENESS_WINDOW_MS / 1000));
    expect(printed).toContain("NODE");
    expect(printed).toContain("node-a");
    expect(printed).toContain("tier=fast");
    expect(printed).toContain("30s ago");
    expect(printed).toContain("never");
  });

  it("says plainly when the bucket holds no node, and how a machine joins", async () => {
    const clock = ctxWith(new MemoryCasStore());

    expect(formatNodeTable(await listFleetNodes(clock.ctx))).toContain("scafo sail");
  });
});

/* ------------------------------------------------------------------ helpers */

function register(clock: ManualClock, id: string, extra: Partial<NodeRecord>): Promise<NodeRecord> {
  return registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `x-${id}` },
    addresses: { internal: id === "node-a" ? "10.0.0.1" : "10.0.0.2", apiPort: 7400 },
    ...extra,
  });
}
