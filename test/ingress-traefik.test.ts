/*
 * The Traefik ingress driver, and the agent route that publishes what it renders.
 *
 * There is no stand-in for Traefik here and there could not be one: this driver
 * makes no call at all. What it does is render a document and hold it, so the
 * assertions are about the document — and about the one route Traefik reads it
 * from, which is exercised through the real app.
 *
 * The empty-routing case is the one to read first. Its expected value looks
 * wrong and is not; the driver's own comment explains what Traefik does with the
 * obvious rendering, and `test/integration/e2e-traefik.test.ts` proves it
 * against the container.
 */

import type { H3 } from "h3";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentApp } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import type { IngressDesired, IngressDriver } from "../src/core/types/ingress.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { createCaddyDriver } from "../src/drivers/ingress/caddy.ts";
import {
  createTraefikDriver,
  DEFAULT_ENTRY_POINT,
  renderTraefikConfig,
  TRAEFIK_KEY_PREFIX,
  traefikLegKey,
  type TraefikDriver,
  type TraefikDynamicConfig,
  type TraefikLoadBalancerService,
} from "../src/drivers/ingress/traefik.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const NODE_ID = "node-a";
const HOST = "shop.apps.test";
const OTHER_HOST = "shop--staging.apps.test";
const BUILD = "aaaa1111";
const OTHER_BUILD = "bbbb2222";

let clock: ManualClock;
let driver: TraefikDriver;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
  driver = createTraefikDriver();
});

describe("rendering a routing", () => {
  it("writes one router and one service per host, under the shared key", async () => {
    await driver.apply(desired([[HOST, 42_000]]));

    expect(driver.snapshot()).toEqual({
      http: {
        routers: {
          [`${TRAEFIK_KEY_PREFIX}${HOST}`]: {
            rule: "Host(`shop.apps.test`)",
            service: `${TRAEFIK_KEY_PREFIX}${HOST}`,
            entryPoints: [DEFAULT_ENTRY_POINT],
          },
        },
        services: {
          [`${TRAEFIK_KEY_PREFIX}${HOST}`]: {
            loadBalancer: { servers: [{ url: "http://127.0.0.1:42000" }] },
          },
        },
      },
    });
  });

  it("names the same key on both sides, so the router resolves its service", async () => {
    await driver.apply(
      desired([
        [HOST, 42_000],
        [OTHER_HOST, 42_002],
      ]),
    );

    const http = driver.snapshot().http;
    for (const [key, router] of Object.entries(http?.routers ?? {})) {
      /* Unqualified on purpose: Traefik resolves a name without an `@` within
         the provider that supplied it, which is the document being served. */
      expect(router.service, `router "${key}"`).toBe(key);
      expect(http?.services[router.service], `service for "${key}"`).toBeDefined();
    }
  });

  it("orders the keys by host, whatever order the routing states them in", () => {
    const forwards = renderTraefikConfig(
      desired([
        [HOST, 42_000],
        [OTHER_HOST, 42_002],
      ]),
    );
    const backwards = renderTraefikConfig(
      desired([
        [OTHER_HOST, 42_002],
        [HOST, 42_000],
      ]),
    );

    /*
     * Byte-for-byte rather than deep-equal, because that is what the difference
     * costs here: Traefik hashes the body it polls and does nothing at all when
     * the bytes are unchanged, so a document whose key order wandered would look
     * like a change on every single pass.
     */
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
    expect(Object.keys(forwards.http?.routers ?? {})).toEqual([
      `${TRAEFIK_KEY_PREFIX}${OTHER_HOST}`,
      `${TRAEFIK_KEY_PREFIX}${HOST}`,
    ]);
  });

  it("renders the same document twice for the same routing", () => {
    const routing = desired([
      [HOST, 42_000],
      [OTHER_HOST, 42_002],
    ]);

    expect(renderTraefikConfig(routing)).toEqual(renderTraefikConfig(routing));
  });

  it("attaches the routers to the entryPoints the driver was built with", async () => {
    const wide = createTraefikDriver({ entryPoints: ["web", "websecure"] });

    await wide.apply(desired([[HOST, 42_000]]));

    expect(wide.snapshot().http?.routers[`${TRAEFIK_KEY_PREFIX}${HOST}`]?.entryPoints).toEqual([
      "web",
      "websecure",
    ]);
  });

  it("refuses a host that could be read as something other than a host", async () => {
    /*
     * A Traefik rule is a small language carried in a string, so a host holding
     * a backtick would not be a malformed name — it would be a different rule.
     * Every host reaching the driver has already passed `assertHost` upstream;
     * this is the check that keeps that true of the one format where it matters.
     */
    await rejectsWith(
      () => driver.apply(desired([["evil`) || Host(`admin.test", 42_000]])),
      "invalid-slug",
    );
  });
});

