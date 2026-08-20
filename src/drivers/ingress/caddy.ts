/*
 * Ingress driver for an operator-run Caddy, converged through its admin API.
 *
 * Caddy itself is not managed here: the operator runs it, defines the HTTP
 * server this driver writes into, and points it at the agent's on-demand-TLS ask
 * endpoint. Setting that up is documented with the deployment instructions. This
 * driver only owns the routes inside that server, and only its own.
 */

import { ScafoError } from "../../core/error.ts";
import type { IngressDesired, IngressDriver, WeightedBackend } from "../../core/types/ingress.ts";
import { stableStringify } from "../../core/utils/json.ts";

/** Where Caddy listens for admin commands when the operator has not moved it. */
export const DEFAULT_ADMIN_URL: string = "http://127.0.0.1:2019";

/** Name of the HTTP server inside Caddy's config this driver writes routes into. */
export const DEFAULT_SERVER_NAME: string = "scafo";

/**
 * Namespace of every route this driver owns. Routes without it are the
 * operator's and are never read, rewritten or removed.
 *
 * The separator is an underscore rather than a slash because Caddy addresses a
 * route by `@id` at `/id/<id>/<path...>`, taking the id from exactly one path
 * segment: an id containing a slash names a different object than it looks like,
 * and cannot be reached at all. An underscore cannot occur in a DNS name, so the
 * boundary between the namespace and the host stays unambiguous.
 */
export const ROUTE_ID_PREFIX: string = "scafo_";

/**
 * Namespace of the catch-all routes, which is {@link ROUTE_ID_PREFIX} plus a
 * segment no host route's id can carry.
 *
 * Every other id is `scafo_` followed by the host the route matches; an
 * underscore cannot occur in a DNS name, so `scafo_catchall_<domain>` can never
 * be the id of a route for a host. That is what lets the converge tell its own
 * catch-alls apart from its own host routes without parsing either.
 */
export const CATCHALL_ID_PREFIX: string = `${ROUTE_ID_PREFIX}catchall_`;

export interface CaddyDriverOptions {
  /** Base URL of Caddy's admin API. Defaults to {@link DEFAULT_ADMIN_URL}. */
  adminUrl?: string;
  /** HTTP server the routes belong to. Defaults to {@link DEFAULT_SERVER_NAME}. */
  serverName?: string;
  /** Injected `fetch`; defaults to the global one. */
  fetchFn?: typeof fetch;
  /**
   * Address the runtime processes bound, which is what every process upstream
   * dials. Loopback by default; a node whose processes bind a tunnel address
   * (`runtime.bindHost`) must hand it in, or the routes dial an address
   * nothing listens on.
   */
  upstreamHost?: string;
}

/**
 * How Caddy is told to divide a host's traffic between several upstreams.
 *
 * `weights` is POSITIONAL: the nth weight belongs to the nth upstream, so the
 * two arrays are written together and must stay the same length. Caddy accepts a
 * mismatch without complaint, which is exactly why nothing here may produce one.
 *
 * Pinned empirically against `caddy:2` (v2.11.4) through the admin API rather
 * than taken from the documentation: the config is stored and read back
 * verbatim, and 200 requests over a two-upstream `[90, 10]` split arrived 180/20.
 */
export interface CaddyLoadBalancing {
  selection_policy: { policy: "weighted_round_robin"; weights: number[] };
}

/** One route as this driver writes it; Caddy keeps every field verbatim. */
export interface CaddyRoute {
  "@id": string;
  "match": Array<{ host: string[] }>;
  "handle": Array<{
    handler: "reverse_proxy";
    upstreams: Array<{ dial: string }>;
    /** Absent for a single upstream: there is nothing to balance. */
    load_balancing?: CaddyLoadBalancing;
  }>;
  "terminal": true;
}

/**
 * Builds the driver that routes traffic through Caddy.
 *
 * Every admin call that fails is `ScafoError("capability-missing")` with status
 * 502: no code names "the thing this node drives refused a command", and of the
 * ones there are, a capability the node needs and does not have is the closest —
 * the status is what says the failure came from behind the node rather than from
 * the caller.
 */
