/*
 * Ingress driver for an operator-run Caddy, converged through its admin API.
 *
 * Caddy itself is not managed here: the operator runs it, defines the HTTP
 * server this driver writes into, and points it at the agent's on-demand-TLS ask
 * endpoint. Setting that up is documented with the deployment instructions. This
 * driver only owns the routes inside that server, and only its own.
 */

import { ScaloError } from "../../core/error.ts";
import type { IngressBackend, IngressDesired, IngressDriver } from "../../core/types/ingress.ts";
import { stableStringify } from "../../core/utils/json.ts";

/** Where Caddy listens for admin commands when the operator has not moved it. */
export const DEFAULT_ADMIN_URL: string = "http://127.0.0.1:2019";

/** Name of the HTTP server inside Caddy's config this driver writes routes into. */
export const DEFAULT_SERVER_NAME: string = "scalo";

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
export const ROUTE_ID_PREFIX: string = "scalo_";

export interface CaddyDriverOptions {
  /** Base URL of Caddy's admin API. Defaults to {@link DEFAULT_ADMIN_URL}. */
  adminUrl?: string;
  /** HTTP server the routes belong to. Defaults to {@link DEFAULT_SERVER_NAME}. */
  serverName?: string;
  /** Injected `fetch`; defaults to the global one. */
  fetchFn?: typeof fetch;
}

/** One route as this driver writes it; Caddy keeps every field verbatim. */
interface ScaloRoute {
  "@id": string;
  "match": Array<{ host: string[] }>;
  "handle": Array<{ handler: "reverse_proxy"; upstreams: Array<{ dial: string }> }>;
  "terminal": true;
}

/**
 * Builds the driver that routes traffic through Caddy.
 *
 * Every admin call that fails is `ScaloError("capability-missing")` with status
 * 502: no code names "the thing this node drives refused a command", and of the
 * ones there are, a capability the node needs and does not have is the closest —
 * the status is what says the failure came from behind the node rather than from
 * the caller.
 */
export function createCaddyDriver(opts?: CaddyDriverOptions): IngressDriver {
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
      const owned = new Map<string, Record<string, unknown>>();
      for (const route of await readRoutes()) {
        const id = route["@id"];
        if (typeof id === "string" && id.startsWith(ROUTE_ID_PREFIX)) owned.set(id, route);
      }

      const wanted = new Map<string, ScaloRoute>();
      for (const { host, backend } of desired.routes) {
        wanted.set(routeId(host), routeFor(host, backend));
      }

      /* Routes are put in place before stale ones are taken away, so a host that
         moves between backends is never briefly served by neither. */
      for (const [id, route] of wanted) {
        const current = owned.get(id);
        if (current === undefined) {
          /* POST to an array appends to it; the routes the operator wrote keep
             their position and their contents. */
          const response = await call("POST", routesUrl, route);
          if (!response.ok) {
            throw adminFailed("POST", routesUrl, `answered ${String(response.status)}`);
          }
          continue;
        }
        if (sameRoute(current, route)) continue;

        const url = idUrl(id);
        const response = await call("PATCH", url, route);
        if (!response.ok) throw adminFailed("PATCH", url, `answered ${String(response.status)}`);
      }

      for (const id of [...owned.keys()].sort()) {
        if (wanted.has(id)) continue;

        const url = idUrl(id);
        const response = await call("DELETE", url);
        if (!response.ok) throw adminFailed("DELETE", url, `answered ${String(response.status)}`);
      }
    },
  };
}

/**
 * Origin of the admin API, which every call to it presents as its own.
 *
 * Throws `ScaloError("invalid-input")` when the configured admin URL is not a
 * URL: an ingress that cannot be addressed must fail the node's boot, not the
 * first reconcile pass that tries to publish a route through it.
 */
function originOf(adminUrl: string): string {
  try {
    return new URL(adminUrl).origin;
  } catch (error) {
    throw new ScaloError("invalid-input", "Ingress admin URL is not a URL", {
      detail: `"${adminUrl}" is not the base URL of a Caddy admin API`,
      cause: error,
    });
  }
}

/** The `@id` the route for `host` is addressed by. */
export function routeId(host: string): string {
  return `${ROUTE_ID_PREFIX}${host}`;
}

function routeFor(host: string, backend: IngressBackend): ScaloRoute {
  return {
    "@id": routeId(host),
    "match": [{ host: [host] }],
    "handle": [
      {
        handler: "reverse_proxy",
        /* Runtime processes only ever listen on loopback: the ingress is the one
           thing that faces the public network. */
        upstreams: [{ dial: `127.0.0.1:${String(backend.port)}` }],
      },
    ],
    "terminal": true,
  };
}

/**
 * Whether the route Caddy holds already says what this driver wants it to.
 *
 * Only the fields this driver writes are compared. Caddy normalizes what it
 * stores and may carry more than it was given, and a route that differs only in
 * something nobody here set would otherwise be rewritten on every single pass.
 */
function sameRoute(current: Record<string, unknown>, wanted: ScaloRoute): boolean {
  const projection = (route: Record<string, unknown>): string =>
    stableStringify({ match: route.match, handle: route.handle, terminal: route.terminal });

  return projection(current) === projection(wanted as unknown as Record<string, unknown>);
}

function adminFailed(method: string, url: string, what: string, cause?: unknown): ScaloError {
  return new ScaloError("capability-missing", "Ingress could not be configured", {
    status: 502,
    detail: `the Caddy admin API ${what} for ${method} ${url}`,
    cause,
  });
}
