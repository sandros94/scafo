/*
 * The fleet's routing document and the Traefik rendering of it must say the same
 * thing.
 *
 * BOTH INGRESSES NOW READ THE SAME DOCUMENT. Caddy's `scafo` upstreams module
 * consumes `FleetRouting` verbatim — it is the wire format, so it cannot disagree
 * with itself — while Traefik reads a translation of it. That translation is the
 * only place a disagreement can still enter, so this is what holds it to the
 * document: same hosts, same upstreams IN THE SAME ORDER, same API hosts, and the
 * same denials on them.
 */

import { describe, expect, it } from "vitest";
import { preferNode, renderFleetRouting } from "../src/core/placement/fleet-routes.ts";
import { API_DENIED_PREFIXES } from "../src/core/placement/routes.ts";
import type { FleetRouting } from "../src/core/types/ingress.ts";
import type { ApplicationRecord, NodeRecord, NodeServing } from "../src/core/types/registry.ts";
import { HOST_LABEL_RE, isHost } from "../src/core/utils/host.ts";
import { isSlug } from "../src/core/utils/slug.ts";
import {
  API_DENY_PRIORITY,
  API_PRIORITY,
  NOOP_SERVICE,
  renderTraefikConfig,
  RETRY_MIDDLEWARE,
  TRAEFIK_API_DENY_PREFIX,
  TRAEFIK_API_PREFIX,
  TRAEFIK_KEY_PREFIX,
  type TraefikDynamicConfig,
  type TraefikService,
} from "../src/drivers/ingress/traefik.ts";

const DOMAIN = "apps.test";
const OTHER_DOMAIN = "apps.example";
const APP = "shop";
const OTHER_APP = "blog";
const PREVIEW_APP = "shop-preview";
const CUSTOM_DOMAIN = "shop.example.com";

const NOW = new Date("2026-01-01T00:01:00.000Z");
const FRESH = "2026-01-01T00:00:50.000Z";

/** The node a colocated ingress asks to be put first. */
const HERE = "node-a";
const THERE = "node-b";

/** What a denial names in the shared vocabulary; neither ingress dials one. */
const DENIED = "deny";

/**
 * One host, everything that answers on it IN PRIORITY ORDER, and which paths
 * reach them through it.
 *
 * `paths` is part of the essence, not an extra. Two ingresses agreeing on the
 * set of hosts reaching the daemon but not on which paths reach it through them
 * would be one installation publishing `/v1/storage` — the surface that carries
 * the fleet's TLS private keys — on the internet through one of them and not the
 * other, which is exactly the disagreement no set comparison can see.
 */
interface Leg {
  host: string;
  /** `host:port`, in the order the document put them. */
  upstreams: string[];
  /** `"all"`, `"all except <prefixes>"` on an API apex, `"only <prefixes>"` on its denial. */
  paths: string;
}

/** The states a fleet passes through, from serving nothing to serving two nodes. */
const FIXTURES: Array<{ name: string; routing: FleetRouting }> = [
  {
    name: "a fleet serving nothing at all",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN],
      applications: [],
      nodes: [],
      now: NOW,
    }),
  },
  {
    name: "one application, on one node",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN],
      applications: [application(APP)],
      nodes: [node(HERE, "10.83.0.1", { [APP]: { port: 42_010 } })],
      now: NOW,
    }),
  },
  {
    name: "a custom domain claimed for an application, answered by two nodes",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN],
      applications: [application(APP, [CUSTOM_DOMAIN])],
      nodes: [
        node(HERE, "10.83.0.1", { [APP]: { port: 42_000 } }),
        node(THERE, "10.83.0.2", { [APP]: { port: 42_001 } }),
      ],
      now: NOW,
    }),
  },
  {
    name: "three applications under two platform domains",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      applications: [
        application(APP, [CUSTOM_DOMAIN]),
        application(PREVIEW_APP),
        application(OTHER_APP),
      ],
      nodes: [
        node(HERE, "10.83.0.1", {
          [APP]: { port: 42_000 },
          [PREVIEW_APP]: { port: 42_004 },
          [OTHER_APP]: { port: 42_006 },
        }),
        node(THERE, "10.83.0.2", { [APP]: { port: 42_001 } }),
      ],
      now: NOW,
    }),
  },
];

/** The fixture whose every host is answered by both nodes. */
const BOTH_NODES = FIXTURES[2];

/**
 * The same states with the fleet's API published at the platform apexes, which
 * is what a node renders by default.
 */
