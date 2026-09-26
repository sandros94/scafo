import { describe, expect, it } from "vitest";
import { preferNode, renderFleetRouting } from "../src/core/placement/fleet-routes.ts";
import { API_DENIED_PREFIXES } from "../src/core/placement/routes.ts";
import type { ApplicationRecord, NodeRecord, NodeServing } from "../src/core/types/registry.ts";

const NAME = "shop";
/** The custom host the wildcard cases are claimed on. */
const BASE = "shop.example.com";
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
      wildcards: ["apps.test"],
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

  it("renders the four rules a claim made with its subdomains stands for", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [
        covering(application(NAME, [BASE]), [BASE]),
        application("shop-preview"),
        /* Not of the family, so its name under the base means nothing here. */
        application("blog"),
      ],
      nodes: [
        node("node-a", "10.83.0.1", {
          "shop": { port: 42_000 },
          "shop-preview": { port: 42_002 },
          "blog": { port: 42_004 },
        }),
      ],
      now: NOW,
    });

    expect(
      routing.routes.map((route) => ({ host: route.host, application: route.application })),
    ).toEqual([
      /* Rule 3: everything one label under the base that nothing else names. */
      { host: `*.${BASE}`, application: NAME },
      { host: "blog.apps.test", application: "blog" },
      /* Rule 2: the environment's own name under the base. */
      { host: `preview.${BASE}`, application: "shop-preview" },
      { host: "shop-preview.apps.test", application: "shop-preview" },
      { host: "shop.apps.test", application: NAME },
      /* Rule 1: the base itself. */
      { host: BASE, application: NAME },
    ]);
    /* Rule 4: two labels under the base is nobody's, and no key matches it. */
    expect(routing.routes.map((route) => route.host)).not.toContain(`*.preview.${BASE}`);
  });

  it("lets an exact claim under the base win over the wildcard that encloses it", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [
        covering(application(NAME, [BASE]), [BASE]),
        /* The family member holds the same host exactly; the claim decides. */
        application("shop-preview", [`preview.${BASE}`]),
      ],
      nodes: [
        node("node-a", "10.83.0.1", {
          "shop": { port: 42_000 },
          "shop-preview": { port: 42_002 },
        }),
      ],
      now: NOW,
    });

    expect(routing.routes.find((route) => route.host === `preview.${BASE}`)).toMatchObject({
      application: "shop-preview",
      upstreams: [{ node: "node-a", address: "10.83.0.1:42002" }],
    });
  });

  it("falls back to the holder for an environment that is not being served", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [covering(application(NAME, [BASE]), [BASE]), application("shop-preview")],
      nodes: [node("node-a", "10.83.0.1", { shop: { port: 42_000 } })],
      now: NOW,
    });

    /* Nothing serves `shop-preview`, so no exact entry is written for it and a
       request for that name falls to the one `*.` key, which is the holder. */
    expect(routing.routes.map((route) => route.host)).toEqual([
      `*.${BASE}`,
      "shop.apps.test",
      BASE,
    ]);
  });

  it("writes nothing of a wildcard whose holder is not being served", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [covering(application(NAME, [BASE]), [BASE]), application("shop-preview")],
      nodes: [node("node-a", "10.83.0.1", { "shop-preview": { port: 42_002 } })],
      now: NOW,
    });

    /* The environment still answers at the name the base gives it: that entry
       stands on its own upstreams rather than on the holder's. */
    expect(routing.routes.map((route) => route.host)).toEqual([
      `preview.${BASE}`,
      "shop-preview.apps.test",
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

  it("asks for a wildcard per platform domain whether anything is deployed or not", () => {
    /* Sorted, and stated before the first deploy: an ingress obtains the
       certificate before it can answer the first request that needs it. */
    const routing = renderFleetRouting({
      platformDomains: ["edge.example.com", "apps.test"],
      applications: [],
      nodes: [],
      now: NOW,
    });

    expect(routing.wildcards).toEqual(["apps.test", "edge.example.com"]);
    expect(routing.routes).toEqual([]);
  });

  it("adds the base of every wildcard route it published, sorted and without repeats", () => {
    const other = "blog.example.com";
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [
        covering(application(NAME, [BASE]), [BASE]),
        covering(application("blog", [other]), [other]),
        /* Claimed without its subdomains: its own name and nothing under it,
           so no wildcard is wanted for it. */
        application("shop-preview", [`plain.${BASE}`]),
      ],
      nodes: [
        node("node-a", "10.83.0.1", {
          "shop": { port: 42_000 },
          "blog": { port: 42_002 },
          "shop-preview": { port: 42_004 },
        }),
      ],
      now: NOW,
    });

    expect(routing.wildcards).toEqual(["apps.test", other, BASE]);
    /* Exactly the bases the document wrote a `*.` key for, and the platform. */
    expect(routing.routes.filter((route) => route.host.startsWith("*.")).length).toBe(2);
  });

  it("wants no certificate for a base whose wildcard route it did not publish", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [covering(application(NAME, [BASE]), [BASE]), application("shop-preview")],
      /* The holder is served nowhere, so the `*.` key is not published — and a
         certificate for a base nothing answers under is a certificate for
         nothing. The environment's own entry stands on its own upstreams. */
      nodes: [node("node-a", "10.83.0.1", { "shop-preview": { port: 42_002 } })],
      now: NOW,
    });

    expect(routing.wildcards).toEqual(["apps.test"]);
  });

  it("omits the field entirely where nothing wants a wildcard at all", () => {
    const routing = renderFleetRouting({
      platformDomains: [],
      applications: [application(NAME, [BASE])],
      nodes: [node("node-a", "10.83.0.1", { shop: { port: 42_000 } })],
      now: NOW,
    });

    expect(routing.routes.map((route) => route.host)).toEqual([BASE]);
    expect(routing.wildcards).toBeUndefined();
    expect(Object.hasOwn(routing, "wildcards")).toBe(false);
  });

  it("keeps the wildcards it stated when one node is put first", () => {
    const routing = renderFleetRouting({
      platformDomains: ["apps.test"],
      applications: [covering(application(NAME, [BASE]), [BASE])],
      nodes: [node("node-a", "10.83.0.1", { shop: { port: 42_000 } })],
      now: NOW,
    });

    expect(preferNode(routing, "node-a").wildcards).toEqual(["apps.test", BASE]);
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

/** The same record with some of its hosts claimed WITH their subdomains. */
function covering(record: ApplicationRecord, hosts: string[]): ApplicationRecord {
  return { ...record, wildcardDomains: hosts };
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
