/* The Traefik document a polling ingress reads, and the node API routes it reads it from. */

import type { H3 } from "h3";
import { beforeEach, describe, expect, it } from "vitest";
import { API_DENIED_PREFIXES } from "../src/core/placement/routes.ts";
import type {
  FleetApiRouting,
  FleetRoute,
  FleetRouting,
  FleetUpstream,
} from "../src/core/types/ingress.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { createNodeApp, type DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { PREFER_SELF } from "../src/daemon/_ingress-routes.ts";
import type { Reconciler } from "../src/daemon/reconcile.ts";
import { createStorageService } from "../src/daemon/storage.ts";
import {
  API_DENY_PRIORITY,
  API_HEALTH_PATH,
  API_PRIORITY,
  APP_HEALTH_PATH,
  DEFAULT_ENTRY_POINT,
  HEALTH_INTERVAL,
  HEALTH_TIMEOUT,
  NOOP_SERVICE,
  renderTraefikConfig,
  RETRY_ATTEMPTS,
  RETRY_MIDDLEWARE,
  traefikApiDenyKey,
  traefikApiKey,
  traefikKey,
  type TraefikDynamicConfig,
  type TraefikLoadBalancerService,
} from "../src/drivers/ingress/traefik.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const PEER = "node-b";
const HOST = "shop.apps.test";
const OTHER_HOST = "shop-staging.apps.test";
const APEX = "apps.test";
const TOKEN = "SdUvvcE1nlEQm4iJ4Nx6BdxUjHZ2Uzt4vPXH0cQnJKk";

/** EntryPoints of an operator's own Traefik; the node is told them and nothing else. */
const ENTRY_POINTS: string[] = ["web", "websecure"];

/** Where each node answers: the address the fleet advertises, and the bound port. */
const LOCAL: FleetUpstream = at(NODE_ID, "10.83.0.1:42000");
const REMOTE: FleetUpstream = at(PEER, "10.83.0.2:42000");

/**
 * What the fleet answers on, as this node's last reconcile pass left it: one host
 * both nodes serve, one only the peer serves, and the API at the platform apex.
 * The peer is stated first throughout, so asking for this node reorders something.
 */
const FLEET: FleetRouting = fleet(
  [route(HOST, REMOTE, LOCAL), route(OTHER_HOST, REMOTE)],
  apiAt(REMOTE, LOCAL),
);

/** Both routing routes are behind the same token as `/v1/storage`. */
const POLLED: string[] = ["/v1/ingress/routes", "/v1/ingress/routes/traefik"];

