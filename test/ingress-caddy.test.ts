/*
 * The Caddy ingress driver against a stand-in admin API: which calls it makes to
 * converge, what it refuses to touch, and what it does when Caddy says no.
 *
 * The fake keeps a routes array and answers the same four calls Caddy does, so
 * every assertion is about the driver's own conversation with it.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { IngressDesired, IngressDriver } from "../src/core/types/ingress.ts";
import {
  type CaddyProxyHandler,
  type CaddyRoute,
  CATCHALL_ID_PREFIX,
  catchAllId,
  createCaddyDriver,
  DEFAULT_SERVER_NAME,
  renderCaddyRoutes,
  ROUTE_ID_PREFIX,
  routeId,
} from "../src/drivers/ingress/caddy.ts";
import { rejectsWith } from "./_helpers.ts";

const ADMIN = "http://caddy.test:2019";
const ROUTES_URL = `${ADMIN}/config/apps/http/servers/${DEFAULT_SERVER_NAME}/routes`;
const HOST = "shop.apps.test";
const OTHER_HOST = "shop--staging.apps.test";

/** The platform domains this node serves, and the host of something parked under one. */
const DOMAIN = "apps.test";
const OTHER_DOMAIN = "apps.example";
const PARKED_HOST = "shop--preview.apps.test";

/** Where the node's own daemon answers, and how a route is told to dial it. */
const NODE_PORT = 7400;
const NODE_DIAL = `127.0.0.1:${String(NODE_PORT)}`;

/** One call the driver made, as the fake saw it. */
interface AdminCall {
  method: string;
  url: string;
  body?: unknown;
  /** What the call presented itself as; Caddy refuses one it does not allow. */
  origin: string | null;
}

/** A route the operator wrote; the driver must never so much as read it. */
const OPERATOR_ROUTE = {
  "@id": "ops_dashboard",
  "match": [{ host: ["ops.apps.test"] }],
  "handle": [{ handler: "static_response", body: "hello" }],
};

/** A route with no id at all, which is how most hand-written routes look. */
const UNNAMED_ROUTE = {
  match: [{ host: ["legacy.apps.test"] }],
  handle: [{ handler: "file_server" }],
};

let routes: Array<Record<string, unknown>>;
let calls: AdminCall[];
let status: Map<string, number>;
let driver: IngressDriver;

beforeEach(() => {
  routes = [];
  calls = [];
  status = new Map();
  driver = createCaddyDriver({ adminUrl: ADMIN, fetchFn: admin });
});

describe("converging an empty server", () => {
  it("appends one route per host, and nothing else", async () => {
    await driver.apply(desired([[HOST, 42_000]]));

    expect(methods()).toEqual(["GET", "POST"]);
    expect(routes).toEqual([
      {
        "@id": `${ROUTE_ID_PREFIX}${HOST}`,
        "match": [{ host: [HOST] }],
        "handle": [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:42000" }] }],
        "terminal": true,
      },
    ]);
    /* Appended to the array, not written over it. */
    expect(calls[1]?.url).toBe(ROUTES_URL);
  });

  /*
   * Caddy's admin API applies its cross-origin check to anything that looks
   * like a browser, and every `fetch` does: the runtime attaches
   * `Sec-Fetch-Mode: cors` and a caller cannot unset it. Without an `Origin`
   * Caddy allows, a real admin API answers 403 and the node publishes no
   * routing at all — so the header is load-bearing, not decoration.
   */
  it("presents the admin API's own origin on every call it makes", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    await driver.apply(desired([[HOST, 42_010]]));
    await driver.apply(desired([]));

    expect(methods()).toEqual(["GET", "POST", "GET", "PATCH", "GET", "DELETE"]);
    expect(calls.map((call) => call.origin)).toEqual(
      Array(calls.length).fill("http://caddy.test:2019"),
    );
  });

  it("treats a server with no routes key as having none", async () => {
    status.set(`GET ${ROUTES_URL}`, 404);

    await driver.apply(desired([[HOST, 42_000]]));

    expect(methods()).toEqual(["GET", "POST"]);
  });
});