export function createCaddyDriver(opts?: CaddyDriverOptions): IngressDriver {
  const upstreamHost = opts?.upstreamHost ?? "127.0.0.1";
  const admin = (opts?.adminUrl ?? DEFAULT_ADMIN_URL).replace(/\/$/, "");
  const server = opts?.serverName ?? DEFAULT_SERVER_NAME;
  const fetchFn: typeof fetch = opts?.fetchFn ?? ((input, init) => globalThis.fetch(input, init));

  const routesUrl = `${admin}/config/apps/http/servers/${encodeURIComponent(server)}/routes`;
  const idUrl = (id: string): string => `${admin}/id/${encodeURIComponent(id)}`;
  const origin = originOf(admin);

  async function call(method: string, url: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers: {
          /*
           * Caddy's admin API refuses a call it takes for a browser's, and
           * `fetch` announces every request as one: it attaches
           * `Sec-Fetch-Mode: cors`, which is a forbidden header name a caller
           * cannot unset. Caddy then applies its cross-origin check and answers
           * 403 unless the call also carries an `Origin` it allows. Naming this
           * driver's own admin origin is what satisfies it — an admin API on
           * loopback, where Caddy puts it by default, allows exactly that.
           *
           * An operator who moves the admin listener off loopback must list the
           * origin in Caddy's `admin.origins`, which Caddy requires of any
           * client reaching it there.
           */
          origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw adminFailed(method, url, "could not be reached", error);
    }
    /* Nothing reads an admin response body, and an unread one holds the connection. */
    if (method !== "GET") await response.body?.cancel();
    return response;
  }

  /**
   * Routes the server currently has. A server the operator has not given a
   * `routes` key answers 404, and one whose key is there but empty answers a
   * JSON `null`; both mean "nothing is routed yet" rather than a failure.
   */
  async function readRoutes(): Promise<Array<Record<string, unknown>>> {
    const response = await call("GET", routesUrl);
    if (response.status === 404) {
      await response.body?.cancel();
      return [];
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw adminFailed("GET", routesUrl, `answered ${String(response.status)}`);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text.trim() === "" ? null : JSON.parse(text);
    } catch (error) {
      throw adminFailed("GET", routesUrl, "answered something that is not JSON", error);
    }
    return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
  }

  return {
    async apply(desired: IngressDesired): Promise<void> {
      /*
       * THE INVARIANT THIS CONVERGE KEEPS: every catch-all route this driver
       * owns sits AFTER every other route it owns, on every pass. Caddy matches
       * routes in ARRAY ORDER and each of these is terminal, so a catch-all
       * reached first answers for a host an explicit route was written for —
       * which is not one misrouted name but a whole platform domain's live
       * traffic going to the agent instead of to the processes serving it.
       *
       * `POST` appends, so any route added on this pass would land behind
       * catch-alls that are already there. Rather than compute an insertion
       * point, the catch-alls are DELETED AND RE-APPENDED whenever they are not
       * already exactly right — same ids, same contents, nothing this driver
       * owns after them, and nothing appended after them on this pass. There is
       * one per platform domain, and a settled node re-appends none of them.
       */
      const owned = new Map<string, Record<string, unknown>>();
      const order: string[] = [];
      for (const route of await readRoutes()) {
        const id = route["@id"];
        if (typeof id === "string" && id.startsWith(ROUTE_ID_PREFIX)) {
          owned.set(id, route);
          order.push(id);
        }
      }

      const rendered = renderCaddyRoutes(desired, upstreamHost);
      const wanted = new Map<string, CaddyRoute>();
      for (const route of rendered) wanted.set(route["@id"], route);
      const catchAlls = rendered.filter((route) => isCatchAll(route["@id"]));

      /* Routes are put in place before stale ones are taken away, so a host that
         moves between backends is never briefly served by neither. */
      let appended = false;
      for (const [id, route] of wanted) {
        if (isCatchAll(id)) continue;

        const current = owned.get(id);
        if (current === undefined) {
          /* POST to an array appends to it; the routes the operator wrote keep
             their position and their contents. */
          const response = await call("POST", routesUrl, route);
          if (!response.ok) {
            throw adminFailed("POST", routesUrl, `answered ${String(response.status)}`);
          }
          appended = true;
          continue;
        }
        if (sameRoute(current, route)) continue;

        const url = idUrl(id);
        const response = await call("PATCH", url, route);
        if (!response.ok) throw adminFailed("PATCH", url, `answered ${String(response.status)}`);
      }

      for (const id of [...owned.keys()].sort()) {
        /* Stale catch-alls are left to the re-append below, which is the only
           thing that ever writes them, so they are never removed and then not
           put back. */
        if (wanted.has(id) || isCatchAll(id)) continue;

        const url = idUrl(id);
        const response = await call("DELETE", url);
        if (!response.ok) throw adminFailed("DELETE", url, `answered ${String(response.status)}`);
      }

      if (!appended && catchAllsSettled(order, owned, catchAlls)) return;

      /* The one place this driver removes before it adds, and it is the safe
         direction: what a catch-all answers is a request nothing else routes,
         so the window costs Caddy's own answer for an unrouted host rather than
         an outage of anything being served. Adding first is not available —
         appending a second copy would put the stale one first. */
      for (const id of order.filter(isCatchAll)) {
        const url = idUrl(id);
        const response = await call("DELETE", url);
        if (!response.ok) throw adminFailed("DELETE", url, `answered ${String(response.status)}`);
      }
      for (const route of catchAlls) {
        const response = await call("POST", routesUrl, route);
        if (!response.ok) {
          throw adminFailed("POST", routesUrl, `answered ${String(response.status)}`);
        }
      }
    },
  };
}