/** What a rejected poller sees, whatever was wrong with the token it presented. */
const AUTH_INVALID_PROBLEM = {
  type: "urn:scafo:auth-invalid",
  title: "Authentication failed",
  status: 401,
};

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("rendering the fleet's routing", () => {
  it("writes one router and one load balancer per host, over every node answering on it", () => {
    const config = renderTraefikConfig(fleet([route(HOST, LOCAL, REMOTE)]));

    expect(config).toEqual({
      http: {
        routers: {
          [traefikKey(HOST)]: {
            rule: "Host(`shop.apps.test`)",
            service: traefikKey(HOST),
            entryPoints: [DEFAULT_ENTRY_POINT],
            middlewares: [RETRY_MIDDLEWARE],
          },
        },
        services: {
          /* Checked at the host the request was for: one address answers several,
             and a process only knows it is up for the one it was asked about. */
          [traefikKey(HOST)]: balancerOf([LOCAL, REMOTE], {
            path: APP_HEALTH_PATH,
            hostname: HOST,
          }),
        },
        middlewares: { [RETRY_MIDDLEWARE]: { retry: { attempts: RETRY_ATTEMPTS } } },
      },
    });
  });

  it("names the same key on both sides, so the router resolves its service", () => {
    const http = renderTraefikConfig(fleet([route(HOST, LOCAL), route(OTHER_HOST, REMOTE)])).http;

    for (const [key, router] of Object.entries(http?.routers ?? {})) {
      /* Unqualified on purpose: Traefik resolves a name without an `@` within
         the provider that supplied it, which is the document being served. */
      expect(router.service, `router "${key}"`).toBe(key);
      expect(http?.services[router.service], `service for "${key}"`).toBeDefined();
    }
  });

  it("orders the keys by host, whatever order the routing states them in", () => {
    const forwards = renderTraefikConfig(fleet([route(HOST, LOCAL), route(OTHER_HOST, REMOTE)]));
    const backwards = renderTraefikConfig(fleet([route(OTHER_HOST, REMOTE), route(HOST, LOCAL)]));

    /*
     * Byte-for-byte rather than deep-equal, because that is what the difference
     * costs here: Traefik hashes the body it polls and does nothing at all when
     * the bytes are unchanged, so a document whose key order wandered would look
     * like a change on every single pass.
     */
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
    expect(Object.keys(forwards.http?.routers ?? {})).toEqual([
      traefikKey(OTHER_HOST),
      traefikKey(HOST),
    ]);
  });

  it("renders the same document twice for the same routing", () => {
    expect(renderTraefikConfig(FLEET)).toEqual(renderTraefikConfig(FLEET));
    expect(JSON.stringify(renderTraefikConfig(FLEET))).toBe(
      JSON.stringify(renderTraefikConfig(FLEET)),
    );
  });

  it("attaches every router it writes to the entryPoints it was asked for", () => {
    const config = renderTraefikConfig(FLEET, { entryPoints: ENTRY_POINTS });

    for (const [key, router] of Object.entries(config.http?.routers ?? {})) {
      expect(router.entryPoints, `router "${key}"`).toEqual(ENTRY_POINTS);
    }
  });

  it("refuses a host that could be read as something other than a host", () => {
    /*
     * A Traefik rule is a small language carried in a string, so a host holding
     * a backtick would not be a malformed name — it would be a different rule.
     * Every host reaching this renderer has passed `assertHost` upstream; this is
     * the check that keeps that true of the one format where it matters.
     */
    expect(() => renderTraefikConfig(fleet([route("evil`) || Host(`admin.test", LOCAL)]))).toThrow(
      expect.objectContaining({ code: "invalid-slug" }),
    );
  });

  it("renders an EMPTY DOCUMENT for a fleet that answers nothing, not empty maps", () => {
    /*
     * Pinned against Traefik 3.7.10, and the reason this is not the obvious
     * thing. `{"http":{"routers":{},"services":{}}}` is refused by Traefik's
     * decoder — "routers cannot be a standalone element" — which makes the poll a
     * failed one, and a failed poll leaves the configuration Traefik last read in
     * place. A fleet that stopped serving an application would go on serving it.
     */
    expect(renderTraefikConfig(fleet([]))).toEqual({});
    expect(JSON.stringify(renderTraefikConfig(fleet([])))).toBe("{}");
  });
});

describe("preferring the node the ingress sits beside", () => {
  it("uses the preferred node while it is healthy, and the others only when it is not", () => {
    const config = renderTraefikConfig(fleet([route(HOST, REMOTE, LOCAL)]), { prefer: NODE_ID });

    /* A failover and not a weighting: nothing here asks for traffic to be split,
       it asks for traffic to stay on this machine while this machine can serve it. */
    const key = traefikKey(HOST);
    expect(config.http?.services).toEqual({
      [key]: { failover: { service: `${key}_local`, fallback: `${key}_peers` } },
      [`${key}_local`]: balancerOf([LOCAL], { path: APP_HEALTH_PATH, hostname: HOST }),
      [`${key}_peers`]: balancerOf([REMOTE], { path: APP_HEALTH_PATH, hostname: HOST }),
    });
    /* The router still names the one key; what is behind it is the failover. */
    expect(config.http?.routers[key]?.service).toBe(key);
  });

  it("declares one balancer where the preferred node is the only one answering", () => {
    const config = renderTraefikConfig(fleet([route(HOST, LOCAL)]), { prefer: NODE_ID });

    /* Failing over from a node to nothing at all is a service that can only be
       down, so a route this node alone serves stays the plain balancer it was. */
    expect(config.http?.services).toEqual({
      [traefikKey(HOST)]: balancerOf([LOCAL], { path: APP_HEALTH_PATH, hostname: HOST }),
    });
  });

  it("changes nothing at all for a node that answers nowhere in the routing", () => {
    const routing = fleet([route(HOST, REMOTE, LOCAL)], apiAt(REMOTE, LOCAL));

    expect(renderTraefikConfig(routing, { prefer: "node-z" })).toEqual(
      renderTraefikConfig(routing),
    );
  });
});