describe("converging a server that already has routes", () => {
  it("does nothing at all when the routing has not changed", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    calls = [];

    await driver.apply(desired([[HOST, 42_000]]));

    /* Reading is not converging: the second pass must make no mutating call. */
    expect(methods()).toEqual(["GET"]);
  });

  it("patches by id when a host moves to another backend", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    calls = [];

    await driver.apply(desired([[HOST, 42_010]]));

    expect(methods()).toEqual(["GET", "PATCH"]);
    expect(calls[1]?.url).toBe(`${ADMIN}/id/${ROUTE_ID_PREFIX}${HOST}`);
    expect(routes[0]).toMatchObject({
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:42010" }] }],
    });
  });

  it("deletes by id the hosts it no longer serves", async () => {
    await driver.apply(
      desired([
        [HOST, 42_000],
        [OTHER_HOST, 42_002],
      ]),
    );
    calls = [];

    await driver.apply(desired([[HOST, 42_000]]));

    expect(methods()).toEqual(["GET", "DELETE"]);
    expect(calls[1]?.url).toBe(`${ADMIN}/id/${ROUTE_ID_PREFIX}${OTHER_HOST}`);
    expect(routes.map((route) => route["@id"])).toEqual([`${ROUTE_ID_PREFIX}${HOST}`]);
  });

  it("adds before it removes, so a host that moves is never served by nothing", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    calls = [];

    await driver.apply(desired([[OTHER_HOST, 42_002]]));

    expect(methods()).toEqual(["GET", "POST", "DELETE"]);
  });

  it("ignores a route whose id is not one of its own, even for the same host", async () => {
    /* The operator has a route for a host this node also serves. Both stay:
       deciding which one wins is Caddy's business, not this driver's. */
    routes.push({ ...OPERATOR_ROUTE, match: [{ host: [HOST] }] }, UNNAMED_ROUTE);

    await driver.apply(desired([[HOST, 42_000]]));

    expect(methods()).toEqual(["GET", "POST"]);
    expect(routes).toHaveLength(3);
    expect(routes[0]).toMatchObject({ "@id": "ops_dashboard" });
    expect(routes[1]).toEqual(UNNAMED_ROUTE);
  });

  it("leaves the operator's routes alone when it has nothing of its own to serve", async () => {
    routes.push({ ...OPERATOR_ROUTE }, UNNAMED_ROUTE);

    await driver.apply({ routes: [] });

    expect(methods()).toEqual(["GET"]);
    expect(routes).toHaveLength(2);
  });
});

describe("a host's backend", () => {
  it("renders one plain reverse-proxy upstream", () => {
    const [route] = renderCaddyRoutes(desired([[HOST, 42_000]]));

    expect(proxyOf(route).upstreams).toEqual([{ dial: "127.0.0.1:42000" }]);
    expect(Object.keys(route.handle[0])).toEqual(["handler", "upstreams"]);
  });

  it("dials the address the node says its processes bound", () => {
    /* A fleet's processes bind the tunnel address, and loopback answers nothing
       for them — the dial follows the node's word, not an assumption. */
    const [route] = renderCaddyRoutes(desired([[HOST, 42_000]]), "10.83.0.1");

    expect(proxyOf(route).upstreams).toEqual([{ dial: "10.83.0.1:42000" }]);
  });
});