describe("saying that nothing is routed", () => {
  it("renders an EMPTY DOCUMENT, not empty maps", () => {
    /*
     * Pinned against Traefik 3.7.10, and the reason the driver does not render
     * the obvious thing. `{"http":{"routers":{},"services":{}}}` is refused by
     * Traefik's decoder — "routers cannot be a standalone element" — which makes
     * the poll a failed one, and a failed poll leaves the configuration Traefik
     * last read in place. A node that stopped serving an environment would go on
     * serving it. An empty document is what Traefik reads as "this provider
     * routes nothing".
     */
    expect(renderTraefikConfig({ routes: [] })).toEqual({});
    expect(JSON.stringify(renderTraefikConfig({ routes: [] }))).toBe("{}");
  });

  it("is what a driver that has not reconciled yet holds", () => {
    /* Routing follows readiness: a node that has just started runs none of its
       processes, so the honest answer is that it serves nothing. */
    expect(createTraefikDriver().snapshot()).toEqual({});
  });

  it("replaces a routing that had hosts in it", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    await driver.apply({ routes: [] });

    expect(driver.snapshot()).toEqual({});
  });
});

describe("caching what the reconcile loop applies", () => {
  it("keeps the last routing applied, and nothing of the one before it", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    await driver.apply(desired([[OTHER_HOST, 42_002]]));

    const routers = driver.snapshot().http?.routers ?? {};
    expect(Object.keys(routers)).toEqual([`${TRAEFIK_KEY_PREFIX}${OTHER_HOST}`]);
  });

  it("follows a host that moves to another backend", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    await driver.apply(desired([[HOST, 42_010]]));

    expect(driver.snapshot().http?.services[`${TRAEFIK_KEY_PREFIX}${HOST}`]).toEqual({
      loadBalancer: { servers: [{ url: "http://127.0.0.1:42010" }] },
    });
  });

  it("hands out a document that cannot be edited into the cache", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    const snapshot = driver.snapshot();
    await driver.apply(desired([[HOST, 42_010]]));

    /* The caller holds the document it was given; a later pass renders a new one
       rather than mutating the one already published. */
    const held = snapshot.http?.services[`${TRAEFIK_KEY_PREFIX}${HOST}`] as
      | TraefikLoadBalancerService
      | undefined;
    expect(held?.loadBalancer.servers).toEqual([{ url: "http://127.0.0.1:42000" }]);
  });
});

describe("a host divided between several backends", () => {
  /*
   * The shape below is not taken from the documentation. It was PINNED against
   * `traefik:v3` (v3.7.10) by serving it to a real http provider: the weighted
   * service was accepted, its unqualified child names resolved within the
   * document, and 200 requests over a two-leg `[90, 10]` split arrived 180/20,
   * exactly.
   */
  it("renders a weighted service over one child service per leg", () => {
    const config = renderTraefikConfig(
      split(HOST, [
        [BUILD, 42_000, 90],
        [OTHER_BUILD, 42_002, 10],
      ]),
    );

    expect(config).toEqual({
      http: {
        routers: {
          [`${TRAEFIK_KEY_PREFIX}${HOST}`]: {
            rule: "Host(`shop.apps.test`)",
            service: `${TRAEFIK_KEY_PREFIX}${HOST}`,
            entryPoints: [DEFAULT_ENTRY_POINT],
          },
        },
        services: {
          [`${TRAEFIK_KEY_PREFIX}${HOST}`]: {
            weighted: {
              services: [
                { name: traefikLegKey(HOST, BUILD), weight: 90 },
                { name: traefikLegKey(HOST, OTHER_BUILD), weight: 10 },
              ],
            },
          },
          [traefikLegKey(HOST, BUILD)]: {
            loadBalancer: { servers: [{ url: "http://127.0.0.1:42000" }] },
          },
          [traefikLegKey(HOST, OTHER_BUILD)]: {
            loadBalancer: { servers: [{ url: "http://127.0.0.1:42002" }] },
          },
        },
      },
    });
  });

  it("names every child in a way that resolves inside this document", () => {
    const config = renderTraefikConfig(
      split(HOST, [
        [BUILD, 42_000, 60],
        [OTHER_BUILD, 42_002, 40],
      ]),
    );
    const services = config.http?.services ?? {};
    const weighted = services[`${TRAEFIK_KEY_PREFIX}${HOST}`];

    for (const child of "weighted" in weighted ? weighted.weighted.services : []) {
      /* Unqualified on purpose: a name carrying `@` names another provider's
         service, and this document is the whole of what this provider supplies. */
      expect(child.name, child.name).not.toContain("@");
      expect(services[child.name], child.name).toBeDefined();
    }
  });

  it("keeps a child key from colliding with any router key", () => {
    /* The separator is the namespace's own underscore, which cannot occur in a
       DNS name or in a build id — unlike `--`, which every environment label
       carries and a claimed domain may too. */
    const config = renderTraefikConfig({
      routes: [
        ...split(OTHER_HOST, [
          [BUILD, 42_000, 70],
          [OTHER_BUILD, 42_002, 30],
        ]).routes,
        ...desired([[`${OTHER_HOST}--${BUILD}`, 42_004]]).routes,
      ],
    });

    const services = Object.keys(config.http?.services ?? {});
    const routers = Object.keys(config.http?.routers ?? {});
    expect(new Set(services).size).toBe(services.length);
    /* Every router still owns its own key; the children only ever add to them. */
    for (const router of routers) expect(services).toContain(router);
    expect(services).toHaveLength(routers.length + 2);
  });

  it("keeps a single backend on the plain load balancer it has always had", () => {
    /* A weighted service over one child would be indirection that buys nothing,
       and would rewrite a document Traefik hashes for every host on the node. */
    const service = renderTraefikConfig(desired([[HOST, 42_000]])).http?.services[
      `${TRAEFIK_KEY_PREFIX}${HOST}`
    ];

    expect(service).toEqual({ loadBalancer: { servers: [{ url: "http://127.0.0.1:42000" }] } });
  });

  it("renders the same document byte for byte twice", () => {
    const routing = split(HOST, [
      [BUILD, 42_000, 90],
      [OTHER_BUILD, 42_002, 10],
    ]);

    expect(JSON.stringify(renderTraefikConfig(routing))).toBe(
      JSON.stringify(renderTraefikConfig(routing)),
    );
  });

  it("withdraws the child services with the split that named them", async () => {
    await driver.apply(
      split(HOST, [
        [BUILD, 42_000, 90],
        [OTHER_BUILD, 42_002, 10],
      ]),
    );
    await driver.apply(desired([[HOST, 42_000]]));

    /* One service left, and it is the host's own: nothing of the split survives
       a pass that no longer states one. */
    expect(Object.keys(driver.snapshot().http?.services ?? {})).toEqual([
      `${TRAEFIK_KEY_PREFIX}${HOST}`,
    ]);
  });
});