describe("the fleet's API at a platform apex", () => {
  it("answers the denied prefixes itself, from a router that outranks the API's own", () => {
    const config = renderTraefikConfig(fleet([], apiAt(LOCAL, REMOTE)));
    const deny = config.http?.routers[traefikApiDenyKey(APEX)];
    const proxied = config.http?.routers[traefikApiKey(APEX)];

    /* Each prefix twice, because a denial that is not matched at a path SEGMENT
       boundary either misses `/v1/storage/objects` or catches `/v1/storages`. */
    const denied = API_DENIED_PREFIXES.flatMap((prefix) => [
      `Path(\`${prefix}\`)`,
      `PathPrefix(\`${prefix}/\`)`,
    ]);

    expect(deny).toEqual({
      rule: `Host(\`${APEX}\`) && (${denied.join(" || ")})`,
      /* Dials nothing, so there is no service to declare and nothing to retry. */
      service: NOOP_SERVICE,
      entryPoints: [DEFAULT_ENTRY_POINT],
      priority: API_DENY_PRIORITY,
    });
    expect(proxied).toEqual({
      rule: [`Host(\`${APEX}\`)`, ...denied.map((rule) => `!${rule}`)].join(" && "),
      service: traefikApiKey(APEX),
      entryPoints: [DEFAULT_ENTRY_POINT],
      middlewares: [RETRY_MIDDLEWARE],
      priority: API_PRIORITY,
    });
    expect(API_DENY_PRIORITY).toBeGreaterThan(API_PRIORITY);
    expect(config.http?.services[traefikApiDenyKey(APEX)]).toBeUndefined();
  });

  it("checks a daemon where a daemon says it is up, and not per host", () => {
    const config = renderTraefikConfig(fleet([], apiAt(LOCAL, REMOTE)));

    /* No `hostname`: every apex reaches the same daemons, and a daemon answers
       its health path whatever name the request arrived under. */
    expect(config.http?.services[traefikApiKey(APEX)]).toEqual(
      balancerOf([LOCAL, REMOTE], { path: API_HEALTH_PATH }),
    );
  });
});

describe("GET /v1/ingress/routes/traefik", () => {
  it("serves the document rendered from the last reconcile pass, in the node's entryPoints", async () => {
    const app = appWith(FLEET);

    const response = await poll(app, "/v1/ingress/routes/traefik");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      renderTraefikConfig(FLEET, { entryPoints: ENTRY_POINTS }),
    );
  });

  it("puts the node the ingress sits on first when it asks for itself", async () => {
    const app = appWith(FLEET);

    const config = (await (
      await poll(app, `/v1/ingress/routes/traefik?prefer=${PREFER_SELF}`)
    ).json()) as TraefikDynamicConfig;

    /* `prefer` reaches the renderer by name, not only as an order: Traefik's
       balancer ignores server order, so the document has to say failover. */
    expect(config).toEqual(
      renderTraefikConfig(FLEET, { entryPoints: ENTRY_POINTS, prefer: NODE_ID }),
    );
    const key = traefikKey(HOST);
    expect(config.http?.services[key]).toEqual({
      failover: { service: `${key}_local`, fallback: `${key}_peers` },
    });
    const local = config.http?.services[`${key}_local`] as TraefikLoadBalancerService;
    expect(local.loadBalancer.servers).toEqual([{ url: `http://${LOCAL.address}` }]);
  });

  it("answers a format this node does not render as a miss, naming the ones it does", async () => {
    const response = await poll(appWith(FLEET), "/v1/ingress/routes/nope");
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(problem.type).toBe("urn:scafo:not-found");
    expect(problem.detail).toContain(`"traefik"`);
  });
});

