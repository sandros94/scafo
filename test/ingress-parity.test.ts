/* Caddy and Traefik must encode the same routes and API denials. */

import { describe, expect, it } from "vitest";
import {
  API_DENIED_PREFIXES,
  APEX_ENVIRONMENT,
  renderRoutes,
} from "../src/core/placement/routes.ts";
import type { IngressDesired } from "../src/core/types/ingress.ts";
import type { EnvironmentRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { HOST_LABEL_RE, isHost } from "../src/core/utils/host.ts";
import { isSlug } from "../src/core/utils/slug.ts";
import {
  API_DENY_ID_PREFIX,
  API_ID_PREFIX,
  type CaddyMatch,
  type CaddyRoute,
  renderCaddyRoutes,
  ROUTE_ID_PREFIX,
} from "../src/drivers/ingress/caddy.ts";
import {
  API_DENY_PRIORITY,
  API_PRIORITY,
  NOOP_SERVICE,
  renderTraefikConfig,
  TRAEFIK_API_DENY_PREFIX,
  TRAEFIK_API_PREFIX,
  TRAEFIK_KEY_PREFIX,
  type TraefikDynamicConfig,
  type TraefikService,
} from "../src/drivers/ingress/traefik.ts";

const DOMAIN = "apps.test";
const OTHER_DOMAIN = "apps.example";
const PROJECT = "shop";
const OTHER_PROJECT = "blog";
const BUILD = "aaaa1111";
const OTHER_BUILD = "bbbb2222";
const CUSTOM_DOMAIN = "shop.example.com";

/** Where the node's own daemon answers, for the routing that falls through to it. */
const NODE_PORT = 7400;

/**
 * One host and the process it reaches: all a routing means, in either format.
 */
interface Upstream {
  host: string;
  upstream: string;
  /**
   * which paths the entry answers for, in a vocabulary both formats are read
   * into: `"all"`, `"all except <prefixes>"` for the API apex, `"only
   * <prefixes>"` for the denial guarding it.
   *
   * part OF the ESSENCE, not an extra. Two ingresses that agreed on the set of
   * hosts reaching the daemon but not on which paths reach it through them would
   * be one installation publishing `/v1/storage` — the surface that carries the
   * fleet's TLS private keys — on the internet through one of them and not the
   * other, which is exactly the disagreement no set comparison can see.
   */
  paths: string;
}

/** The upstream a denial names in the shared vocabulary; neither driver dials one. */
const DENIED = "deny";

/** The states a node passes through, from serving nothing to serving a fleet. */
const FIXTURES: Array<{ name: string; desired: IngressDesired }> = [
  { name: "a node serving nothing at all", desired: { routes: [] } },
  {
    name: "one environment, on its own label",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [environment(PROJECT, "staging", BUILD)],
      processes: [process(PROJECT, "staging", BUILD, 42_010)],
      claims: [],
    }),
  },
  {
    name: "production, which is also the apex",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [],
    }),
  },
  {
    name: "a custom domain claimed for an environment",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [CUSTOM_DOMAIN])],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [{ host: CUSTOM_DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
    }),
  },
  {
    name: "two projects under two platform domains",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [
        environment(PROJECT, APEX_ENVIRONMENT, BUILD, [CUSTOM_DOMAIN]),
        environment(PROJECT, "preview", OTHER_BUILD),
        environment(OTHER_PROJECT, APEX_ENVIRONMENT, BUILD),
      ],
      processes: [
        process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000),
        process(PROJECT, "preview", OTHER_BUILD, 42_004),
        process(OTHER_PROJECT, APEX_ENVIRONMENT, BUILD, 42_006),
      ],
      claims: [{ host: CUSTOM_DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
    }),
  },
];

/**
 * The same states again, with the fleet's API published at the platform
 * domains' own apexes — which is what a node renders by default.
 */
const API_FIXTURES: Array<{ name: string; desired: IngressDesired }> = [
  {
    name: "a node serving nothing, answering the API at its one apex",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [],
      processes: [],
      claims: [],
      api: { port: NODE_PORT },
    }),
  },
  {
    name: "two platform domains, so two apexes",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [],
      api: { port: NODE_PORT },
    }),
  },
  {
    name: "an apex beside a claimed domain",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [CUSTOM_DOMAIN])],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [{ host: CUSTOM_DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
      api: { port: NODE_PORT },
    }),
  },
  {
    name: "the API beside an application host",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [environment(PROJECT, "staging", BUILD)],
      processes: [process(PROJECT, "staging", BUILD, 42_010)],
      claims: [],
      api: { port: NODE_PORT },
    }),
  },
];

