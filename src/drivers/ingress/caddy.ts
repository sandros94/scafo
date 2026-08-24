/*
 * Ingress driver for an operator-run Caddy, converged through its admin API.
 *
 * Caddy itself is not managed here: the operator runs it, defines the HTTP
 * server this driver writes into, and points it at the daemon's on-demand-TLS ask
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

/**
 * Namespace of the route serving the fleet's API at one platform apex, on the
 * same reading as {@link CATCHALL_ID_PREFIX}: an underscore cannot occur in a
 * DNS name, so `scafo_api_<domain>` can never be the id of a route for a host.
 */
export const API_ID_PREFIX: string = `${ROUTE_ID_PREFIX}api_`;

/**
 * Namespace of the route that DENIES the excluded prefixes at one platform
 * apex. Distinct from {@link API_ID_PREFIX} rather than a suffix of it, so
 * neither is a prefix of the other and a converge can tell them apart by name.
 */
export const API_DENY_ID_PREFIX: string = `${ROUTE_ID_PREFIX}apideny_`;

/**
 * What a denied request on the API apex is answered with, by Caddy itself and
 * never by the daemon behind it.
 *
 * A miss rather than a refusal: an unauthenticated caller learns that the name
 * serves nothing there, which is all it is owed. A `403` would confirm the
 * surface exists and is merely closed to them.
 */
export const API_DENY_STATUS: number = 404;

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

/**
 * One matcher set: every matcher in it must agree for the route to match.
 *
 * `not` holds matcher sets the request must match NONE of, which is Caddy's own
 * spelling of a negation and the shape it stores a route in — verified against
 * `caddy:2` (v2.11.4) by writing it through the admin API and reading it back
 * verbatim. `path` is a list of patterns, case-insensitive, where a trailing
 * `/*` matches the whole subtree beneath a prefix and the bare prefix does not.
 */
export interface CaddyMatch {
  host: string[];
  path?: string[];
  not?: Array<{ path: string[] }>;
}

/** What a routed host is served by: the upstreams, and how they are chosen. */
export interface CaddyProxyHandler {
  handler: "reverse_proxy";
  upstreams: Array<{ dial: string }>;
  /** Absent for a single upstream: there is nothing to balance. */
  load_balancing?: CaddyLoadBalancing;
}

/** What Caddy answers with itself, dialling nothing: the API apex denials. */
export interface CaddyDenyHandler {
  handler: "static_response";
  status_code: number;
}

/** A route's handler: the proxy every routed host has, or a flat denial. */
export type CaddyHandler = CaddyProxyHandler | CaddyDenyHandler;

/** One route as this driver writes it; Caddy keeps every field verbatim. */
export interface CaddyRoute {
  "@id": string;
  "match": CaddyMatch[];
  "handle": CaddyHandler[];
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
       * THE INVARIANT THIS CONVERGE KEEPS: the TRAILING routes this driver owns
       * — the API apexes and their denials, then the per-domain catch-alls —
       * sit AFTER every host route it owns and in exactly the rendered order, on
       * every pass. Caddy matches routes in ARRAY ORDER and each of these is
       * terminal, so getting it wrong is not one misrouted name: a catch-all
       * reached first sends a whole platform domain's live traffic to the daemon,
       * and an API route reached before its denial would proxy `/v1/storage`.
       *
       * `POST` appends, so any route added on this pass would land behind the
       * trailing ones that are already there. Rather than compute an insertion
       * point, they are DELETED AND RE-APPENDED AS A BLOCK whenever they are not
       * already exactly right — same ids, same order, same contents, nothing
       * this driver owns after them, and nothing appended after them on this
       * pass. A settled node re-appends none of them.
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
      const trailing = rendered.filter((route) => isTrailing(route["@id"]));

      /* Routes are put in place before stale ones are taken away, so a host that
         moves between backends is never briefly served by neither. */
      let appended = false;
      for (const [id, route] of wanted) {
        if (isTrailing(id)) continue;

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
        /* Stale trailing routes are left to the re-append below, which is the
           only thing that ever writes them, so they are never removed and then
           not put back. */
        if (wanted.has(id) || isTrailing(id)) continue;

        const url = idUrl(id);
        const response = await call("DELETE", url);
        if (!response.ok) throw adminFailed("DELETE", url, `answered ${String(response.status)}`);
      }

      if (!appended && trailingSettled(order, owned, trailing)) return;