const API_FIXTURES: Array<{ name: string; routing: FleetRouting }> = [
  {
    name: "a fleet serving nothing, answering the API at its one apex",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN],
      applications: [],
      nodes: [node(HERE, "10.83.0.1")],
      now: NOW,
      api: true,
    }),
  },
  {
    name: "two platform domains, so two apexes, answered by two nodes",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      applications: [application(APP)],
      nodes: [
        node(HERE, "10.83.0.1", { [APP]: { port: 42_000 } }),
        node(THERE, "10.83.0.2", { [APP]: { port: 42_001 } }),
      ],
      now: NOW,
      api: true,
    }),
  },
  {
    name: "an apex beside a claimed domain",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      applications: [application(APP, [CUSTOM_DOMAIN])],
      nodes: [node(HERE, "10.83.0.1", { [APP]: { port: 42_000 } })],
      now: NOW,
      api: true,
    }),
  },
  {
    name: "the API beside an application host",
    routing: renderFleetRouting({
      platformDomains: [DOMAIN],
      applications: [application(PREVIEW_APP)],
      nodes: [node(HERE, "10.83.0.1", { [PREVIEW_APP]: { port: 42_010 } })],
      now: NOW,
      api: true,
    }),
  },
];

describe("the Traefik rendering says what the fleet document says", () => {
  for (const { name, routing } of [...FIXTURES, ...API_FIXTURES]) {
    it(`agrees on ${name}`, () => {
      expect(traefikLegs(renderTraefikConfig(routing))).toEqual(legsOf(routing));
    });
  }

  it("agrees that an empty routing means an empty routing", () => {
    const empty: FleetRouting = { v: 1, routes: [] };
    expect(legsOf(empty)).toEqual([]);
    expect(renderTraefikConfig(empty)).toEqual({});
  });

  it("keeps the document's order when a colocated ingress asks for one node first", () => {
    /* What the node API does before handing the document over, and what the
       format is told at the same time: the order is a PRIORITY, so a failover
       must flatten back to exactly the order the document states. */
    for (const { name, routing } of [...FIXTURES, ...API_FIXTURES]) {
      for (const prefer of [HERE, THERE]) {
        const preferred = preferNode(routing, prefer);
        const rendered = renderTraefikConfig(preferred, { prefer });

        expect(traefikLegs(rendered), `${name}: prefer ${prefer}`).toEqual(legsOf(preferred));
      }
    }
  });

  it("puts the preferred node's upstream first wherever it answers", () => {
    const { routing } = BOTH_NODES;
    const preferred = preferNode(routing, THERE);

    expect(legsOf(preferred).map((leg) => leg.upstreams[0])).toEqual(
      legsOf(preferred).map(() => "10.83.0.2:42001"),
    );
    expect(traefikLegs(renderTraefikConfig(preferred, { prefer: THERE }))).toEqual(
      legsOf(preferred),
    );
  });
});

