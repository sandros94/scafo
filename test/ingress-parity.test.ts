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
import {
  API_DENIED_PREFIXES,
  APEX_ENVIRONMENT,
  FULL_WEIGHT,
  renderRoutes,
} from "../src/core/placement/routes.ts";
import type { IngressDesired } from "../src/core/types/ingress.ts";
import type { EnvironmentRecord, SplitEntry } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import { HOST_LABEL_RE, isHost } from "../src/core/utils/host.ts";
import { isSlug } from "../src/core/utils/slug.ts";
import {
  API_DENY_ID_PREFIX,
  API_ID_PREFIX,
  type CaddyMatch,
  type CaddyRoute,
  CATCHALL_ID_PREFIX,
  renderCaddyRoutes,
  ROUTE_ID_PREFIX,
} from "../src/drivers/ingress/caddy.ts";
import {
  API_DENY_PRIORITY,
  API_PRIORITY,
  CATCHALL_PRIORITY,
  NOOP_SERVICE,
  renderTraefikConfig,
  TRAEFIK_API_DENY_PREFIX,
  TRAEFIK_API_PREFIX,
  TRAEFIK_CATCHALL_PREFIX,
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

/** Where the node's own agent answers, for the routing that falls through to it. */
const AGENT_PORT = 7400;

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
  /**
   * WHICH PATHS the entry answers for, in a vocabulary both formats are read
   * into: `"all"`, `"all except <prefixes>"` for the API apex, `"only
   * <prefixes>"` for the denial guarding it.
   *
   * PART OF THE ESSENCE, not an extra. Two ingresses that agreed on the SET of
   * hosts reaching the agent but not on which paths reach it through them would
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

/**
 * The same states, with an agent for the traffic nothing else answers: a node
 * holding a parked environment's hosts open, and the platform domains whose
 * unmatched names fall through to it.
 */
const WAKE_FIXTURES: Array<{ name: string; desired: IngressDesired }> = [
  {
    name: "a node serving nothing and holding its domains open",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [],
      processes: [],
      claims: [],
      wake: { port: AGENT_PORT, parked: [] },
    }),
  },
  {
    name: "one parked environment, on its label and its apex",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [],
      processes: [],
      claims: [],
      wake: { port: AGENT_PORT, parked: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)] },
    }),
  },
  {
    name: "a parked environment with a custom domain, beside one that is serving",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [environment(OTHER_PROJECT, APEX_ENVIRONMENT, BUILD)],
      processes: [process(OTHER_PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [],
      wake: {
        port: AGENT_PORT,
        parked: [environment(PROJECT, "preview", OTHER_BUILD, [CUSTOM_DOMAIN])],
      },
    }),
  },
  {
    name: "a 90/10 split serving beside a parked environment, under two platform domains",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
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
      wake: { port: AGENT_PORT, parked: [environment(OTHER_PROJECT, "preview", THIRD_BUILD)] },
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
      wake: { port: AGENT_PORT, parked: [] },
      api: { port: AGENT_PORT },
    }),
  },
  {
    name: "two platform domains, so two apexes",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD)],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [],
      wake: { port: AGENT_PORT, parked: [] },
      api: { port: AGENT_PORT },
    }),
  },
  {
    name: "an apex beside a split, a claimed domain and a parked environment",
    desired: renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
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
      wake: { port: AGENT_PORT, parked: [environment(OTHER_PROJECT, "preview", THIRD_BUILD)] },
      api: { port: AGENT_PORT },
    }),
  },
  {
    name: "the API without a wake surface at all",
    desired: renderRoutes({
      platformDomains: [DOMAIN],
      environments: [environment(PROJECT, "staging", BUILD)],
      processes: [process(PROJECT, "staging", BUILD, 42_010)],
      claims: [],
      api: { port: AGENT_PORT },
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
      expect(caddy).toEqual(essenceOf(desired));
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

describe("the two drivers agree on what reaches the agent", () => {
  for (const { name, desired } of WAKE_FIXTURES) {
    it(`agrees on ${name}`, () => {
      const caddy = caddyUpstreams(renderCaddyRoutes(desired));
      const traefik = traefikUpstreams(renderTraefikConfig(desired));

      /* One vocabulary for both: a Caddy `*.<domain>` host matcher and the
         single-label `HostRegexp` Traefik is given cover the same set of names,
         so both are reduced to `*.<domain>` and compared like any other host. */
      expect(traefik).toEqual(caddy);
      expect(caddy).toEqual(essenceOf(desired));
    });
  }

  it("names the same wake hosts and the same catch-all domains, at the same agent", () => {
    for (const { name, desired } of WAKE_FIXTURES) {
      const caddy = agentSurface(caddyUpstreams(renderCaddyRoutes(desired)));
      const traefik = agentSurface(traefikUpstreams(renderTraefikConfig(desired)));

      /* The port is DERIVED from each document rather than assumed, so a driver
         that dialled the wrong agent would fail here rather than agree. */
      expect(traefik, name).toEqual(caddy);
      expect(caddy, name).toEqual({
        agent: [`127.0.0.1:${String(AGENT_PORT)}`],
        hosts: [...(desired.wake?.hosts ?? [])].sort(),
        domains: [...(desired.wake?.domains ?? [])].sort(),
      });
    }
  });

  it("consults its catch-alls last, in whatever way its own format ranks", () => {
    /*
     * PRECEDENCE IS THE WHOLE CONTRACT, and the two formats keep it in opposite
     * ways: Caddy matches in array order, so the catch-alls are rendered last;
     * Traefik scores rules and would rank a domain regexp ABOVE a host under it,
     * so the rank is stated outright. Getting it wrong does not misroute one
     * host — it sends a whole platform domain's live traffic to the agent.
     */
    for (const { name, desired } of WAKE_FIXTURES) {
      const caddy = renderCaddyRoutes(desired);
      const first = caddy.findIndex((route) => route["@id"].startsWith(CATCHALL_ID_PREFIX));

      expect(first, name).toBeGreaterThanOrEqual(0);
      expect(
        caddy.slice(first).every((route) => route["@id"].startsWith(CATCHALL_ID_PREFIX)),
        name,
      ).toBe(true);

      for (const [key, router] of Object.entries(
        renderTraefikConfig(desired).http?.routers ?? {},
      )) {
        expect(router.priority, `${name}: ${key}`).toBe(
          key.startsWith(TRAEFIK_CATCHALL_PREFIX) ? CATCHALL_PRIORITY : undefined,
        );
      }
    }
  });
});

describe("the two drivers agree on the fleet's API at a platform apex", () => {
  for (const { name, desired } of API_FIXTURES) {
    it(`agrees on ${name}`, () => {
      const caddy = caddyUpstreams(renderCaddyRoutes(desired));
      const traefik = traefikUpstreams(renderTraefikConfig(desired));

      /* Paths and all: the reduction carries what each apex entry answers for,
         so two drivers agreeing on the hosts and not on the prefixes cannot
         pass here. */
      expect(traefik).toEqual(caddy);
      expect(caddy).toEqual(essenceOf(desired));
    });
  }

  it("routes the BARE apex, which no catch-all covers, to the same agent", () => {
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
          ).toEqual([`127.0.0.1:${String(AGENT_PORT)}`]);
          /* And it is an entry of its own rather than the catch-all widening:
             `*.<domain>` is still there, matching one label and never the bare
             name. */
          expect(
            driver.some((leg) => leg.host === `*.${apex}`),
            `${name}: ${apex}`,
          ).toBe(desired.wake !== undefined);
        }
      }
    }
  });

  /*
   * THE ONE NON-NEGOTIABLE RULE OF THIS SURFACE. `/v1/storage` carries the
   * fleet's TLS private keys and `/v1/ingress/traefik` its whole routing map;
   * both are unauthenticated-or-shared-token surfaces for a COLOCATED caller,
   * and the apex is a public name. Neither driver may proxy them there — the
   * exclusion is at the INGRESS, so no reading of a header or a route behind it
   * can open it.
   */
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

          /* Everything that DIALS the agent there answers every path but these. */
          expect(
            at.filter((leg) => leg.upstream !== DENIED).map((leg) => leg.paths),
            where,
          ).toEqual([`all except ${denied}`]);
          /* And these are answered by the ingress itself, reaching nothing. */
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
      /* Caddy matches in array order and every route is terminal, so the denial
         is simply written first — and both sit after every host route and
         before the catch-alls that must lose to them. */
      const caddy = renderCaddyRoutes(desired).map((route) => route["@id"]);
      for (const apex of desired.api?.hosts ?? []) {
        const deny = caddy.indexOf(`${API_DENY_ID_PREFIX}${apex}`);
        const api = caddy.indexOf(`${API_ID_PREFIX}${apex}`);

        expect(deny, `${name}: ${apex}`).toBeGreaterThanOrEqual(0);
        expect(deny, `${name}: ${apex}`).toBeLessThan(api);
      }
      const firstTail = caddy.findIndex(
        (id) =>
          id.startsWith(API_ID_PREFIX) ||
          id.startsWith(API_DENY_ID_PREFIX) ||
          id.startsWith(CATCHALL_ID_PREFIX),
      );
      const lastHost = caddy.reduce(
        (at, id, index) =>
          id.startsWith(API_ID_PREFIX) ||
          id.startsWith(API_DENY_ID_PREFIX) ||
          id.startsWith(CATCHALL_ID_PREFIX)
            ? at
            : index,
        -1,
      );
      expect(firstTail, name).toBeGreaterThan(lastHost);
      const firstCatchAll = caddy.findIndex((id) => id.startsWith(CATCHALL_ID_PREFIX));
      if (firstCatchAll !== -1) {
        expect(
          caddy.slice(firstCatchAll).every((id) => id.startsWith(CATCHALL_ID_PREFIX)),
          name,
        ).toBe(true);
      }

      /* Traefik scores rules rather than reading an array, so the rank is
         stated: the denial above the apex, both above the catch-all. */
      for (const [key, router] of Object.entries(
        renderTraefikConfig(desired).http?.routers ?? {},
      )) {
        const expected = key.startsWith(TRAEFIK_API_DENY_PREFIX)
          ? API_DENY_PRIORITY
          : key.startsWith(TRAEFIK_API_PREFIX)
            ? API_PRIORITY
            : key.startsWith(TRAEFIK_CATCHALL_PREFIX)
              ? CATCHALL_PRIORITY
              : undefined;
        expect(router.priority, `${name}: ${key}`).toBe(expected);
      }
      expect(API_DENY_PRIORITY).toBeGreaterThan(API_PRIORITY);
      expect(API_PRIORITY).toBeGreaterThan(CATCHALL_PRIORITY);
    }
  });

  it("sends the denial to a service that reaches nothing, and declares no server for it", () => {
    /* A router naming a service nothing declares is DISABLED by Traefik, and a
       disabled denial is a request falling through to the apex. Traefik's own
       internal no-op is what makes the router valid and the backend absent. */
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
    /* A platform apex claimed as a custom domain, and serving. The application
       an operator deliberately put there keeps the name; the API takes the
       apexes nothing else has. */
    const desired = renderRoutes({
      platformDomains: [DOMAIN, OTHER_DOMAIN],
      environments: [environment(PROJECT, APEX_ENVIRONMENT, BUILD, [DOMAIN])],
      processes: [process(PROJECT, APEX_ENVIRONMENT, BUILD, 42_000)],
      claims: [{ host: DOMAIN, project: PROJECT, environment: APEX_ENVIRONMENT }],
      wake: { port: AGENT_PORT, parked: [] },
      api: { port: AGENT_PORT },
    });

    expect(desired.api?.hosts).toEqual([OTHER_DOMAIN]);
    for (const driver of [
      caddyUpstreams(renderCaddyRoutes(desired)),
      traefikUpstreams(renderTraefikConfig(desired)),
    ]) {
      expect(driver.filter((leg) => leg.host === DOMAIN)).toEqual([
        { host: DOMAIN, upstream: "127.0.0.1:42000", weight: FULL_WEIGHT, paths: "all" },
      ]);
    }
  });

  it("publishes nothing at any apex when the routing carries no api at all", () => {
    /* `api.public` off: byte-identical to the routing scafo rendered before the
       apex answered anything. */
    for (const { name, desired } of [...FIXTURES, ...WAKE_FIXTURES]) {
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
  for (const { name, desired } of [...FIXTURES, ...WAKE_FIXTURES, ...API_FIXTURES]) {
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
 * What a routing MEANS, straight off the input both drivers were handed — what
 * each of them is then held to.
 *
 * A wake host and a catch-all are upstreams like any other: they name a host and
 * reach the node's own agent, and a whole platform domain is written the way
 * Caddy writes it, `*.<domain>`.
 */
function essenceOf(desired: IngressDesired): Upstream[] {
  const wake = desired.wake;
  const agent = wake === undefined ? "" : `127.0.0.1:${String(wake.port)}`;
  const api = desired.api;
  const denied = [...(api?.denied ?? [])].sort().join(",");

  return [
    ...desired.routes.flatMap((route) =>
      route.backends.map((leg) => ({
        host: route.host,
        upstream: `127.0.0.1:${String(leg.backend.port)}`,
        weight: leg.weight,
        paths: "all",
      })),
    ),
    ...(wake?.hosts ?? []).map((host) => ({
      host,
      upstream: agent,
      weight: FULL_WEIGHT,
      paths: "all",
    })),
    ...(wake?.domains ?? []).map((domain) => ({
      host: `*.${domain}`,
      upstream: agent,
      weight: FULL_WEIGHT,
      paths: "all",
    })),
    /* Two entries per apex, and both are load-bearing: what the API answers for,
       and what is answered by the ingress itself and never proxied. */
    ...(api?.hosts ?? []).flatMap((host) => [
      { host, upstream: DENIED, weight: FULL_WEIGHT, paths: `only ${denied}` },
      {
        host,
        upstream: `127.0.0.1:${String(api?.port ?? 0)}`,
        weight: FULL_WEIGHT,
        paths: `all except ${denied}`,
      },
    ]),
  ].sort(byUpstream);
}

/**
 * The wake surface of a rendered routing, read back without being told where the
 * agent is: the catch-alls say which upstream that is, and everything else
 * dialling it is a host being held open.
 */
function agentSurface(upstreams: Upstream[]): {
  agent: string[];
  hosts: string[];
  domains: string[];
} {
  const caught = upstreams.filter((leg) => leg.host.startsWith("*."));
  const agent = [...new Set(caught.map((leg) => leg.upstream))].sort();

  return {
    agent,
    hosts: upstreams
      .filter((leg) => !leg.host.startsWith("*.") && agent.includes(leg.upstream))
      .map((leg) => leg.host)
      .sort(),
    domains: caught.map((leg) => leg.host.slice("*.".length)).sort(),
  };
}

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
      route.match.flatMap((match) => {
        const paths = caddyPaths(match);
        return match.host.flatMap((host) =>
          route.handle.flatMap((handle) => {
            /* A static answer dials nothing, which is the whole of what it
               promises: it is read as the denial it is rather than skipped. */
            if (handle.handler === "static_response") {
              return [{ host, upstream: DENIED, weight: FULL_WEIGHT, paths }];
            }

            const weights = handle.load_balancing?.selection_policy.weights;
            if (weights !== undefined && weights.length !== handle.upstreams.length) {
              throw new Error(`"${host}" has ${String(weights.length)} weights for its upstreams`);
            }
            return handle.upstreams.map((upstream, at) => ({
              host,
              upstream: upstream.dial,
              weight: weights?.[at] ?? FULL_WEIGHT,
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
      const { host, paths } = ruleOf(router.rule);

      /* Traefik's own service for a router that reaches no backend. Read as the
         denial it is rather than resolved: nothing in this document declares it,
         and nothing is supposed to. */
      if (router.service === NOOP_SERVICE) {
        return [{ host, upstream: DENIED, weight: FULL_WEIGHT, paths }];
      }

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
          paths,
        }));
      });
    })
    .sort(byUpstream);
}

/**
 * What a Traefik rule matches, said in the vocabulary both formats share: the
 * name, and which paths reach that router through it.
 *
 * A `Host` rule is the name itself. The single-label `HostRegexp` a catch-all
 * carries covers exactly the set Caddy's `*.<domain>` matcher does, and is read
 * back as that — reading it any other way would be comparing the two drivers'
 * SYNTAX rather than what either of them routes. What follows the host is the
 * path half: `Path`/`PathPrefix` pairs, negated on the API apex and asserted on
 * the denial guarding it, collapsed to the prefixes they name.
 */
function ruleOf(rule: string): { host: string; paths: string } {
  const exact = /^Host\(`(?<host>[^`]+)`\)(?<rest>.*)$/.exec(rule)?.groups;
  if (exact !== undefined) return { host: exact.host, paths: rulePaths(exact.rest) };

  const domain = /^HostRegexp\(`\^\[\^\.\]\+\\\.(?<domain>.+)\$`\)$/.exec(rule)?.groups?.domain;
  if (domain === undefined) throw new Error(`rule "${rule}" is neither a host nor a catch-all`);

  return { host: `*.${domain.replaceAll("\\.", ".")}`, paths: "all" };
}

/** The path half of a rule, read down to the prefixes it names. */
function rulePaths(rest: string): string {
  if (rest.trim() === "") return "all";

  const named = [...rest.matchAll(/Path(?:Prefix)?\(`([^`]+)`\)/g)].map((match) => match[1]);
  if (named.length === 0) throw new Error(`rule tail "${rest}" names no path at all`);

  /* Negation is what tells the two apart, and there is no rule here that mixes
     them: the apex negates every prefix, the denial asserts every prefix. */
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