describe("the routes that reach the node's own daemon", () => {
  it("renders a parked host as an ordinary route, under the host's own id", async () => {
    await driver.apply(waking([], { hosts: [PARKED_HOST], domains: [] }));

    /* Same id a process-backed route for that host would carry, so waking is a
       change of upstream rather than a change of route. */
    expect(routes).toEqual([nodeRoute(routeId(PARKED_HOST), PARKED_HOST)]);
  });

  it("renders one catch-all per platform domain, wildcarding exactly ONE label", async () => {
    await driver.apply(waking([], { domains: [DOMAIN, OTHER_DOMAIN] }));

    /* A Caddy host matcher wildcard covers exactly one label, so `*.<domain>` is
       every subdomain of a platform domain and never the domain itself — and
       never a subdomain of a subdomain either. */
    expect(methods()).toEqual(["GET", "POST", "POST"]);
    expect(routes).toEqual([
      nodeRoute(catchAllId(DOMAIN), `*.${DOMAIN}`),
      nodeRoute(catchAllId(OTHER_DOMAIN), `*.${OTHER_DOMAIN}`),
    ]);
    expect(catchAllId(DOMAIN)).toBe(`${CATCHALL_ID_PREFIX}${DOMAIN}`);
  });

  it("renders everything explicit before any catch-all", () => {
    /* The order is part of what is rendered rather than something `apply` sorts
       out: Caddy matches top-down and every route here is terminal. */
    const rendered = renderCaddyRoutes(
      waking([[HOST, 42_000]], { hosts: [PARKED_HOST], domains: [DOMAIN, OTHER_DOMAIN] }),
    );

    expect(rendered.map((route) => route["@id"])).toEqual([
      routeId(HOST),
      routeId(PARKED_HOST),
      catchAllId(DOMAIN),
      catchAllId(OTHER_DOMAIN),
    ]);
  });
});

describe("the catch-alls sit after every route the driver owns", () => {
  /*
   * THE INVARIANT THIS SUITE EXISTS FOR. Caddy matches routes in ARRAY ORDER and
   * each of these is terminal, so a catch-all reached first answers for a host an
   * explicit route was written for — which is not one misrouted name but a whole
   * platform domain's live traffic going to the daemon instead of to the processes
   * serving it. `POST` appends, so it is asserted after every kind of converge.
   */
  const WAKE = { hosts: [PARKED_HOST], domains: [DOMAIN] };

  it("on the first converge", async () => {
    await driver.apply(
      waking(
        [
          [HOST, 42_000],
          [OTHER_HOST, 42_002],
        ],
        {
          hosts: [PARKED_HOST],
          domains: [DOMAIN, OTHER_DOMAIN],
        },
      ),
    );

    expect(ownedIds()).toEqual([
      routeId(HOST),
      routeId(OTHER_HOST),
      routeId(PARKED_HOST),
      catchAllId(DOMAIN),
      catchAllId(OTHER_DOMAIN),
    ]);
  });

  it("when a host is added later, which appends behind them", async () => {
    await driver.apply(waking([[HOST, 42_000]], WAKE));
    calls = [];

    await driver.apply(
      waking(
        [
          [HOST, 42_000],
          [OTHER_HOST, 42_002],
        ],
        WAKE,
      ),
    );

    /* The new route landed behind the catch-all, so they are taken away and put
       back — the one place this driver removes before it adds, and the safe
       direction: what a catch-all answers is a request nothing else routes. */
    expect(methods()).toEqual(["GET", "POST", "DELETE", "POST"]);
    expect(ownedIds()).toEqual([
      routeId(HOST),
      routeId(PARKED_HOST),
      routeId(OTHER_HOST),
      catchAllId(DOMAIN),
    ]);
  });

  it("when a host is removed, without touching them at all", async () => {
    await driver.apply(
      waking(
        [
          [HOST, 42_000],
          [OTHER_HOST, 42_002],
        ],
        WAKE,
      ),
    );
    calls = [];

    await driver.apply(waking([[HOST, 42_000]], WAKE));

    /* A deletion from the middle keeps them last on its own, so the re-append is
       not reached: one call, and the catch-all is never briefly absent. */
    expect(methods()).toEqual(["GET", "DELETE"]);
    expect(calls[1]?.url).toBe(`${ADMIN}/id/${routeId(OTHER_HOST)}`);
    expect(ownedIds()).toEqual([routeId(HOST), routeId(PARKED_HOST), catchAllId(DOMAIN)]);
  });

  it("on a settled pass, which writes nothing whatsoever", async () => {
    const routing = waking([[HOST, 42_000]], {
      hosts: [PARKED_HOST],
      domains: [DOMAIN, OTHER_DOMAIN],
    });
    await driver.apply(routing);
    calls = [];

    await driver.apply(routing);

    /* Reading is not converging: a node whose wake set has not moved re-appends
       none of its catch-alls. */
    expect(methods()).toEqual(["GET"]);
    expect(ownedIds()).toEqual([
      routeId(HOST),
      routeId(PARKED_HOST),
      catchAllId(DOMAIN),
      catchAllId(OTHER_DOMAIN),
    ]);
  });

  it("while the operator's own routes stay exactly where they were", async () => {
    routes.push({ ...OPERATOR_ROUTE }, UNNAMED_ROUTE);

    await driver.apply(waking([[HOST, 42_000]], WAKE));
    /* An append, which forces the catch-alls to be taken away and put back... */
    await driver.apply(
      waking(
        [
          [HOST, 42_000],
          [OTHER_HOST, 42_002],
        ],
        WAKE,
      ),
    );
    /* ...and a withdrawal, which does not. */
    await driver.apply(waking([[HOST, 42_000]], WAKE));

    expect(routes[0]).toEqual(OPERATOR_ROUTE);
    expect(routes[1]).toEqual(UNNAMED_ROUTE);
    expect(catchAllsLast()).toBe(true);
  });
});

