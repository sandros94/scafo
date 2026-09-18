/*
 * The gate on an application's Celld fleet: which other nodes are serving it
 * right now, and on which binary.
 */

import { describe, expect, it } from "vitest";
import { findVersionSkew } from "../src/core/placement/version-skew.ts";
import { NODE_LIVENESS_WINDOW_MS } from "../src/core/registry/nodes.ts";
import type { NodeRecord, NodeServing } from "../src/core/types/registry.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SELF = "node-a";
const APPLICATION = "shop";
const CELLD = "0.5.0";

/** What a start or a deploy asks about: this node's binary, against everyone else's. */
function skewFor(nodes: NodeRecord[]): ReturnType<typeof findVersionSkew> {
  return findVersionSkew(nodes, {
    application: APPLICATION,
    celld: CELLD,
    selfId: SELF,
    now: NOW,
  });
}

describe("what counts as another version on the same application", () => {
  it("names a live node serving it on a different Celld", () => {
    expect(skewFor([node("node-b", { celld: "0.4.1", serving: serves(APPLICATION) })])).toEqual([
      { nodeId: "node-b", celld: "0.4.1" },
    ]);
  });

  it("names one that reports no versions at all, since nothing in it says otherwise", () => {
    /* A record written before the field existed is older, not unknowable. */
    expect(skewFor([node("node-b", { serving: serves(APPLICATION) })])).toEqual([
      { nodeId: "node-b", celld: undefined },
    ]);
  });

  it("says nothing about a node on the same Celld", () => {
    expect(skewFor([node("node-b", { celld: CELLD, serving: serves(APPLICATION) })])).toEqual([]);
  });

  it("never compares this node's own record against itself", () => {
    /* Its record carries whatever it booted with, which may be a boot ago. */
    expect(skewFor([node(SELF, { celld: "0.4.1", serving: serves(APPLICATION) })])).toEqual([]);
  });

  it("ignores a node nothing has been heard from inside the liveness window", () => {
    const lost = node("node-b", {
      celld: "0.4.1",
      serving: serves(APPLICATION),
      seenMsAgo: NODE_LIVENESS_WINDOW_MS + 1,
    });

    expect(skewFor([lost])).toEqual([]);
  });

  it("still counts a draining node while it is answering", () => {
    /* Draining says it is leaving, not that it has left: its Celld still holds
       the fleet's lease until the process is actually gone. */
    const leaving = node("node-b", {
      celld: "0.4.1",
      serving: serves(APPLICATION),
      draining: true,
    });

    expect(skewFor([leaving])).toEqual([{ nodeId: "node-b", celld: "0.4.1" }]);
  });

  it("ignores a node serving some other application on another version", () => {
    expect(skewFor([node("node-b", { celld: "0.4.1", serving: serves("blog") })])).toEqual([]);
  });

  it("answers in node order, whatever order the records arrived in", () => {
    const nodes = [
      node("node-c", { celld: "0.4.1", serving: serves(APPLICATION) }),
      node("node-b", { serving: serves(APPLICATION) }),
      node("node-d", { celld: "0.4.0", serving: serves(APPLICATION) }),
    ];

    expect(skewFor(nodes).map((entry) => entry.nodeId)).toEqual(["node-b", "node-c", "node-d"]);
  });

  it("tells one application from another whose name merely starts with it", () => {
    /* Serving is keyed by the exact name, so a sibling sharing a prefix holds
       its own fleet and never gates this one. */
    expect(skewFor([node("node-b", { celld: "0.4.1", serving: serves("shop-preview") })])).toEqual(
      [],
    );
  });
});

/* ---------------------------------------------------------------- fixtures */

function serves(application: string): NodeServing {
  return { [application]: { port: 42_000 } };
}

function node(
  id: string,
  opts: { celld?: string; serving?: NodeServing; seenMsAgo?: number; draining?: boolean },
): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `key-${id}` },
    addresses: { internal: "10.0.0.1", apiPort: 7400 },
    heartbeatAt: new Date(NOW.getTime() - (opts.seenMsAgo ?? 0)).toISOString(),
    ...(opts.draining === true ? { drainingAt: NOW.toISOString() } : {}),
    ...(opts.celld === undefined ? {} : { versions: { scafo: "0.0.0", celld: opts.celld } }),
    ...(opts.serving === undefined ? {} : { serving: opts.serving }),
  };
}