describe("GET /v1/ingress/traefik", () => {
  it("serves what the driver last rendered, to a caller holding no token", async () => {
    const app = appWith(driver);
    await driver.apply(desired([[HOST, 42_000]]));

    const response = await app.request("/v1/ingress/traefik");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(driver.snapshot());
  });

  it("follows the reconcile loop from one pass to the next", async () => {
    const app = appWith(driver);

    await driver.apply(desired([[HOST, 42_000]]));
    const first = (await (await app.request("/v1/ingress/traefik")).json()) as TraefikDynamicConfig;
    await driver.apply({ routes: [] });
    const second = (await (
      await app.request("/v1/ingress/traefik")
    ).json()) as TraefikDynamicConfig;

    expect(Object.keys(first.http?.routers ?? {})).toHaveLength(1);
    expect(second).toEqual({});
  });

  it("answers 404 on a node whose ingress is pushed rather than polled", async () => {
    /*
     * An empty document is a legitimate answer meaning "this node serves
     * nothing", so an ingress polling a node that publishes no configuration at
     * all must be told something else — otherwise a misconfigured endpoint looks
     * exactly like a node with nothing on it.
     */
    const app = appWith(createCaddyDriver({ adminUrl: "http://127.0.0.1:2019" }));

    const response = await app.request("/v1/ingress/traefik");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:not-found" });
  });

  it("answers 404 on a node with no ingress at all", async () => {
    const response = await appWith(undefined).request("/v1/ingress/traefik");

    expect(response.status).toBe(404);
  });
});

function desired(entries: Array<[string, number]>): IngressDesired {
  return {
    routes: entries.map(([host, port]) => ({
      host,
      backends: [{ backend: backend(port, BUILD), weight: 100 }],
    })),
  };
}

/** One host divided between several builds, as a split renders it. */
function split(host: string, legs: Array<[string, number, number]>): IngressDesired {
  return {
    routes: [
      {
        host,
        backends: legs.map(([build, port, weight]) => ({ backend: backend(port, build), weight })),
      },
    ],
  };
}

function backend(
  port: number,
  build: string,
): { project: string; env: string; build: string; port: number } {
  return { project: "shop", env: "production", build, port };
}

/** The agent app as a node with `ingress` configured — or not — would build it. */
function appWith(ingress: IngressDriver | undefined): H3 {
  return createAgentApp({
    config: agentConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: "0.0.0-test",
    ...(ingress === undefined ? {} : { ingress }),
  });
}

function agentConfig(): AgentConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: NODE_ID, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
    },
    ingress: { driver: "traefik" },
  };
}

/** Nothing here runs a process; the route under test never asks it anything. */
function fakeSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