describe("the fleet's API at a platform apex", () => {
  it("routes the bare apex to every node's own daemon, in both", () => {
    for (const { name, routing } of API_FIXTURES) {
      const apexes = routing.api?.hosts ?? [];
      expect(apexes, name).toEqual([...apexes].sort());
      expect(apexes.length, name).toBeGreaterThan(0);

      const daemons = (routing.api?.upstreams ?? []).map((upstream) => upstream.address);
      for (const legs of [legsOf(routing), traefikLegs(renderTraefikConfig(routing))]) {
        for (const apex of apexes) {
          const served = legs.filter((leg) => leg.host === apex && !leg.upstreams.includes(DENIED));
          expect(
            served.map((leg) => leg.upstreams),
            `${name}: ${apex}`,
          ).toEqual([daemons]);
        }
      }
    }
  });

  it("NEVER proxies the excluded prefixes through an apex, in either", () => {
    /* One prefix covers the generic routing and every native format under it:
       any of them says where every process in the fleet listens. */
    expect(API_DENIED_PREFIXES).toEqual(["/v1/storage", "/v1/ingress/routes"]);
    const denied = [...API_DENIED_PREFIXES].sort().join(",");

    for (const { name, routing } of API_FIXTURES) {
      for (const [format, legs] of [
        ["document", legsOf(routing)],
        ["traefik", traefikLegs(renderTraefikConfig(routing))],
      ] as const) {
        for (const apex of routing.api?.hosts ?? []) {
          const at = legs.filter((leg) => leg.host === apex);
          const where = `${name}: ${format} at ${apex}`;

          expect(
            at.filter((leg) => !leg.upstreams.includes(DENIED)).map((leg) => leg.paths),
            where,
          ).toEqual([`all except ${denied}`]);
          expect(
            at.filter((leg) => leg.upstreams.includes(DENIED)).map((leg) => leg.paths),
            where,
          ).toEqual([`only ${denied}`]);
        }
      }
    }
  });

  it("puts the denial ahead of the apex, in the way Traefik ranks", () => {
    for (const { name, routing } of API_FIXTURES) {
      for (const [key, router] of Object.entries(
        renderTraefikConfig(routing).http?.routers ?? {},
      )) {
        const expected = key.startsWith(TRAEFIK_API_DENY_PREFIX)
          ? API_DENY_PRIORITY
          : key.startsWith(TRAEFIK_API_PREFIX)
            ? API_PRIORITY
            : undefined;
        expect(router.priority, `${name}: ${key}`).toBe(expected);
      }
      expect(API_DENY_PRIORITY).toBeGreaterThan(API_PRIORITY);
    }
  });

  it("sends the denial to a service that reaches nothing, and declares no server for it", () => {
    for (const { name, routing } of API_FIXTURES) {
      const config = renderTraefikConfig(routing);

      for (const apex of routing.api?.hosts ?? []) {
        const router = config.http?.routers[`${TRAEFIK_API_DENY_PREFIX}${apex}`];

        expect(router?.service, `${name}: ${apex}`).toBe(NOOP_SERVICE);
        expect(config.http?.services[NOOP_SERVICE], `${name}: ${apex}`).toBeUndefined();
        expect(config.http?.services[`${TRAEFIK_API_DENY_PREFIX}${apex}`], name).toBeUndefined();
      }
    }
  });

  it("declares every middleware its routers name, and names none on the denial", () => {
    for (const { name, routing } of [...FIXTURES, ...API_FIXTURES]) {
      const http = renderTraefikConfig(routing).http;
      /* An empty document declares no maps at all, so there is nothing to check. */
      if (http === undefined) continue;

      for (const [key, router] of Object.entries(http.routers)) {
        /* The denial dials nothing, so there is no next upstream to retry. */
        const wanted = router.service === NOOP_SERVICE ? undefined : [RETRY_MIDDLEWARE];
        expect(router.middlewares, `${name}: ${key}`).toEqual(wanted);

        /* Unqualified like the service names, so every one must be in this document. */
        for (const named of router.middlewares ?? []) {
          expect(http.middlewares[named], `${name}: ${key}`).toBeDefined();
        }
      }
    }
  });

  it("leaves an apex alone when something else already answers on it", () => {
    const routing = renderFleetRouting({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      applications: [application(APP, [DOMAIN])],
      nodes: [node(HERE, "10.83.0.1", { [APP]: { port: 42_000 } })],
      now: NOW,
      api: true,
    });

    expect(routing.api?.hosts).toEqual([OTHER_DOMAIN]);
    for (const legs of [legsOf(routing), traefikLegs(renderTraefikConfig(routing))]) {
      expect(legs.filter((leg) => leg.host === DOMAIN)).toEqual([
        { host: DOMAIN, upstreams: ["10.83.0.1:42000"], paths: "all" },
      ]);
    }
  });

  it("publishes nothing at any apex when the routing carries no api at all", () => {
    for (const { name, routing } of FIXTURES) {
      expect(routing.api, name).toBeUndefined();

      expect(
        Object.keys(renderTraefikConfig(routing).http?.routers ?? {}).some(
          (key) => key.startsWith(TRAEFIK_API_PREFIX) || key.startsWith(TRAEFIK_API_DENY_PREFIX),
        ),
        name,
      ).toBe(false);
    }
  });
});

describe("the render is deterministic", () => {
  for (const { name, routing } of [...FIXTURES, ...API_FIXTURES]) {
    it(`renders ${name} identically twice`, () => {
      expect(renderTraefikConfig(routing)).toEqual(renderTraefikConfig(routing));
      expect(JSON.stringify(renderTraefikConfig(routing))).toBe(
        JSON.stringify(renderTraefikConfig(routing)),
      );
    });
  }
});

