/*
 * Golden parity between the ingress drivers: whatever a node is serving, Caddy
 * and Traefik are told the SAME THING in their own formats.
 *
 * The two documents have nothing in common to compare directly — one is an array
 * of Caddy routes addressed by `@id`, the other a map of Traefik routers and
 * services — so neither is asserted against the other. Both are reduced to what
 * a routing actually means, a set of `host → upstream` pairs, and it is those
 * that must be identical. A format may change freely; what may not change is
 * which host reaches which process.
 *
 * The fixtures are built by `renderRoutes` rather than written out by hand, so
 * what is compared is routing the product really produces — an environment host
 * with its apex and its build hash, a claimed domain, several projects at once —
 * rather than a shape chosen to make the comparison easy.
 */

import { describe, expect, it } from "vitest";
import { APEX_ENVIRONMENT, FULL_WEIGHT, renderRoutes } from "../src/core/placement/routes.ts";
import type { IngressDesired } from "../src/core/types/ingress.ts";
import type { EnvironmentRecord, SplitEntry } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { HOST_LABEL_RE, isHost } from "../src/core/utils/host.ts";
import { isSlug } from "../src/core/utils/slug.ts";
import {
  type CaddyRoute,
  renderCaddyRoutes,
  ROUTE_ID_PREFIX,
} from "../src/drivers/ingress/caddy.ts";
import {
  renderTraefikConfig,
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
const THIRD_BUILD = "cccc3333";
const CUSTOM_DOMAIN = "shop.example.com";

/**
 * One host, one process it reaches, and the share of its traffic that goes
 * there: all a routing means, in either format.
 *
 * The weight is part of the essence rather than an extra: a split that two
 * ingresses agreed on the SET of but not the shares of would be two different
 * routings dressed as one, and an operator moving between them would see their
 * canary silently change size.
 */
interface Upstream {
  host: string;
  upstream: string;
  weight: number;
}

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
    name: "production, which is also the apex, plus the build it serves",
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
    name: "two projects under two platform domains, mid-flip",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [
        environment(PROJECT, APEX_ENVIRONMENT, BUILD, [CUSTOM_DOMAIN]),
        environment(PROJECT, "preview", OTHER_BUILD),
        environment(OTHER_PROJECT, APEX_ENVIRONMENT, BUILD),
      ],
      processes: [
        process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000),
        /* The build being superseded: still running, so still reachable under
           its own hash, and that host must survive the trip through both. */
        process(PROJECT, APEX_ENVIRONMENT, OTHER_BUILD, 42_002),
        process(PROJECT, "preview", OTHER_BUILD, 42_004),
        process(OTHER_PROJECT, APEX_ENVIRONMENT, BUILD, 42_006),
      ],
      claims: [{ host: CUSTOM_DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
    }),
  },
  {
    name: "a 90/10 canary, with both legs ready",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [
        environment(
          PROJECT,
          APEX_ENVIRONMENT,
          BUILD,
          [CUSTOM_DOMAIN],
          [
            { build: BUILD, weight: 90 },
            { build: OTHER_BUILD, weight: 10 },
          ],
        ),
      ],
      processes: [
        process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000),
        process(PROJECT, APEX_ENVIRONMENT, OTHER_BUILD, 42_002),
      ],
      claims: [{ host: CUSTOM_DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
    }),
  },
  {
    name: "a three-way split beside an unsplit environment",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [
        environment(
          PROJECT,
          APEX_ENVIRONMENT,
          BUILD,
          [],
          [
            { build: BUILD, weight: 50 },
            { build: OTHER_BUILD, weight: 30 },
            { build: THIRD_BUILD, weight: 20 },
          ],
        ),
        environment(OTHER_PROJECT, "staging", BUILD),
      ],
      processes: [
        process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000),
        process(PROJECT, APEX_ENVIRONMENT, OTHER_BUILD, 42_002),
        process(PROJECT, APEX_ENVIRONMENT, THIRD_BUILD, 42_004),
        process(OTHER_PROJECT, "staging", BUILD, 42_006),
      ],
      claims: [],
    }),
  },
];