describe("the two drivers say the same thing about the same routing", () => {
  for (const { name, desired } of FIXTURES) {
    it(`agrees on ${name}`, () => {
      const caddy = caddyUpstreams(renderCaddyRoutes(desired));
      const traefik = traefikUpstreams(renderTraefikConfig(desired));

      expect(traefik).toEqual(caddy);
      expect(caddy).toEqual(essenceOf(desired));
    });
  }

  it("agrees that an empty routing means an empty routing, in both formats", () => {
    expect(renderCaddyRoutes({ routes: [] })).toEqual([]);
    expect(renderTraefikConfig({ routes: [] })).toEqual({});
  });
});

describe("the two drivers agree on the fleet's API at a platform apex", () => {
  for (const { name, desired } of API_FIXTURES) {
    it(`agrees on ${name}`, () => {
      const caddy = caddyUpstreams(renderCaddyRoutes(desired));
      const traefik = traefikUpstreams(renderTraefikConfig(desired));

      expect(traefik).toEqual(caddy);
      expect(caddy).toEqual(essenceOf(desired));
    });
  }

  it("routes the bare apex to the same daemon", () => {
    for (const { name, desired } of API_FIXTURES) {
      const apexes = desired.api?.hosts ?? [];
      expect(apexes, name).toEqual([...apexes].sort());
      expect(apexes.length, name).toBeGreaterThan(0);

      for (const driver of [
        caddyUpstreams(renderCaddyRoutes(desired)),
        traefikUpstreams(renderTraefikConfig(desired)),
      ]) {
        for (const apex of apexes) {
          const served = driver.filter((leg) => leg.host === apex && leg.upstream !== DENIED);

          expect(
            served.map((leg) => leg.upstream),
            `${name}: ${apex}`,
          ).toEqual([`127.0.0.1:${String(NODE_PORT)}`]);
        }
      }
    }
  });

  it("NEVER proxies the excluded prefixes through an apex, in either format", () => {
    expect(API_DENIED_PREFIXES).toEqual(["/v1/storage", "/v1/ingress/traefik"]);
    const denied = [...API_DENIED_PREFIXES].sort().join(",");

    for (const { name, desired } of API_FIXTURES) {
      for (const [format, driver] of [
        ["caddy", caddyUpstreams(renderCaddyRoutes(desired))],
        ["traefik", traefikUpstreams(renderTraefikConfig(desired))],
      ] as const) {
        for (const apex of desired.api?.hosts ?? []) {
          const at = driver.filter((leg) => leg.host === apex);
          const where = `${name}: ${format} at ${apex}`;

          expect(
            at.filter((leg) => leg.upstream !== DENIED).map((leg) => leg.paths),
            where,
          ).toEqual([`all except ${denied}`]);
          expect(
            at.filter((leg) => leg.upstream === DENIED).map((leg) => leg.paths),
            where,
          ).toEqual([`only ${denied}`]);
        }
      }
    }
  });

  it("puts the denial ahead of the apex, in whatever way its own format ranks", () => {
    for (const { name, desired } of API_FIXTURES) {
      const caddy = renderCaddyRoutes(desired).map((route) => route["@id"]);
      for (const apex of desired.api?.hosts ?? []) {
        const deny = caddy.indexOf(`${API_DENY_ID_PREFIX}${apex}`);
        const api = caddy.indexOf(`${API_ID_PREFIX}${apex}`);

        expect(deny, `${name}: ${apex}`).toBeGreaterThanOrEqual(0);
        expect(deny, `${name}: ${apex}`).toBeLessThan(api);
      }
      const firstTail = caddy.findIndex(
        (id) => id.startsWith(API_ID_PREFIX) || id.startsWith(API_DENY_ID_PREFIX),
      );
      const lastHost = caddy.reduce(
        (at, id, index) =>
          id.startsWith(API_ID_PREFIX) || id.startsWith(API_DENY_ID_PREFIX) ? at : index,
        -1,
      );
      expect(firstTail, name).toBeGreaterThan(lastHost);
      for (const [key, router] of Object.entries(
        renderTraefikConfig(desired).http?.routers ?? {},
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
    for (const { name, desired } of API_FIXTURES) {
      const config = renderTraefikConfig(desired);

      for (const apex of desired.api?.hosts ?? []) {
        const router = config.http?.routers[`${TRAEFIK_API_DENY_PREFIX}${apex}`];

        expect(router?.service, `${name}: ${apex}`).toBe(NOOP_SERVICE);
        expect(config.http?.services[NOOP_SERVICE], `${name}: ${apex}`).toBeUndefined();
        expect(config.http?.services[`${TRAEFIK_API_DENY_PREFIX}${apex}`], name).toBeUndefined();
      }
    }
  });

  it("leaves an apex alone when something else already answers on it", () => {
    const desired = renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [DOMAIN])],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [{ host: DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
      api: { port: NODE_PORT },
    });

    expect(desired.api?.hosts).toEqual([OTHER_DOMAIN]);
    for (const driver of [
      caddyUpstreams(renderCaddyRoutes(desired)),
      traefikUpstreams(renderTraefikConfig(desired)),
    ]) {
      expect(driver.filter((leg) => leg.host === DOMAIN)).toEqual([
        { host: DOMAIN, upstream: "127.0.0.1:42000", paths: "all" },
      ]);
    }
  });

  it("publishes nothing at any apex when the routing carries no api at all", () => {
    for (const { name, desired } of FIXTURES) {
      expect(desired.api, name).toBeUndefined();

      const ids = renderCaddyRoutes(desired).map((route) => route["@id"]);
      expect(
        ids.some((id) => id.startsWith(API_ID_PREFIX) || id.startsWith(API_DENY_ID_PREFIX)),
        name,
      ).toBe(false);
      expect(
        Object.keys(renderTraefikConfig(desired).http?.routers ?? {}).some(
          (key) => key.startsWith(TRAEFIK_API_PREFIX) || key.startsWith(TRAEFIK_API_DENY_PREFIX),
        ),
        name,
      ).toBe(false);
    }
  });
});

describe("both renders are deterministic", () => {
  for (const { name, desired } of [...FIXTURES, ...API_FIXTURES]) {
    it(`renders ${name} identically twice`, () => {
      expect(renderCaddyRoutes(desired)).toEqual(renderCaddyRoutes(desired));
      expect(renderTraefikConfig(desired)).toEqual(renderTraefikConfig(desired));
      expect(JSON.stringify(renderTraefikConfig(desired))).toBe(
        JSON.stringify(renderTraefikConfig(desired)),
      );
    });
  }
});

describe("neither namespace can collide with a host", () => {
  it("refuses the separators the prefixes are built from", () => {
    for (const separator of ["_", "/", "@"]) {
      expect(isHost(`shop${separator}apps.test`), separator).toBe(false);
      expect(isSlug(`shop${separator}staging`), separator).toBe(false);
      expect(HOST_LABEL_RE.test(`shop${separator}x`), separator).toBe(false);
    }
  });

  it("splits every rendered key back into the prefix and the host it names", () => {
    const desired = FIXTURES[FIXTURES.length - 1].desired;
    const traefik = renderTraefikConfig(desired);

    for (const key of Object.keys(traefik.http?.routers ?? {})) {
      const host = key.slice(TRAEFIK_KEY_PREFIX.length);
      expect(key.startsWith(TRAEFIK_KEY_PREFIX), key).toBe(true);
      expect(key.split("_")).toHaveLength(2);
      expect(isHost(host), host).toBe(true);
    }
    for (const route of renderCaddyRoutes(desired)) {
      const id = route["@id"];
      expect(id.startsWith(ROUTE_ID_PREFIX), id).toBe(true);
      expect(id.split("_")).toHaveLength(2);
      expect(isHost(id.slice(ROUTE_ID_PREFIX.length)), id).toBe(true);
    }
  });

  it("gives each host exactly one key in each format", () => {
    const desired = FIXTURES[FIXTURES.length - 1].desired;
    const traefik = renderTraefikConfig(desired);

    const traefikKeys = Object.keys(traefik.http?.routers ?? {});
    const caddyIds = renderCaddyRoutes(desired).map((route) => route["@id"]);
    expect(new Set(traefikKeys).size).toBe(desired.routes.length);
    expect(new Set(caddyIds).size).toBe(desired.routes.length);
    expect([...traefikKeys].sort()).toEqual([...caddyIds].sort());
  });
});

/**
 * What a routing MEANS, straight off the input both drivers were handed — what
 * each of them is then held to.
 *
 */
function essenceOf(desired: IngressDesired): Upstream[] {
  const api = desired.api;
  const denied = [...(api?.denied ?? [])].sort().join(",");

  return [
    ...desired.routes.map((route) => ({
      host: route.host,
      upstream: `127.0.0.1:${String(route.backend.port)}`,
      paths: "all",
    })),
    ...(api?.hosts ?? []).flatMap((host) => [
      { host, upstream: DENIED, paths: `only ${denied}` },
      {
        host,
        upstream: `127.0.0.1:${String(api?.port ?? 0)}`,
        paths: `all except ${denied}`,
      },
    ]),
  ].sort(byUpstream);
}

/**
 * What a Caddy route says: the host it matches and the upstream it dials.
 */
function caddyUpstreams(routes: CaddyRoute[]): Upstream[] {
  return routes
    .flatMap((route) =>
      route.match.flatMap((match) => {
        const paths = caddyPaths(match);
        return match.host.flatMap((host) =>
          route.handle.flatMap((handle) => {
            if (handle.handler === "static_response") {
              return [{ host, upstream: DENIED, paths }];
            }

            return handle.upstreams.map((upstream) => ({
              host,
              upstream: upstream.dial,
              paths,
            }));
          }),
        );
      }),
    )
    .sort(byUpstream);
}

/**
 * What a Caddy matcher set says about paths, in the shared vocabulary.
 *
 * Caddy has no prefix matcher, so a prefix is written as the pattern itself plus
 * `<pattern>/*`; the two collapse back to the one prefix they mean, which is
 * what the Traefik rules are read down to as well.
 */
function caddyPaths(match: CaddyMatch): string {
  const denied = match.not?.[0]?.path;
  if (denied !== undefined) return `all except ${prefixesOf(denied)}`;
  if (match.path !== undefined) return `only ${prefixesOf(match.path)}`;
  return "all";
}

/** The distinct path prefixes a list of patterns or rules names, sorted. */
function prefixesOf(patterns: string[]): string {
  const prefixes = patterns.map((pattern) => pattern.replace(/\/\*$/, "").replace(/\/$/, ""));
  return [...new Set(prefixes)].sort().join(",");
}

/**
 * The same, read out of a Traefik document: the host comes out of the router's
 * rule, and the upstream out of the service the rule names.
 */
function traefikUpstreams(config: TraefikDynamicConfig): Upstream[] {
  const services = config.http?.services ?? {};

  const resolve = (name: string): TraefikService => {
    const service = services[name];
    if (service === undefined) throw new Error(`nothing declares service "${name}"`);
    return service;
  };

  return Object.values(config.http?.routers ?? {})
    .flatMap((router) => {
      const { host, paths } = ruleOf(router.rule);

      if (router.service === NOOP_SERVICE) {
        return [{ host, upstream: DENIED, paths }];
      }

      const service = resolve(router.service);
      return service.loadBalancer.servers.map((server) => ({
        host,
        upstream: new URL(server.url).host,
        paths,
      }));
    })
    .sort(byUpstream);
}

/**
 * What a Traefik rule matches, said in the vocabulary both formats share: the
 * name, and which paths reach that router through it.
 *
 * A `Host` rule is the name itself. What follows the host is the path half:
 * `Path`/`PathPrefix` pairs, negated on the API apex and asserted on
 * the denial guarding it, collapsed to the prefixes they name.
 */
function ruleOf(rule: string): { host: string; paths: string } {
  const exact = /^Host\(`(?<host>[^`]+)`\)(?<rest>.*)$/.exec(rule)?.groups;
  if (exact !== undefined) return { host: exact.host, paths: rulePaths(exact.rest) };

  throw new Error(`rule "${rule}" is not a host`);
}

/** The path half of a rule, read down to the prefixes it names. */
function rulePaths(rest: string): string {
  if (rest.trim() === "") return "all";

  const named = [...rest.matchAll(/Path(?:Prefix)?\(`([^`]+)`\)/g)].map((match) => match[1]);
  if (named.length === 0) throw new Error(`rule tail "${rest}" names no path at all`);

  return `${rest.includes("!") ? "all except" : "only"} ${prefixesOf(named)}`;
}

function byUpstream(a: Upstream, b: Upstream): number {
  if (a.host === b.host) return a.upstream < b.upstream ? -1 : 1;
  return a.host < b.host ? -1 : 1;
}

function environment(
  project: string,
  name: string,
  build?: string,
  domains: string[] = [],
): { project: string; env: EnvironmentRecord } {
  return {
    project,
    env: {
      v: 1,
      name,
      prefix: `fleets/${project}/${name}`,
      deployment:
        build === undefined ? null : { revision: 1, deployedAt: "2026-01-01T00:00:00.000Z" },
      domains,
      ephemeral: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

/** Supervised by construction: stopped processes have no ingress parity to prove. */
function process(project: string, env: string, _build: string, port: number): RuntimeProcess {
  return {
    processId: `${project}--${env}`,
    project,
    env,
    configuredVarset: null,
    port,
    internalPort: port + 1,
  };
}