describe("a wake host is converged like any other host", () => {
  const DOMAINS = { domains: [DOMAIN] };

  it("patches in place when the environment wakes, and again when it parks", async () => {
    await driver.apply(waking([], { hosts: [PARKED_HOST], ...DOMAINS }));
    calls = [];

    /* The environment came up: the same host now names a process. The `@id` is
       the host's either way, so it arrives as a patch rather than as a
       withdrawal followed by a fresh route. */
    await driver.apply(waking([[PARKED_HOST, 42_004]], DOMAINS));

    expect(methods()).toEqual(["GET", "PATCH"]);
    expect(routes[0]).toMatchObject({
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:42004" }] }],
    });

    calls = [];
    await driver.apply(waking([], { hosts: [PARKED_HOST], ...DOMAINS }));

    expect(methods()).toEqual(["GET", "PATCH"]);
    expect(routes[0]).toMatchObject({
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: NODE_DIAL }] }],
    });
  });

  it("is deleted by id once nothing holds it open", async () => {
    await driver.apply(waking([], { hosts: [PARKED_HOST], ...DOMAINS }));
    calls = [];

    await driver.apply(waking([], DOMAINS));

    expect(methods()).toEqual(["GET", "DELETE"]);
    expect(calls[1]?.url).toBe(`${ADMIN}/id/${routeId(PARKED_HOST)}`);
    expect(ownedIds()).toEqual([catchAllId(DOMAIN)]);
  });

  it("goes away with the catch-alls when the routing stops carrying a wake", async () => {
    await driver.apply(waking([[HOST, 42_000]], { hosts: [PARKED_HOST], ...DOMAINS }));
    calls = [];

    /* A node with no daemon address to fall through to — the routing scafo
       rendered before scale-to-zero existed. Only what a process answers is left. */
    await driver.apply(desired([[HOST, 42_000]]));

    expect(methods()).toEqual(["GET", "DELETE", "DELETE"]);
    expect(ownedIds()).toEqual([routeId(HOST)]);
  });
});

describe("an admin API that will not cooperate", () => {
  it("surfaces a refused read, naming the call", async () => {
    status.set(`GET ${ROUTES_URL}`, 500);

    const error = await rejectsWith(
      () => driver.apply(desired([[HOST, 42_000]])),
      "capability-missing",
    );

    expect(error.status).toBe(502);
    expect(error.detail).toContain(`GET ${ROUTES_URL}`);
  });

  it("surfaces a refused write", async () => {
    status.set(`POST ${ROUTES_URL}`, 400);

    const error = await rejectsWith(
      () => driver.apply(desired([[HOST, 42_000]])),
      "capability-missing",
    );

    expect(error.status).toBe(502);
    expect(error.detail).toContain("POST");
  });

  it("surfaces an admin API that is not there at all", async () => {
    const unreachable = createCaddyDriver({
      adminUrl: ADMIN,
      fetchFn: () => Promise.reject(new Error("connect ECONNREFUSED")),
    });

    const error = await rejectsWith(
      () => unreachable.apply(desired([[HOST, 42_000]])),
      "capability-missing",
    );

    expect(error.status).toBe(502);
    expect(error.detail).toContain("could not be reached");
  });
});