describe("GET /v1/ingress/routes", () => {
  it("serves the fleet's routing itself, for an ingress no format is written for", async () => {
    const response = await poll(appWith(FLEET), "/v1/ingress/routes");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(FLEET);
  });

  it("puts the node the ingress names first on every route, and on the API", async () => {
    const app = appWith(FLEET);

    const asked = await polled(app, `/v1/ingress/routes?prefer=${NODE_ID}`);
    const itself = await polled(app, `/v1/ingress/routes?prefer=${PREFER_SELF}`);

    /* `self` is the node being asked, so a colocated ingress never has to know
       the node's id — and a node serving nothing is preferred to no effect. */
    expect(nodeOrder(itself)).toEqual(nodeOrder(asked));
    expect(nodeOrder(asked)).toEqual({
      [HOST]: [NODE_ID, PEER],
      [OTHER_HOST]: [PEER],
      api: [NODE_ID, PEER],
    });
    expect(nodeOrder(await polled(app, `/v1/ingress/routes?prefer=${PEER}`))).toEqual({
      [HOST]: [PEER, NODE_ID],
      [OTHER_HOST]: [PEER],
      api: [PEER, NODE_ID],
    });
  });
});

describe("a node whose first reconcile pass has not finished", () => {
  it.each(POLLED)(
    "refuses %s rather than answering as if the fleet served nothing",
    async (path) => {
      const response = await poll(appWith(undefined), path);

      /* A poller keeps the last document that parsed on anything but a 2xx, so
       this costs one skipped poll. The empty document would cost every route. */
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        type: "urn:scafo:draining",
        detail: expect.stringContaining("no reconcile pass has completed"),
      });
    },
  );

  it.each(POLLED)(
    "refuses %s the same way on a node running no reconciler at all",
    async (path) => {
      const daemon = context(FLEET);
      daemon.reconciler = undefined;
      daemon.storage = createStorageService(daemon, { tokens: [TOKEN] });

      const response = await poll(createNodeApp(daemon), path);

      expect(response.status).toBe(503);
    },
  );

  it.each(POLLED)("serves %s once a pass has run, empty fleet and all", async (path) => {
    /* The distinction the refusal exists for: nothing deployed is an answer, and
       it is given as one the moment a pass has read the registry. */
    const app = appWith(fleet([]));

    const response = await poll(app, path);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      path === "/v1/ingress/routes"
        ? fleet([])
        : renderTraefikConfig(fleet([]), { entryPoints: ENTRY_POINTS }),
    );
  });
});

describe("the token both routing routes are behind", () => {
  it.each(POLLED)(
    "refuses %s to a caller without one, or with one this node does not admit",
    async (path) => {
      const app = appWith(FLEET);

      for (const token of [null, "not-this-node's-token", `${TOKEN}X`]) {
        const response = await poll(app, path, token);

        expect(response.status, `for ${JSON.stringify(token)}`).toBe(401);
        /* The same document either way: nothing here tells a wrong token from a
           missing one, which is all this surface says to a stranger. */
        await expect(response.json(), `for ${JSON.stringify(token)}`).resolves.toEqual(
          AUTH_INVALID_PROBLEM,
        );
      }
    },
  );

  it("serves nothing here at all on a node holding no token", async () => {
    const bare = createNodeApp(context(FLEET));

    /* No route rather than the `401` the same call gets from a node that serves
       the surface: the routing goes out with the same credential the certificates
       do, so a node without one publishes neither. */
    for (const path of POLLED) {
      const response = await poll(bare, path);

      expect(response.status, `for ${path}`).toBe(404);
      expect((await response.json()) as Record<string, unknown>).not.toMatchObject({
        type: "urn:scafo:auth-invalid",
      });
    }
  });
});