describe("the two drivers say the same thing about the same routing", () => {
  for (const { name, desired } of FIXTURES) {
    it(`agrees on ${name}`, () => {
      const caddy = caddyUpstreams(renderCaddyRoutes(desired));
      const traefik = traefikUpstreams(renderTraefikConfig(desired));

      expect(traefik).toEqual(caddy);
      /* And what they agree on is the routing itself, rather than both being
         empty because both failed to render anything. */
      expect(caddy).toEqual(
        desired.routes
          .flatMap((route) =>
            route.backends.map((leg) => ({
              host: route.host,
              upstream: `127.0.0.1:${String(leg.backend.port)}`,
              weight: leg.weight,
            })),
          )
          .sort(byUpstream),
      );
    });
  }

  it("agrees on the weights of every split it is given, not merely on the legs", () => {
    /* The set of upstreams and the shares between them are two claims, and only
       the second one is new. Asserted apart from the fixtures above so a driver
       that dropped its weights while keeping its upstreams cannot pass. */
    const weighted = FIXTURES.filter(({ desired }) =>
      desired.routes.some((route) => route.backends.length > 1),
    );
    expect(weighted.length).toBeGreaterThan(0);

    for (const { name, desired } of weighted) {
      const caddy = caddyUpstreams(renderCaddyRoutes(desired));
      const traefik = traefikUpstreams(renderTraefikConfig(desired));

      expect(
        traefik.map((leg) => leg.weight),
        name,
      ).toEqual(caddy.map((leg) => leg.weight));
      /* And the shares of one host still add up to the whole of it. */
      for (const route of desired.routes) {
        const shares = caddy.filter((leg) => leg.host === route.host);
        expect(
          shares.reduce((sum, leg) => sum + leg.weight, 0),
          `${name}: ${route.host}`,
        ).toBe(FULL_WEIGHT);
      }
    }
  });

  it("agrees that an empty routing means an empty routing, in both formats", () => {
    /* Said in opposite ways, which is the whole difference between the two: a
       pushed ingress is told by being given no routes to hold, a polled one by
       being handed a document with nothing in it. */
    expect(renderCaddyRoutes({ routes: [] })).toEqual([]);
    expect(renderTraefikConfig({ routes: [] })).toEqual({});
  });
});

describe("both renders are deterministic", () => {
  for (const { name, desired } of FIXTURES) {
    it(`renders ${name} identically twice`, () => {
      expect(renderCaddyRoutes(desired)).toEqual(renderCaddyRoutes(desired));
      expect(renderTraefikConfig(desired)).toEqual(renderTraefikConfig(desired));
      /* Byte-for-byte for Traefik, where key order is observable: it hashes the
         document it polls, and reorders would read as changes. */
      expect(JSON.stringify(renderTraefikConfig(desired))).toBe(
        JSON.stringify(renderTraefikConfig(desired)),
      );
    });
  }
});

describe("neither namespace can collide with a host", () => {
  /*
   * Both drivers put their own prefix in front of a host to name what they own —
   * `scafo_<host>` as a Caddy `@id`, `scafo_<host>` as a Traefik router and
   * service key. That is only unambiguous while the separator cannot occur in a
   * host, so the property is asserted against the validators every host has
   * already passed rather than against a list of examples.
   */
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
      /* One underscore in the whole key, and it is the driver's own. */
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
    /* The same set of names, arrived at independently. */
    expect([...traefikKeys].sort()).toEqual([...caddyIds].sort());
  });
});

/**
 * What a Caddy route says: the host it matches, the upstreams it dials and the
 * share each takes.
 *
 * A route with no load-balancing policy has one upstream taking all of it, which
 * is how Caddy is told "there is nothing to choose between"; the weights of one
 * that has a policy are POSITIONAL, so they are zipped with the upstreams rather
 * than looked up.
 */
function caddyUpstreams(routes: CaddyRoute[]): Upstream[] {
  return routes
    .flatMap((route) =>
      route.match.flatMap((match) =>
        match.host.flatMap((host) =>
          route.handle.flatMap((handle) => {
            const weights = handle.load_balancing?.selection_policy.weights;
            if (weights !== undefined && weights.length !== handle.upstreams.length) {
              throw new Error(`"${host}" has ${String(weights.length)} weights for its upstreams`);
            }
            return handle.upstreams.map((upstream, at) => ({
              host,
              upstream: upstream.dial,
              weight: weights?.[at] ?? FULL_WEIGHT,
            }));
          }),
        ),
      ),
    )
    .sort(byUpstream);
}

/**
 * The same, read out of a Traefik document: the host comes out of the router's
 * rule, and the upstreams out of the service the rule names — following the
 * child services of a weighted one, so the extraction fails if a leg ever stops
 * resolving inside the document that declares it.
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
      const host = /^Host\(`([^`]+)`\)$/.exec(router.rule)?.[1];
      if (host === undefined) throw new Error(`rule "${router.rule}" is not a plain host match`);

      const service = resolve(router.service);
      const legs =
        "weighted" in service
          ? service.weighted.services.map((child) => ({
              service: resolve(child.name),
              weight: child.weight,
            }))
          : [{ service, weight: FULL_WEIGHT }];

      return legs.flatMap((leg) => {
        if ("weighted" in leg.service) throw new Error(`"${host}" nests a weighted service`);
        return leg.service.loadBalancer.servers.map((server) => ({
          host,
          /* Down to the same authority the Caddy dial is written as; the scheme
             is the format's business, the destination is the routing's. */
          upstream: new URL(server.url).host,
          weight: leg.weight,
        }));
      });
    })
    .sort(byUpstream);
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
  split: SplitEntry[] | null = null,
): { project: string; env: EnvironmentRecord } {
  return {
    project,
    env: {
      v: 1,
      name,
      prefix: `fleets/${project}/${name}`,
      alias: build === undefined ? null : { build, flippedAt: "2026-01-01T00:00:00.000Z" },
      split,
      domains,
      placement: "auto",
      ephemeral: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

/** Ready by construction: an unready process is not routed and has no parity to prove. */
function process(project: string, env: string, build: string, port: number): RuntimeProcess {
  return {
    processId: `${project}--${env}--${build}`,
    project,
    env,
    build,
    port,
    internalPort: port + 1,
    ready: true,
  };
}