function desired(entries: Array<[string, number]>): IngressDesired {
  return {
    routes: entries.map(([host, port]) => ({
      host,
      backend: backend(port),
    })),
  };
}

/** The same routing, plus the hosts and domains that fall through to the daemon. */
function waking(
  entries: Array<[string, number]>,
  wake: { hosts?: string[]; domains?: string[] },
): IngressDesired {
  return {
    ...desired(entries),
    wake: { port: NODE_PORT, hosts: wake.hosts ?? [], domains: wake.domains ?? [DOMAIN] },
  };
}

/** One route sending everything it matches to the node's own daemon. */
function nodeRoute(id: string, match: string): Record<string, unknown> {
  return {
    "@id": id,
    "match": [{ host: [match] }],
    "handle": [{ handler: "reverse_proxy", upstreams: [{ dial: NODE_DIAL }] }],
    "terminal": true,
  };
}

function backend(port: number): { project: string; env: string; port: number } {
  return { project: "shop", env: "production", port };
}

/**
 * The proxy handler of a route, narrowed. Only the API apex denials carry
 * another kind, and a route that has one here is the assertion failing rather
 * than a field read off the wrong shape.
 */
function proxyOf(route: CaddyRoute): CaddyProxyHandler {
  const handle = route.handle[0];
  if (handle.handler !== "reverse_proxy") {
    throw new Error(`route "${route["@id"]}" does not proxy: ${handle.handler}`);
  }
  return handle;
}

function methods(): string[] {
  return calls.map((call) => call.method);
}

/** The ids this driver owns, in the order Caddy is holding them. */
function ownedIds(): string[] {
  return routes
    .map((route) => route["@id"])
    .filter((id): id is string => typeof id === "string" && id.startsWith(ROUTE_ID_PREFIX));
}

/** Whether every catch-all sits after every other route this driver owns. */
function catchAllsLast(): boolean {
  const owned = ownedIds();
  const first = owned.findIndex((id) => id.startsWith(CATCHALL_ID_PREFIX));
  return first === -1 || owned.slice(first).every((id) => id.startsWith(CATCHALL_ID_PREFIX));
}

/** Answers the four calls Caddy's admin API does, over an array of routes. */
function admin(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const method = init?.method ?? "GET";
  /* The driver only ever sends a JSON string; anything else is not its call. */
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  const origin = new Headers(init?.headers).get("origin");
  calls.push({ method, url, origin, ...(body === undefined ? {} : { body }) });

  const forced = status.get(`${method} ${url}`);
  if (forced !== undefined) return answer(forced);

  if (method === "GET" && url === ROUTES_URL) {
    return Promise.resolve(new Response(JSON.stringify(routes)));
  }
  if (method === "POST" && url === ROUTES_URL) {
    routes.push(body as Record<string, unknown>);
    return answer(200);
  }

  const id = idIn(url);
  if (id === null) return answer(404);
  const at = routes.findIndex((route) => route["@id"] === id);
  if (at === -1) return answer(404);

  if (method === "PATCH") routes[at] = body as Record<string, unknown>;
  else if (method === "DELETE") routes.splice(at, 1);
  else return answer(405);
  return answer(200);
}

/**
 * The id a `/id/...` URL names. Caddy takes it from exactly one path segment,
 * and so does this.
 */
function idIn(url: string): string | null {
  const path = new URL(url).pathname;
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments[0] !== "id" || segments[1] === undefined) return null;
  return decodeURIComponent(segments[1]);
}

function answer(code: number): Promise<Response> {
  return Promise.resolve(new Response(code === 200 ? "" : "admin says no", { status: code }));
}