/**
 * Origin of the admin API, which every call to it presents as its own.
 *
 * Throws `ScafoError("invalid-input")` when the configured admin URL is not a
 * URL: an ingress that cannot be addressed must fail the node's boot, not the
 * first reconcile pass that tries to publish a route through it.
 */
function originOf(adminUrl: string): string {
  try {
    return new URL(adminUrl).origin;
  } catch (error) {
    throw new ScafoError("invalid-input", "Ingress admin URL is not a URL", {
      detail: `"${adminUrl}" is not the base URL of a Caddy admin API`,
      cause: error,
    });
  }
}

/** The `@id` the route for `host` is addressed by. */
export function routeId(host: string): string {
  return `${ROUTE_ID_PREFIX}${host}`;
}

/** The `@id` the catch-all for one platform domain is addressed by. */
export function catchAllId(domain: string): string {
  return `${CATCHALL_ID_PREFIX}${domain}`;
}

/**
 * The routes this driver wants Caddy to hold for `desired`, IN THE ORDER CADDY
 * MUST HOLD THEM: everything explicit first — the process-backed hosts in the
 * order the routing states them, then the hosts waiting to be woken — and the
 * per-domain catch-alls last.
 *
 * The order is part of what is rendered rather than something `apply` sorts out,
 * because Caddy matches top-down and every route here is terminal. See `apply`
 * for how that order is kept across incremental converges.
 *
 * Pure, and separated from the conversation with the admin API so that what this
 * driver MEANS by a routing can be compared against what another ingress driver
 * means by the same one — which is what `test/ingress-parity.test.ts` does.
 */
export function renderCaddyRoutes(
  desired: IngressDesired,
  upstreamHost = "127.0.0.1",
): CaddyRoute[] {
  const routes = desired.routes.map(({ host, backends }) => routeFor(host, backends, upstreamHost));

  const wake = desired.wake;
  if (wake === undefined) return routes;

  const dial = `127.0.0.1:${String(wake.port)}`;
  for (const host of wake.hosts) routes.push(agentRoute(routeId(host), host, dial));
  /* A Caddy host matcher wildcard covers exactly ONE label, so `*.<domain>` is
     every subdomain of a platform domain and never the domain itself — and
     never a subdomain of a subdomain either. */
  for (const domain of wake.domains) {
    routes.push(agentRoute(catchAllId(domain), `*.${domain}`, dial));
  }
  return routes;
}

