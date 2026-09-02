/* Converges Scafo-owned routes in an operator-managed Caddy server. */

import { ScafoError } from "../../core/error.ts";
import type { IngressBackend, IngressDesired, IngressDriver } from "../../core/types/ingress.ts";
import { stableStringify } from "../../core/utils/json.ts";

/** Where Caddy listens for admin commands when the operator has not moved it. */
export const DEFAULT_ADMIN_URL: string = "http://127.0.0.1:2019";

/** Name of the HTTP server inside Caddy's config this driver writes routes into. */
export const DEFAULT_SERVER_NAME: string = "scafo";

/** Scafo-owned route namespace; all other Caddy routes are preserved. */
export const ROUTE_ID_PREFIX: string = "scafo_";

/** Namespace for platform API routes. */
export const API_ID_PREFIX: string = `${ROUTE_ID_PREFIX}api_`;

/** Namespace for API denial routes. */
export const API_DENY_ID_PREFIX: string = `${ROUTE_ID_PREFIX}apideny_`;

/** Caddy returns this for denied API paths without contacting the daemon. */
export const API_DENY_STATUS: number = 404;

export interface CaddyDriverOptions {
  /** Base URL of Caddy's admin API. Defaults to {@link DEFAULT_ADMIN_URL}. */
  adminUrl?: string;
  /** HTTP server the routes belong to. Defaults to {@link DEFAULT_SERVER_NAME}. */
  serverName?: string;
  /** Injected `fetch`; defaults to the global one. */
  fetchFn?: typeof fetch;
  /** Runtime bind address; must match the address proxy upstreams dial. */
  upstreamHost?: string;
}

/** Caddy route matchers. Every matcher agrees; `not` excludes matching sets. */
export interface CaddyMatch {
  host: string[];
  path?: string[];
  not?: Array<{ path: string[] }>;
}

/** What a routed host is served by. */
export interface CaddyProxyHandler {
  handler: "reverse_proxy";
  upstreams: Array<{ dial: string }>;
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

/** Builds a Caddy ingress driver. Admin failures are capability-missing (502). */
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
          /* Node fetch sends Sec-Fetch-Mode; Caddy requires an allowed Origin. */
          origin,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw adminFailed(method, url, "could not be reached", error);
    }
    /* Release unused response bodies. */
    if (method !== "GET") await response.body?.cancel();
    return response;
  }

  /** A missing routes key or null document means no routes. */
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
      /* Terminal API routes remain last, with denial before proxy. Reappend the
         block when its exact order or contents differ because POST appends. */
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

      /* Add/rewrite hosts before removing stale routes to avoid a routing gap. */
      let appended = false;
      for (const [id, route] of wanted) {
        if (isTrailing(id)) continue;

        const current = owned.get(id);
        if (current === undefined) {
          /* Append without changing operator-owned routes. */
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
        /* Trailing routes are replaced as one ordered block below. */
        if (wanted.has(id) || isTrailing(id)) continue;

        const url = idUrl(id);
        const response = await call("DELETE", url);
        if (!response.ok) throw adminFailed("DELETE", url, `answered ${String(response.status)}`);
      }

      if (!appended && trailingSettled(order, owned, trailing)) return;

      /* Replace the terminal block atomically in order; duplicate append would
         leave an older terminal route first. */
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

/** Returns the admin origin or refuses an invalid configured URL at startup. */
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

/** The `@id` the API route for one platform apex is addressed by. */
export function apiRouteId(domain: string): string {
  return `${API_ID_PREFIX}${domain}`;
}

/** The `@id` the denial guarding one platform apex is addressed by. */
export function apiDenyId(domain: string): string {
  return `${API_DENY_ID_PREFIX}${domain}`;
}

/** Renders terminal Caddy routes in match order. API apexes follow application
 * hosts; each uses denial before proxy to exclude protected paths. */
export function renderCaddyRoutes(
  desired: IngressDesired,
  upstreamHost = "127.0.0.1",
): CaddyRoute[] {
  const routes = desired.routes.map(({ host, backend }) => routeFor(host, backend, upstreamHost));

  const api = desired.api;
  if (api !== undefined) {
    const dial = `127.0.0.1:${String(api.port)}`;
    const denied = api.denied.flatMap(deniedPatterns);

    for (const host of api.hosts) {
      routes.push({
        "@id": apiDenyId(host),
        "match": [{ host: [host], path: denied }],
        /* Deny at ingress, without dialing the daemon. */
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

  return routes;
}

/** One route to the environment's current backend. */
function routeFor(host: string, backend: IngressBackend, upstreamHost: string): CaddyRoute {
  return {
    "@id": routeId(host),
    "match": [{ host: [host] }],
    "handle": [
      {
        handler: "reverse_proxy",
        /* Dial the configured runtime bind address. */
        upstreams: [{ dial: `${upstreamHost}:${String(backend.port)}` }],
      },
    ],
    "terminal": true,
  };
}

/**
 * Whether an `@id` this driver owns belongs to the block that must sit last: an
 * API apex or its denial.
 */
function isTrailing(id: string): boolean {
  return id.startsWith(API_ID_PREFIX) || id.startsWith(API_DENY_ID_PREFIX);
}

/** Whether the owned trailing block has the requested order and contents. */
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

/** Compares only fields this driver owns; Caddy may normalize or add others. */
function sameRoute(current: Record<string, unknown>, wanted: CaddyRoute): boolean {
  const projection = (route: Record<string, unknown>): string =>
    stableStringify({ match: route.match, handle: route.handle, terminal: route.terminal });

  return projection(current) === projection(wanted as unknown as Record<string, unknown>);
}

/** Matches a denied path and its subtree, not a similarly prefixed path. */
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
