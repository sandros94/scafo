/*
 * The gate on an application's Celld fleet: which other nodes are serving it
 * or failing to right now, and on which binary.
 */

import { describe, expect, it } from "vitest";
import { findVersionSkew, versionSkewError } from "../src/core/placement/version-skew.ts";
import {
  celldReleasesMayShareFleet,
  ROLLING_CELLD_RELEASES,
} from "../src/core/registry/_celld-contract.ts";
import { NODE_LIVENESS_WINDOW_MS } from "../src/core/registry/nodes.ts";
import type { NodeFailing, NodeRecord, NodeServing } from "../src/core/types/registry.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const SELF = "node-a";
const APPLICATION = "shop";
const CELLD = "0.5.0";

/** What a start or a deploy asks about: this node's binary, against everyone else's. */
function skewFor(nodes: NodeRecord[], celld = CELLD): ReturnType<typeof findVersionSkew> {
  return findVersionSkew(nodes, {
    application: APPLICATION,
    celld,
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

  it("names a live node whose process for it is failing on a different Celld", () => {
    /* A crash-looping process is published under `failing`, not `serving`,
       and every run of it still takes a lease in the fleet. */
    expect(skewFor([node("node-b", { celld: "0.4.1", failing: fails(APPLICATION) })])).toEqual([
      { nodeId: "node-b", celld: "0.4.1" },
    ]);
  });

  it("says nothing about a failing process on the same Celld or the other half of a pair", () => {
    expect(skewFor([node("node-b", { celld: CELLD, failing: fails(APPLICATION) })])).toEqual([]);
    expect(skewFor([node("node-b", { celld: "0.5.1", failing: fails(APPLICATION) })])).toEqual([]);
  });

  it("ignores a node failing some other application on another version", () => {
    expect(skewFor([node("node-b", { celld: "0.4.1", failing: fails("blog") })])).toEqual([]);
  });

  it("tells one application from another whose name merely starts with it", () => {
    /* Serving is keyed by the exact name, so a sibling sharing a prefix holds
       its own fleet and never gates this one. */
    expect(skewFor([node("node-b", { celld: "0.4.1", serving: serves("shop-preview") })])).toEqual(
      [],
    );
  });
});

describe("releases upstream declared may roll", () => {
  it("says nothing about a live node on the other half of a declared pair", () => {
    /* Celld 0.5.1's release notes: "Upgrading from v0.5.0 can use a rolling
       update." Both directions, since a roll has nodes on each side of it. */
    expect(skewFor([node("node-b", { celld: "0.5.1", serving: serves(APPLICATION) })])).toEqual([]);
    expect(
      skewFor([node("node-b", { celld: "0.5.0", serving: serves(APPLICATION) })], "0.5.1"),
    ).toEqual([]);
  });

  it("still names a node on a release no declared pair joins to this one", () => {
    expect(
      skewFor([node("node-b", { celld: "0.4.1", serving: serves(APPLICATION) })], "0.5.1"),
    ).toEqual([{ nodeId: "node-b", celld: "0.4.1" }]);
  });

  it("still names a node that reports no versions, beside either half of a pair", () => {
    for (const celld of ["0.5.0", "0.5.1"]) {
      expect(skewFor([node("node-b", { serving: serves(APPLICATION) })], celld)).toEqual([
        { nodeId: "node-b", celld: undefined },
      ]);
    }
  });

  it("names only the node a pair does not cover when both kinds hold the application", () => {
    const nodes = [
      node("node-b", { celld: "0.5.1", serving: serves(APPLICATION) }),
      node("node-c", { celld: "0.4.1", serving: serves(APPLICATION) }),
    ];

    expect(skewFor(nodes)).toEqual([{ nodeId: "node-c", celld: "0.4.1" }]);
  });

  it("answers the same whichever release is asked about first", () => {
    const releases = [...new Set(["0.4.1", "0.5.2", ...ROLLING_CELLD_RELEASES.flat()])];
    for (const a of releases) {
      for (const b of releases) {
        expect(celldReleasesMayShareFleet(a, b)).toBe(celldReleasesMayShareFleet(b, a));
      }
    }
  });

  it("lets an unreported release share a fleet with nothing, not even another one", () => {
    expect(celldReleasesMayShareFleet(undefined, "0.5.0")).toBe(false);
    expect(celldReleasesMayShareFleet("0.5.0", undefined)).toBe(false);
    expect(celldReleasesMayShareFleet(undefined, undefined)).toBe(false);
  });

  it("infers nothing from version numbers", () => {
    /* A later patch release rolls only once its own notes say so. */
    expect(celldReleasesMayShareFleet("0.5.1", "0.5.2")).toBe(false);
    expect(celldReleasesMayShareFleet("0.5.0", "0.5.2")).toBe(false);
  });

  it("lets 0.6.0 share a fleet with itself and with no earlier release", () => {
    /* Celld 0.6.0's release notes: "Upgrading from v0.5.1 with fleet
       durability requires stopping the whole fleet first." */
    expect(celldReleasesMayShareFleet("0.6.0", "0.6.0")).toBe(true);
    expect(celldReleasesMayShareFleet("0.5.1", "0.6.0")).toBe(false);
    expect(celldReleasesMayShareFleet("0.5.0", "0.6.0")).toBe(false);
  });

  it("names a node on 0.5.1 or 0.5.0 to a node starting 0.6.0, and the reverse", () => {
    for (const older of ["0.5.0", "0.5.1"]) {
      expect(
        skewFor([node("node-b", { celld: older, serving: serves(APPLICATION) })], "0.6.0"),
      ).toEqual([{ nodeId: "node-b", celld: older }]);
      expect(
        skewFor([node("node-b", { celld: "0.6.0", serving: serves(APPLICATION) })], older),
      ).toEqual([{ nodeId: "node-b", celld: "0.6.0" }]);
    }
    expect(
      skewFor([node("node-b", { celld: "0.6.0", serving: serves(APPLICATION) })], "0.6.0"),
    ).toEqual([]);
  });

  it("lets 0.6.0 and 0.6.1 share a fleet, in either direction", () => {
    /* Celld 0.6.1's release notes: "Upgrading from v0.6.0 can use a rolling
       update." */
    expect(celldReleasesMayShareFleet("0.6.0", "0.6.1")).toBe(true);
    expect(
      skewFor([node("node-b", { celld: "0.6.0", serving: serves(APPLICATION) })], "0.6.1"),
    ).toEqual([]);
    expect(
      skewFor([node("node-b", { celld: "0.6.1", serving: serves(APPLICATION) })], "0.6.0"),
    ).toEqual([]);
  });

  it("names a node on 0.5.x to a node starting 0.6.1, and the reverse", () => {
    for (const older of ["0.5.0", "0.5.1"]) {
      expect(celldReleasesMayShareFleet(older, "0.6.1")).toBe(false);
      expect(
        skewFor([node("node-b", { celld: older, serving: serves(APPLICATION) })], "0.6.1"),
      ).toEqual([{ nodeId: "node-b", celld: older }]);
      expect(
        skewFor([node("node-b", { celld: "0.6.1", serving: serves(APPLICATION) })], older),
      ).toEqual([{ nodeId: "node-b", celld: "0.6.1" }]);
    }
  });

  it("names every node and the pairs this build allows in the refusal", () => {
    const error = versionSkewError(
      [
        { nodeId: "node-b", celld: "0.4.1" },
        { nodeId: "node-c", celld: undefined },
      ],
      { application: APPLICATION, celld: "0.5.1" },
    );

    expect(error.code).toBe("version-skew");
    expect(error.detail).toContain("node-b (celld 0.4.1)");
    expect(error.detail).toContain("node-c (celld unreported)");
    expect(error.detail).toContain("rolling pairs this build allows: 0.5.0↔0.5.1, 0.6.0↔0.6.1)");
    expect(error.detail).toContain("stop every node of this installation");
  });
});

/* ---------------------------------------------------------------- fixtures */

function serves(application: string): NodeServing {
  return { [application]: { port: 42_000 } };
}

function fails(application: string): NodeFailing {
  return { [application]: { since: NOW.toISOString(), restarts: 3 } };
}

function node(
  id: string,
  opts: {
    celld?: string;
    serving?: NodeServing;
    failing?: NodeFailing;
    seenMsAgo?: number;
    draining?: boolean;
  },
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
    ...(opts.failing === undefined ? {} : { failing: opts.failing }),
  };
}
