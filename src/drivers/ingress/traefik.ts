/* Traefik pulls this driver's cached dynamic configuration from the node API.
   Operator routers remain in other providers; updates apply on Traefik's poll. */

import type { IngressBackend, IngressDesired, IngressDriver } from "../../core/types/ingress.ts";
import { assertHost } from "../../core/utils/host.ts";

/** Default entry point; omission would attach routes to every entry point. */
export const DEFAULT_ENTRY_POINT: string = "web";

/** Router/service namespace. Its underscore separator cannot occur in a host. */
export const TRAEFIK_KEY_PREFIX: string = "scafo_";

/** Namespaces for the platform API route and its denial route. */
export const TRAEFIK_API_PREFIX: string = `${TRAEFIK_KEY_PREFIX}api_`;
export const TRAEFIK_API_DENY_PREFIX: string = `${TRAEFIK_KEY_PREFIX}apideny_`;

/** Explicit priorities keep denied API paths ahead of the API route. */
export const API_PRIORITY: number = 2;
export const API_DENY_PRIORITY: number = 3;

/** Traefik's internal no-op backend makes denial routes active without dialing. */
export const NOOP_SERVICE: string = "noop@internal";

/** One router: which requests it matches, and what serves them. */
export interface TraefikRouter {
  /** Traefik's rule language; a host match is written with backticks. */
  rule: string;
  /** Name of the service in the same document, unqualified by a provider. */
  service: string;
  entryPoints: string[];
  /** Explicit only for API routes, whose denial must take precedence. */
  priority?: number;
}

/** A service that sends every request it is given to one place. */
export interface TraefikLoadBalancerService {
  loadBalancer: { servers: Array<{ url: string }> };
}

/** One service: where the requests its router matched are sent. */
export type TraefikService = TraefikLoadBalancerService;

/** `http` is omitted to withdraw every route from this provider. */
export interface TraefikDynamicConfig {
  http?: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
  };
}

export interface TraefikDriverOptions {
  /** EntryPoints the routers attach to. Defaults to {@link DEFAULT_ENTRY_POINT}. */
  entryPoints?: string[];
  /** Runtime bind address; must match the address process services dial. */
  upstreamHost?: string;
}

/** An {@link IngressDriver} whose configuration is served rather than pushed. */
export interface TraefikDriver extends IngressDriver {
  /** The configuration as of the last `apply`; what the daemon's route publishes. */
  snapshot(): TraefikDynamicConfig;
}

/** Builds an in-memory Traefik configuration driver. */
export function createTraefikDriver(opts?: TraefikDriverOptions): TraefikDriver {
  const upstreamHost = opts?.upstreamHost ?? "127.0.0.1";
  const entryPoints = opts?.entryPoints ?? [DEFAULT_ENTRY_POINT];

  /* Start empty: daemon restart must not retain routes to stopped processes. */
  let current: TraefikDynamicConfig = renderTraefikConfig({ routes: [] });

  return {
    apply(desired: IngressDesired): Promise<void> {
      /* The shared ingress seam is async; rendering is synchronous. */
      current = renderTraefikConfig(desired, entryPoints, upstreamHost);
      return Promise.resolve();
    },
    snapshot(): TraefikDynamicConfig {
      return current;
    },
  };
}

/** Renders deterministic dynamic configuration. API apexes use a higher-ranked
 * no-op denial route for excluded paths. Return `{}` rather than empty router
 * maps: Traefik otherwise retains its previous provider configuration. */
export function renderTraefikConfig(
  desired: IngressDesired,
  entryPoints: string[] = [DEFAULT_ENTRY_POINT],
  upstreamHost = "127.0.0.1",
): TraefikDynamicConfig {
  const routers: Record<string, TraefikRouter> = {};
  const services: Record<string, TraefikService> = {};

  for (const { host, backend } of [...desired.routes].sort((a, b) => compare(a.host, b.host))) {
    /* Hosts are embedded in rule syntax, so validate again at this boundary. */
    assertHost(host);

    const key = traefikKey(host);
    routers[key] = { rule: `Host(\`${host}\`)`, service: key, entryPoints: [...entryPoints] };

    services[key] = {
      loadBalancer: { servers: [{ url: upstreamUrl(backend, upstreamHost) }] },
    };
  }

  const api = desired.api;
  if (api !== undefined) {
    const daemon = `http://127.0.0.1:${String(api.port)}`;

    for (const host of [...api.hosts].sort(compare)) {
      assertHost(host);

      /* The API rule excludes denied paths; the higher-priority denial handles them. */
      const denied = api.denied.flatMap(deniedRules);

      routers[traefikApiDenyKey(host)] = {
        rule: `Host(\`${host}\`) && (${denied.join(" || ")})`,
        service: NOOP_SERVICE,
        entryPoints: [...entryPoints],
        priority: API_DENY_PRIORITY,
      };

      const key = traefikApiKey(host);
      routers[key] = {
        rule: [`Host(\`${host}\`)`, ...denied.map((rule) => `!${rule}`)].join(" && "),
        service: key,
        entryPoints: [...entryPoints],
        priority: API_PRIORITY,
      };
      services[key] = { loadBalancer: { servers: [{ url: daemon }] } };
    }
  }

  /* Empty maps make Traefik retain stale provider configuration. */
  if (Object.keys(routers).length === 0) return {};

  return { http: { routers, services } };
}

/** The router and service name the routing for `host` is written under. */
export function traefikKey(host: string): string {
  return `${TRAEFIK_KEY_PREFIX}${host}`;
}

/** The router and service name the API at one platform apex is written under. */
export function traefikApiKey(domain: string): string {
  return `${TRAEFIK_API_PREFIX}${domain}`;
}

/** The router name the denial guarding one platform apex is written under. */
export function traefikApiDenyKey(domain: string): string {
  return `${TRAEFIK_API_DENY_PREFIX}${domain}`;
}

/** Matches a denied path and its subtree, not a similarly prefixed path. */
function deniedRules(prefix: string): string[] {
  return [`Path(\`${prefix}\`)`, `PathPrefix(\`${prefix}/\`)`];
}

/* Dial the configured runtime bind address. */
function upstreamUrl(backend: IngressBackend, upstreamHost: string): string {
  return `http://${upstreamHost}:${String(backend.port)}`;
}

/* Code-unit ordering, so the document does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