/**
 * One route, with as many upstreams as the host has backends.
 *
 * A host with ONE backend is rendered without a load-balancing policy at all:
 * there is nothing to choose between, and saying so would rewrite every route on
 * this node's next pass for no gain. A host with several carries
 * `weighted_round_robin` and the backends' weights in the SAME ORDER the
 * upstreams are written in — see {@link CaddyLoadBalancing}.
 */
function routeFor(host: string, backends: WeightedBackend[], upstreamHost: string): CaddyRoute {
  return {
    "@id": routeId(host),
    "match": [{ host: [host] }],
    "handle": [
      {
        handler: "reverse_proxy",
        /* Dialled at the address the processes actually bound: loopback on a
           single node, the tunnel address on a fleet. The ingress is on this
           node either way; which interface it dials is the node's decision. */
        upstreams: backends.map((leg) => ({
          dial: `${upstreamHost}:${String(leg.backend.port)}`,
        })),
        ...(backends.length < 2
          ? {}
          : {
              load_balancing: {
                selection_policy: {
                  policy: "weighted_round_robin" as const,
                  weights: backends.map((leg) => leg.weight),
                },
              },
            }),
      },
    ],
    "terminal": true,
  };
}

/**
 * One route sending everything it matches to the node's own agent — a parked
 * environment's host, or a whole platform domain's unmatched subdomains.
 *
 * A single upstream and no load-balancing policy: there is one agent, and it is
 * on the same loopback the runtime processes are.
 */
function agentRoute(id: string, match: string, dial: string): CaddyRoute {
  return {
    "@id": id,
    "match": [{ host: [match] }],
    "handle": [{ handler: "reverse_proxy", upstreams: [{ dial }] }],
    "terminal": true,
  };
}

/** Whether an `@id` this driver owns is one of its catch-alls. */
function isCatchAll(id: string): boolean {
  return id.startsWith(CATCHALL_ID_PREFIX);
}

/**
 * Whether Caddy already holds exactly these catch-alls, in this order, with
 * nothing this driver owns after them — the invariant `apply` states.
 *
 * `order` is the ids this driver owns as Caddy listed them, so position is read
 * off the array rather than assumed from the map.
 */
function catchAllsSettled(
  order: string[],
  owned: Map<string, Record<string, unknown>>,
  wanted: CaddyRoute[],
): boolean {
  const held = order.filter(isCatchAll);
  if (held.length !== wanted.length) return false;

  const first = order.findIndex(isCatchAll);
  if (first !== -1 && order.slice(first).some((id) => !isCatchAll(id))) return false;

  return wanted.every((route, at) => {
    const current = owned.get(held[at]);
    return current !== undefined && held[at] === route["@id"] && sameRoute(current, route);
  });
}

/**
 * Whether the route Caddy holds already says what this driver wants it to.
 *
 * Only the fields this driver writes are compared. Caddy normalizes what it
 * stores and may carry more than it was given, and a route that differs only in
 * something nobody here set would otherwise be rewritten on every single pass.
 */
function sameRoute(current: Record<string, unknown>, wanted: CaddyRoute): boolean {
  const projection = (route: Record<string, unknown>): string =>
    stableStringify({ match: route.match, handle: route.handle, terminal: route.terminal });

  return projection(current) === projection(wanted as unknown as Record<string, unknown>);
}

function adminFailed(method: string, url: string, what: string, cause?: unknown): ScafoError {
  return new ScafoError("capability-missing", "Ingress could not be configured", {
    status: 502,
    detail: `the Caddy admin API ${what} for ${method} ${url}`,
    cause,
  });
}
