/* `scafo fleet nodes`: the machines of one installation, read straight out of the bucket. */

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
    await register(clock, "node-b", {
      labels: { tier: "fast", region: "eu-west-1" },
      versions: { scafo: "0.0.0", celld: "0.5.0" },
    });
    await register(clock, "node-a", {});

    const listing = await listFleetNodes(clock.ctx, { now: new Date(clock.nowMs()) });

    expect(listing.map((node) => node.id)).toEqual(["node-a", "node-b"]);
    expect(listing[1]).toMatchObject({
      internal: "10.0.0.2",
      apiPort: 7400,
      labels: { region: "eu-west-1", tier: "fast" },
      /* Carried through untouched, so `--json` says which binaries are where. */
      versions: { scafo: "0.0.0", celld: "0.5.0" },
    });
    expect(listing[0]?.versions).toBeUndefined();
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
    /* Nothing here was written by a daemon that records versions. */
    expect(printed).toContain("celld: unreported on 2 nodes");
    expect(printed).toContain("scafo: unreported on 2 nodes");
  });

  it("says what each machine runs, and rolls the fleet up by binary", async () => {
    const clock = ctxWith(new MemoryCasStore());
    await register(clock, "node-a", { versions: { scafo: "0.0.0", celld: "0.5.0" } });
    await register(clock, "node-b", { versions: { scafo: "0.0.0", celld: "0.5.0" } });
    await register(clock, "node-c", { versions: { scafo: "0.0.0", celld: "0.4.1" } });
    await register(clock, "node-d", {});
    const now = new Date(clock.nowMs());

    const printed = formatNodeTable(await listFleetNodes(clock.ctx, { now }), now);

    expect(printed).toContain("CELLD  SCAFO  LABELS");
    /* Newest first: the question is how much of the fleet is still on the old one. */
    expect(printed).toContain("celld: 0.5.0 on 2 nodes, 0.4.1 on 1, unreported on 1");
    expect(printed).toContain("scafo: 0.0.0 on 3 nodes, unreported on 1");
    /* A record from a build that kept no versions reads as a dash, not a guess. */
    expect(printed).toMatch(/^ {2}node-d\s+lost\s+never\s+\S+\s+-\s+-$/m);
  });

  it("says plainly when the bucket holds no node, and how a machine joins", async () => {
    const clock = ctxWith(new MemoryCasStore());

    expect(formatNodeTable(await listFleetNodes(clock.ctx))).toContain("scafo sail");
  });
});

function register(clock: ManualClock, id: string, extra: Partial<NodeRecord>): Promise<NodeRecord> {
  return registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `x-${id}` },
    addresses: { internal: id === "node-a" ? "10.0.0.1" : "10.0.0.2", apiPort: 7400 },
    ...extra,
  });
}