/** One host and the nodes answering on it, in the order the routing states them. */
function route(host: string, ...upstreams: FleetUpstream[]): FleetRoute {
  return { host, application: "shop", upstreams };
}

/** Where one node answers, as the fleet advertises it. */
function at(node: string, address: string): FleetUpstream {
  return { node, address };
}

/** The fleet's API at the one platform apex, answered by the nodes named. */
function apiAt(...upstreams: FleetUpstream[]): FleetApiRouting {
  return { hosts: [APEX], upstreams, denied: [...API_DENIED_PREFIXES] };
}

function fleet(routes: FleetRoute[], api?: FleetApiRouting): FleetRouting {
  return { v: 1, routes, ...(api === undefined ? {} : { api }) };
}

/** The load balancer a set of upstreams renders as, checked where the check says. */
function balancerOf(
  upstreams: FleetUpstream[],
  check: { path: string; hostname?: string },
): TraefikLoadBalancerService {
  return {
    loadBalancer: {
      servers: upstreams.map((upstream) => ({ url: `http://${upstream.address}` })),
      healthCheck: {
        path: check.path,
        interval: HEALTH_INTERVAL,
        timeout: HEALTH_TIMEOUT,
        ...(check.hostname === undefined ? {} : { hostname: check.hostname }),
      },
    },
  };
}

/** Which nodes answer each host, keyed by host, with the API under `"api"`. */
function nodeOrder(routing: FleetRouting): Record<string, string[]> {
  const api = routing.api;
  return {
    ...Object.fromEntries(
      routing.routes.map((route) => [route.host, route.upstreams.map((up) => up.node)]),
    ),
    ...(api === undefined ? {} : { api: api.upstreams.map((up) => up.node) }),
  };
}

/** One poll of a routing route, presenting the ingress token unless told otherwise. */
async function poll(app: H3, path: string, token: string | null = TOKEN): Promise<Response> {
  return app.request(path, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

/** The routing one poll answered with, for the tests that compare two of them. */
async function polled(app: H3, path: string): Promise<FleetRouting> {
  const response = await poll(app, path);

  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as FleetRouting;
}

/** The node app as a node serving the routing builds it: the token, and the formats. */
function appWith(routing: FleetRouting | undefined): H3 {
  const daemon = context(routing);
  /* The routing names every node's address and port, so it is behind the token
     the TLS storage surface is behind: one credential for the one thing in front
     of the fleet. */
  daemon.storage = createStorageService(daemon, { tokens: [TOKEN] });
  return createNodeApp(daemon);
}

/** Everything the node app serves the routing from, short of the token. */
function context(routing: FleetRouting | undefined): DaemonContext {
  return {
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    versions: { scafo: "0.0.0-test", celld: "0.5.0" },
    reconciler: fakeReconciler(routing),
    /* Exactly as `sail` registers it: the entryPoints are the one thing about
       the document a node has to be told. */
    ingressFormats: {
      traefik: (asked, { prefer }) =>
        renderTraefikConfig(asked, { entryPoints: ENTRY_POINTS, prefer }),
    },
  };
}

function daemonConfig(): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: NODE_ID, listen: "127.0.0.1:7400" },
    platformDomains: [APEX],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
    ingress: { entryPoints: ENTRY_POINTS },
  };
}

/**
 * Holds the routing of one finished pass; no route under test runs another.
 * `undefined` is a node whose first pass has not finished yet.
 */
function fakeReconciler(routing: FleetRouting | undefined): Reconciler {
  return {
    runOnce: () => Promise.resolve([]),
    kick: () => {},
    reload: (): Promise<void> => Promise.resolve(),
    start: () => {},
    shutdown: () => Promise.resolve(),
    stop: () => {},
    fleetRouting: () => routing,
    status: () => ({
      lastRunAt: null,
      running: false,
      lastActions: [],
      failures: [],
      processes: [],
      placements: [],
    }),
  };
}

/** No route under test starts a process. */
function fakeSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    forget: () => {},
    onExit: () => {},
  };
}