describe("the Traefik namespace cannot collide with a host", () => {
  it("refuses the separators the prefixes are built from", () => {
    for (const separator of ["_", "/", "@"]) {
      expect(isHost(`shop${separator}apps.test`), separator).toBe(false);
      expect(isSlug(`shop${separator}preview`), separator).toBe(false);
      expect(HOST_LABEL_RE.test(`shop${separator}x`), separator).toBe(false);
    }
  });

  it("splits every rendered key back into the prefix and the host it names", () => {
    const { routing } = FIXTURES[FIXTURES.length - 1];
    const traefik = renderTraefikConfig(routing);

    for (const key of Object.keys(traefik.http?.routers ?? {})) {
      const host = key.slice(TRAEFIK_KEY_PREFIX.length);
      expect(key.startsWith(TRAEFIK_KEY_PREFIX), key).toBe(true);
      expect(key.split("_")).toHaveLength(2);
      expect(isHost(host), host).toBe(true);
    }
  });

  it("gives each host exactly one router", () => {
    const { routing } = FIXTURES[FIXTURES.length - 1];
    const keys = Object.keys(renderTraefikConfig(routing).http?.routers ?? {});

    expect(new Set(keys).size).toBe(routing.routes.length);
    expect([...keys].sort()).toEqual(
      routing.routes.map((route) => `${TRAEFIK_KEY_PREFIX}${route.host}`).sort(),
    );
  });
});

/**
 * What the fleet document MEANS, read straight off the wire format Caddy's
 * module consumes — what the Traefik rendering is then held to.
 */
function legsOf(routing: FleetRouting): Leg[] {
  const api = routing.api;
  const denied = [...(api?.denied ?? [])].sort().join(",");

  return [
    ...routing.routes.map((route) => ({
      host: route.host,
      upstreams: route.upstreams.map((upstream) => upstream.address),
      paths: "all",
    })),
    ...(api?.hosts ?? []).flatMap((host) => [
      { host, upstreams: [DENIED], paths: `only ${denied}` },
      {
        host,
        upstreams: (api?.upstreams ?? []).map((upstream) => upstream.address),
        paths: `all except ${denied}`,
      },
    ]),
  ].sort(byHost);
}

/**
 * The same, read out of a Traefik document: the host comes out of the router's
 * rule, and the ordered upstreams out of the service the rule names.
 */
function traefikLegs(config: TraefikDynamicConfig): Leg[] {
  const services = config.http?.services ?? {};

  /* A failover is what a preferred node renders as, and it is ordered: the
     preferred service first, its fallback after — which is the priority the
     document stated, flattened back to one list. */
  const flatten = (name: string): string[] => {
    const service: TraefikService | undefined = services[name];
    if (service === undefined) throw new Error(`nothing declares service "${name}"`);
    if ("failover" in service) {
      return [...flatten(service.failover.service), ...flatten(service.failover.fallback)];
    }
    return service.loadBalancer.servers.map((server) => new URL(server.url).host);
  };

  return Object.values(config.http?.routers ?? {})
    .map((router) => {
      const { host, paths } = ruleOf(router.rule);
      const upstreams = router.service === NOOP_SERVICE ? [DENIED] : flatten(router.service);
      return { host, upstreams, paths };
    })
    .sort(byHost);
}

/**
 * What a Traefik rule matches, said in the vocabulary both formats share: the
 * name, and which paths reach that router through it.
 *
 * A `Host` rule is the name itself. What follows the host is the path half:
 * `Path`/`PathPrefix` pairs, negated on the API apex and asserted on the denial
 * guarding it, collapsed to the prefixes they name.
 */
function ruleOf(rule: string): { host: string; paths: string } {
  const exact = /^Host\(`(?<host>[^`]+)`\)(?<rest>.*)$/.exec(rule)?.groups;
  if (exact === undefined) throw new Error(`rule "${rule}" is not a host`);
  return { host: exact.host, paths: rulePaths(exact.rest) };
}

/** The path half of a rule, read down to the prefixes it names. */
function rulePaths(rest: string): string {
  if (rest.trim() === "") return "all";

  const named = [...rest.matchAll(/Path(?:Prefix)?\(`([^`]+)`\)/g)].map((match) => match[1]);
  if (named.length === 0) throw new Error(`rule tail "${rest}" names no path at all`);

  /* Traefik has no prefix-at-a-boundary matcher, so a prefix is written as the
     path itself plus `<path>/`; the two collapse back to the one prefix. */
  const prefixes = named.map((pattern) => pattern.replace(/\/$/, ""));
  return `${rest.includes("!") ? "all except" : "only"} ${[...new Set(prefixes)].sort().join(",")}`;
}

function byHost(a: Leg, b: Leg): number {
  if (a.host === b.host) return a.paths < b.paths ? -1 : a.paths > b.paths ? 1 : 0;
  return a.host < b.host ? -1 : 1;
}

function application(name: string, domains: string[] = []): ApplicationRecord {
  return {
    v: 1,
    name,
    createdAt: "2026-01-01T00:00:00.000Z",
    deployment: { revision: 1, deployedAt: "2026-01-01T00:00:00.000Z" },
    domains,
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
