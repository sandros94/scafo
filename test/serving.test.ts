import { describe, expect, it } from "vitest";
import {
  applicationServing,
  sameFailing,
  sameServing,
  servingOf,
} from "../src/core/placement/serving.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

function process(application: string, port: number): RuntimeProcess {
  return { application, port, internalPort: port + 1 };
}

/** Every application of `processes` has answered for itself. */
function allReady(processes: RuntimeProcess[]): { ready: ReadonlySet<string> } {
  return { ready: new Set(processes.map((entry) => entry.application)) };
}

describe("what a node publishes as served", () => {
  it("lists every ready process by application name with its public port, in one order", () => {
    const processes = [process("shop", 42_002), process("blog", 42_000)];
    const serving = servingOf(processes, allReady(processes));

    expect(Object.keys(serving)).toEqual(["blog", "shop"]);
    expect(serving).toEqual({
      blog: { port: 42_000 },
      shop: { port: 42_002 },
    });
  });

  /* The defect: a process holds its port from the moment it is spawned, and a
     process that never becomes ready holds it forever. Publishing it is a route
     to a refused connection. */
  it("names nothing for a process that has not answered its health endpoint yet", () => {
    const processes = [process("shop", 42_000), process("blog", 42_002)];

    expect(servingOf(processes, { ready: new Set(["blog"]) })).toEqual({
      blog: { port: 42_002 },
    });
    expect(servingOf(processes, { ready: new Set() })).toEqual({});
  });

  it("keeps a ready process whose stop is still pending: it may still be answering", () => {
    const stuck: RuntimeProcess = { ...process("shop", 42_000), teardownPending: true };

    expect(servingOf([stuck], allReady([stuck]))).toEqual({ shop: { port: 42_000 } });
  });

  /* A process that exits every few seconds answers between restarts, so
     readiness alone would let it back into the routing on the good seconds. */
  it("drops a crash-looping process even while it is answering", () => {
    const processes = [process("shop", 42_000), process("blog", 42_002)];
    const serving = servingOf(processes, {
      ...allReady(processes),
      failing: new Set(["shop"]),
    });

    expect(serving).toEqual({ blog: { port: 42_002 } });
  });

  it("compares by content, treating an absent set as an empty one", () => {
    const one = [process("shop", 42_000)];
    const a = servingOf(one, allReady(one));

    expect(sameServing(a, { shop: { port: 42_000 } })).toBe(true);
    expect(sameServing(a, { shop: { port: 42_002 } })).toBe(false);
    expect(sameServing(a, {})).toBe(false);
    expect(sameServing(undefined, {})).toBe(true);
    expect(sameServing(servingOf([], { ready: new Set() }), undefined)).toBe(true);
  });
});

describe("what a node says it cannot keep running", () => {
  const failure = { since: "2026-09-20T12:00:00.000Z", restarts: 4, lastError: "Error: wedged" };

  it("compares by which applications are failing and what they said, not by the count", () => {
    expect(sameFailing({ shop: failure }, { shop: failure })).toBe(true);
    /* The restart count climbs every few seconds while the loop stands, and a
       beat and a hint for each of those would be the fleet re-listing the
       registry for news nothing routes on. */
    expect(sameFailing({ shop: failure }, { shop: { ...failure, restarts: 9 } })).toBe(true);
    expect(sameFailing({ shop: failure }, { shop: { ...failure, lastError: "other" } })).toBe(
      false,
    );
    expect(sameFailing({ shop: failure }, {})).toBe(false);
    expect(sameFailing({ shop: failure }, { blog: failure })).toBe(false);
    expect(sameFailing(undefined, {})).toBe(true);
  });
});

describe("how much of the fleet is really serving one application", () => {
  const NOW = new Date("2026-09-20T12:00:00.000Z");
  const failure = { since: "2026-09-20T11:59:00.000Z", restarts: 4, lastError: "Error: wedged" };

  function node(id: string, opts: Partial<NodeRecord>): NodeRecord {
    return {
      v: 1,
      id,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "fixture" },
      addresses: { internal: "10.0.0.1", apiPort: 7400 },
      heartbeatAt: NOW.toISOString(),
      ...opts,
    };
  }

  it("counts the nodes holding it and names the ones that cannot keep it up", () => {
    const seen = applicationServing(
      "shop",
      [
        node("node-b", { serving: { shop: { port: 1 } } }),
        node("node-a", { serving: { shop: { port: 1 } } }),
        node("node-c", { failing: { shop: failure } }),
      ],
      NOW,
    );

    expect(seen.nodes).toBe(3);
    expect(seen.serving).toBe(2);
    expect(seen.failing).toEqual([
      { node: "node-c", since: failure.since, restarts: 4, lastError: failure.lastError },
    ]);
  });

  it("says nothing about a node that stopped answering or is on its way out", () => {
    const seen = applicationServing(
      "shop",
      [
        node("node-gone", {
          heartbeatAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
          failing: { shop: failure },
        }),
        node("node-leaving", { drainingAt: NOW.toISOString(), failing: { shop: failure } }),
      ],
      NOW,
    );

    expect(seen).toEqual({ nodes: 0, serving: 0, failing: [] });
  });

  it("says nothing at all about an application no node holds", () => {
    expect(applicationServing("shop", [node("node-a", {})], NOW)).toEqual({
      nodes: 0,
      serving: 0,
      failing: [],
    });
  });
});
