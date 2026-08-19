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
  createCaddyDriver,
  DEFAULT_SERVER_NAME,
  renderCaddyRoutes,
  ROUTE_ID_PREFIX,
} from "../src/drivers/ingress/caddy.ts";
import { rejectsWith } from "./_helpers.ts";

const ADMIN = "http://caddy.test:2019";
const ROUTES_URL = `${ADMIN}/config/apps/http/servers/${DEFAULT_SERVER_NAME}/routes`;
const HOST = "shop.apps.test";
const OTHER_HOST = "shop--staging.apps.test";

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

describe("a host divided between several backends", () => {
  /*
   * The shape below is not taken from the documentation. It was PINNED against
   * `caddy:2` (v2.11.4) through the admin API: posted verbatim, read back
   * unchanged, and measured — 200 requests over a two-upstream `[90, 10]` split
   * arrived 180/20, exactly. `weights` is positional, so it lines up with
   * `upstreams` index by index.
   */
  it("writes weighted_round_robin with one weight per upstream, in order", () => {
    expect(
      renderCaddyRoutes(
        split(HOST, [
          [42_000, 90],
          [42_002, 10],
        ]),
      ),
    ).toEqual([
      {
        "@id": `${ROUTE_ID_PREFIX}${HOST}`,
        "match": [{ host: [HOST] }],
        "handle": [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: "127.0.0.1:42000" }, { dial: "127.0.0.1:42002" }],
            load_balancing: {
              selection_policy: { policy: "weighted_round_robin", weights: [90, 10] },
            },
          },
        ],
        "terminal": true,
      },
    ]);
  });

  it("says nothing about load balancing when there is only one upstream", () => {
    /* Nothing to choose between, and a policy written anyway would be a field to
       compare and rewrite on every pass for no gain. */
    const [route] = renderCaddyRoutes(desired([[HOST, 42_000]]));

    expect(route.handle[0].load_balancing).toBeUndefined();
    expect(Object.keys(route.handle[0])).toEqual(["handler", "upstreams"]);
  });

  it("keeps the weights and the upstreams the same length, whatever the split", () => {
    for (const legs of [
      [[42_000, 50] as [number, number], [42_002, 50] as [number, number]],
      [
        [42_000, 34] as [number, number],
        [42_002, 33] as [number, number],
        [42_004, 33] as [number, number],
      ],
    ]) {
      const [route] = renderCaddyRoutes(split(HOST, legs));
      const handle = route.handle[0];

      /* Caddy accepts a mismatch without complaint, which is exactly why the
         renderer may never produce one. */
      expect(handle.load_balancing?.selection_policy.weights).toHaveLength(handle.upstreams.length);
    }
  });

  it("converges a host that gains a second backend, in place", async () => {
    await driver.apply(desired([[HOST, 42_000]]));
    calls = [];

    await driver.apply(
      split(HOST, [
        [42_000, 90],
        [42_002, 10],
      ]),
    );

    /* The host keeps its `@id`, so the split arrives as a patch rather than as a
       withdrawal followed by a fresh route. */
    expect(methods()).toEqual(["GET", "PATCH"]);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      handle: [
        {
          upstreams: [{ dial: "127.0.0.1:42000" }, { dial: "127.0.0.1:42002" }],
          load_balancing: {
            selection_policy: { policy: "weighted_round_robin", weights: [90, 10] },
          },
        },
      ],
    });
  });

  it("rewrites a host whose weights moved and leaves one whose did not", async () => {
    const ninetyTen = split(HOST, [
      [42_000, 90],
      [42_002, 10],
    ]);
    await driver.apply(ninetyTen);
    calls = [];

    await driver.apply(ninetyTen);
    expect(methods()).toEqual(["GET"]);

    await driver.apply(
      split(HOST, [
        [42_000, 50],
        [42_002, 50],
      ]),
    );
    expect(methods()).toEqual(["GET", "GET", "PATCH"]);
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
      backends: [{ backend: backend(port), weight: 100 }],
    })),
  };
}

/** One host divided between several builds, as a split renders it. */
function split(host: string, legs: Array<[number, number]>): IngressDesired {
  return {
    routes: [
      {
        host,
        backends: legs.map(([port, weight]) => ({ backend: backend(port), weight })),
      },
    ],
  };
}

function backend(port: number): { project: string; env: string; build: string; port: number } {
  return { project: "shop", env: "production", build: `build${String(port)}`, port };
}

function methods(): string[] {
  return calls.map((call) => call.method);
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
