import { describe, expect, it } from "vitest";
import { preferNode, renderFleetRouting } from "../src/core/placement/fleet-routes.ts";
import { API_DENIED_PREFIXES } from "../src/core/placement/routes.ts";
import type { ApplicationRecord, NodeRecord, NodeServing } from "../src/core/types/registry.ts";

const NAME = "shop";
const NOW = new Date("2026-01-01T00:01:00.000Z");
const FRESH = "2026-01-01T00:00:50.000Z";
const STALE = "2025-12-31T23:00:00.000Z";

describe("fleet routing", () => {
  it("points every host of an application at every live node serving it, in node order", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [application(NAME, ["shop.example.com"])],
      nodes: [
        node("node-b", "10.83.0.2", { shop: { port: 42_002 } }),
        node("node-a", "10.83.0.1", { shop: { port: 42_000 } }),
      ],
      now: NOW,
    });

    const upstreams = [
      { node: "node-a", address: "10.83.0.1:42000" },
      { node: "node-b", address: "10.83.0.2:42002" },
    ];
    expect(routing).toEqual({
      v: 1,
      routes: [
        { host: "shop.apps.test", application: NAME, upstreams },
        { host: "shop.example.com", application: NAME, upstreams },
      ],
    });
  });

  it("leaves out draining and stale nodes, and hosts nobody is left to serve", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [application(NAME), application("shop-preview")],
      nodes: [
        node("node-a", "10.83.0.1", { shop: { port: 42_000 } }),
        {
          ...node("node-b", "10.83.0.2", { shop: { port: 42_000 } }),
          drainingAt: FRESH,
        },
        {
          ...node("node-c", "10.83.0.3", { "shop-preview": { port: 42_000 } }),
          heartbeatAt: STALE,
        },
        node("node-d", "10.83.0.4"),
      ],
      now: NOW,
    });

    expect(routing.routes.map((route) => route.host)).toEqual(["shop.apps.test"]);
    expect(routing.routes[0]?.upstreams).toEqual([{ node: "node-a", address: "10.83.0.1:42000" }]);
  });

  it("never lets a claim shadow a platform host", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [application(NAME), application("shop-preview", ["shop.apps.test"])],
      nodes: [
        node("node-a", "10.83.0.1", {
          "shop": { port: 42_000 },
          "shop-preview": { port: 42_002 },
        }),
      ],
      now: NOW,
    });

    expect(routing.routes.find((route) => route.host === "shop.apps.test")?.application).toBe(NAME);
  });

  it("gives an application whose name merely shares a prefix its own host", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [application(NAME), application("shop-preview"), application("shop2")],
      nodes: [
        node("node-a", "10.83.0.1", {
          "shop": { port: 42_000 },
          "shop-preview": { port: 42_002 },
          "shop2": { port: 42_004 },
        }),
      ],
      now: NOW,
    });

    expect(
      routing.routes.map((route) => ({ host: route.host, application: route.application })),
    ).toEqual([
      { host: "shop-preview.apps.test", application: "shop-preview" },
      { host: "shop.apps.test", application: NAME },
      { host: "shop2.apps.test", application: "shop2" },
    ]);
  });

  it("publishes the API at every free apex through every live node, when asked", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test", "shop.apps.test"],
      applications: [application(NAME)],
      nodes: [node("node-a", "10.83.0.1", { shop: { port: 42_000 } }), node("node-b", "[fd00::2]")],
      now: NOW,
      api: true,
    });

    expect(routing.api).toEqual({
      hosts: ["apps.test"],
      upstreams: [
        { node: "node-a", address: "10.83.0.1:7400" },
        { node: "node-b", address: "[fd00::2]:7400" },
      ],
      denied: API_DENIED_PREFIXES,
    });
    expect(
      renderFleetRouting({ platformDomains: ["apps.test"], applications: [], nodes: [], now: NOW })
        .api,
    ).toBeUndefined();
  });

  it("puts one node first on every route when preferred, keeping the rest in order", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [application(NAME)],
      nodes: [
        node("node-a", "10.83.0.1", { shop: { port: 42_000 } }),
        node("node-b", "10.83.0.2", { shop: { port: 42_000 } }),
        node("node-c", "10.83.0.3", { shop: { port: 42_000 } }),
      ],
      now: NOW,
      api: true,
    });

    const local = preferNode(routing, "node-c");
    expect(local.routes[0]?.upstreams.map((upstream) => upstream.node)).toEqual([
      "node-c",
      "node-a",
      "node-b",
    ]);
    expect(local.api?.upstreams.map((upstream) => upstream.node)).toEqual([
      "node-c",
      "node-a",
      "node-b",
    ]);
    expect(preferNode(routing, "node-z")).toEqual(routing);
  });
});

function application(name: string, domains: string[] = []): ApplicationRecord {
  return {
    v: 1,
    name,
    deployment: { revision: 2, deployedAt: "2026-01-01T00:00:00.000Z" },
    domains,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function node(id: string, internal: string, serving?: NodeServing): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: id },
    addresses: { internal, apiPort: 7400 },
    heartbeatAt: FRESH,
    ...(serving === undefined ? {} : { serving }),
  };
}