      /* The one place this driver removes before it adds, and it is the safe
         direction: what these routes answer is a request nothing else routes,
         so the window costs Caddy's own answer for an unrouted host rather than
         an outage of anything being served — and an API apex that is briefly
         absent cannot leak, because its denial and its proxy go together.
         Adding first is not available — appending a second copy would put the
         stale one first. */
      for (const id of order.filter(isTrailing)) {
        const url = idUrl(id);
        const response = await call("DELETE", url);
        if (!response.ok) throw adminFailed("DELETE", url, `answered ${String(response.status)}`);
      }
      for (const route of trailing) {
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

/** The `@id` the API route for one platform apex is addressed by. */
export function apiRouteId(domain: string): string {
  return `${API_ID_PREFIX}${domain}`;
}

/** The `@id` the denial guarding one platform apex is addressed by. */
export function apiDenyId(domain: string): string {
  return `${API_DENY_ID_PREFIX}${domain}`;
}

/**
 * The routes this driver wants Caddy to hold for `desired`, IN THE ORDER CADDY
 * MUST HOLD THEM: everything explicit first — the process-backed hosts in the
 * order the routing states them, then the hosts waiting to be woken — then the
 * API apexes, and the per-domain catch-alls last.
 *
 * THE API APEXES SIT WHERE THEY DO FOR TWO REASONS. Below the hosts above, so an
 * application deliberately put at a platform apex keeps it; above the
 * catch-alls, because one platform domain may be a subdomain of another and
 * `*.<outer>` matches `<inner>` exactly.
 *
 * Each apex is TWO routes and the DENIAL COMES FIRST. The second matches the
 * apex and NOT the excluded prefixes and proxies everything else to the daemon;
 * the first matches those very prefixes and answers {@link API_DENY_STATUS} flat,
 * from Caddy, without ever dialling anything. Either alone would close the
 * surface — the negation makes the proxy unable to carry those paths at all —
 * and the pair is what also gives the caller an answer instead of Caddy's
 * fall-through.
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
  const wakeDial = wake === undefined ? "" : `127.0.0.1:${String(wake.port)}`;
  if (wake !== undefined) {
    for (const host of wake.hosts) routes.push(nodeRoute(routeId(host), host, wakeDial));
  }

  const api = desired.api;
  if (api !== undefined) {
    const dial = `127.0.0.1:${String(api.port)}`;
    const denied = api.denied.flatMap(deniedPatterns);

    for (const host of api.hosts) {
      routes.push({
        "@id": apiDenyId(host),
        "match": [{ host: [host], path: denied }],
        /* Answered BY CADDY. Nothing on this path reaches the daemon, so no
           misreading of a header, a token or a route behind it can open it. */
        "handle": [{ handler: "static_response", status_code: API_DENY_STATUS }],
        "terminal": true,
      });
      routes.push({
        "@id": apiRouteId(host),
        "match": [{ host: [host], not: [{ path: denied }] }],
        "handle": [{ handler: "reverse_proxy", upstreams: [{ dial }] }],
        "terminal": true,
      });
    }
  }

  /* A Caddy host matcher wildcard covers exactly ONE label, so `*.<domain>` is
     every subdomain of a platform domain and never the domain itself — and
     never a subdomain of a subdomain either. */
  if (wake !== undefined) {
    for (const domain of wake.domains) {
      routes.push(nodeRoute(catchAllId(domain), `*.${domain}`, wakeDial));
    }
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
 * One route sending everything it matches to the node's own daemon — a parked
 * environment's host, or a whole platform domain's unmatched subdomains.
 *
 * A single upstream and no load-balancing policy: there is one daemon, and it is
 * on the same loopback the runtime processes are.
 */
function nodeRoute(id: string, match: string, dial: string): CaddyRoute {
  return {
    "@id": id,
    "match": [{ host: [match] }],
    "handle": [{ handler: "reverse_proxy", upstreams: [{ dial }] }],
    "terminal": true,
  };
}

/**
 * Whether an `@id` this driver owns belongs to the block that must sit last: an
 * API apex, its denial, or a platform domain's catch-all.
 */
function isTrailing(id: string): boolean {
  return (
    id.startsWith(CATCHALL_ID_PREFIX) ||
    id.startsWith(API_ID_PREFIX) ||
    id.startsWith(API_DENY_ID_PREFIX)
  );
}

/**
 * Whether Caddy already holds exactly this trailing block, in this order, with
 * nothing this driver owns after it — the invariant `apply` states.
 *
 * `order` is the ids this driver owns as Caddy listed them, so position is read
 * off the array rather than assumed from the map.
 */
function trailingSettled(
  order: string[],
  owned: Map<string, Record<string, unknown>>,
  wanted: CaddyRoute[],
): boolean {
  const held = order.filter(isTrailing);
  if (held.length !== wanted.length) return false;

  const first = order.findIndex(isTrailing);
  if (first !== -1 && order.slice(first).some((id) => !isTrailing(id))) return false;

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

/**
 * The Caddy path patterns one denied prefix is written as: the prefix exactly,
 * and the whole subtree beneath it.
 *
 * A SEGMENT BOUNDARY rather than a string prefix, because that is what a route
 * prefix means and because the Traefik driver's rules say the same thing —
 * `/v1/storagex` is a different path and neither driver denies it. Caddy's path
 * matcher does not treat a bare pattern as a prefix, so both forms are written
 * out; pinned against v2.11.4, where `/v1/storage/*` matched `/v1/storage/a/b`.
 */
function deniedPatterns(prefix: string): string[] {
  return [prefix, `${prefix}/*`];
}

function adminFailed(method: string, url: string, what: string, cause?: unknown): ScafoError {
  return new ScafoError("capability-missing", "Ingress could not be configured", {
    status: 502,
    detail: `the Caddy admin API ${what} for ${method} ${url}`,
    cause,
  });
}
