/* Traefik's `http` provider polls the node API for the document rendered here.
   Operator routers remain in other providers; updates apply on Traefik's poll. */

import type { FleetRouting, FleetUpstream } from "../../core/types/ingress.ts";
import { assertHost, splitHostLabel, wildcardBase, wildcardHost } from "../../core/utils/host.ts";

/** Default entry point; omission would attach routes to every entry point. */
export const DEFAULT_ENTRY_POINT: string = "web";

/** Router/service namespace. Its underscore separator cannot occur in a host. */
export const TRAEFIK_KEY_PREFIX: string = "scafo_";

/** Namespaces for the platform API route and its denial route. */
export const TRAEFIK_API_PREFIX: string = `${TRAEFIK_KEY_PREFIX}api_`;
export const TRAEFIK_API_DENY_PREFIX: string = `${TRAEFIK_KEY_PREFIX}apideny_`;

/** Namespace for what a claim made WITH its subdomains covers. */
export const TRAEFIK_WILDCARD_PREFIX: string = `${TRAEFIK_KEY_PREFIX}wild_`;

/** Explicit priorities keep denied API paths ahead of the API route. */
export const API_PRIORITY: number = 2;
export const API_DENY_PRIORITY: number = 3;

/**
 * The lowest priority this document writes, so every exact `Host` router wins.
 *
 * Traefik's default priority is the LENGTH of the rule, which would put a long
 * `HostRegexp` ahead of a short `Host` — precisely backwards for a fallback.
 * One is below every rule there is, including the API routes, which are explicit
 * for the same reason.
 */
export const WILDCARD_PRIORITY: number = 1;

/** Traefik's internal no-op backend makes denial routes active without dialing. */
export const NOOP_SERVICE: string = "noop@internal";

/** The one middleware every router carries: retry the next upstream on a dial failure. */
export const RETRY_MIDDLEWARE: string = `${TRAEFIK_KEY_PREFIX}retry`;

/** Where an application process says whether it is up. */
export const APP_HEALTH_PATH: string = "/.well-known/celld/health";

/** Where a node's daemon says whether it is up. */
export const API_HEALTH_PATH: string = "/.well-known/scafo/health";

/** How often Traefik asks each upstream, and how long it waits for the answer. */
export const HEALTH_INTERVAL: string = "10s";
export const HEALTH_TIMEOUT: string = "3s";

/** Attempts a request gets before Traefik gives up on every upstream. */
export const RETRY_ATTEMPTS: number = 3;

/** One certificate subject: the name it is issued for, and what else it covers. */
export interface TraefikCertificateDomain {
  main: string;
  sans: string[];
}

/**
 * What a router says about its own certificate.
 *
 * `certResolver` alone lets Traefik read the subject off the router's `Host`
 * rule. `domains` states it instead, which is the only way a `HostRegexp`
 * router — a rule no name can be read out of — gets a certificate at all, and
 * the way every host under one base shares ONE wildcard certificate rather than
 * each minting its own.
 */
export interface TraefikRouterTls {
  certResolver: string;
  domains?: TraefikCertificateDomain[];
}

/** One router: which requests it matches, and what serves them. */
export interface TraefikRouter {
  /** Traefik's rule language; a host match is written with backticks. */
  rule: string;
  /** Name of the service in the same document, unqualified by a provider. */
  service: string;
  entryPoints: string[];
  middlewares?: string[];
  /** Explicit only for API routes, whose denial must take precedence. */
  priority?: number;
  /** Absent unless the node was told a certificate resolver to name. */
  tls?: TraefikRouterTls;
}

/** A service that spreads requests over its servers, dropping the ones its check finds down. */
export interface TraefikLoadBalancerService {
  loadBalancer: {
    servers: Array<{ url: string }>;
    healthCheck: { path: string; interval: string; timeout: string; hostname?: string };
  };
}

/** A service that uses one service until it has no healthy server, then another. */
export interface TraefikFailoverService {
  failover: { service: string; fallback: string };
}

/** One service: where the requests its router matched are sent. */
export type TraefikService = TraefikLoadBalancerService | TraefikFailoverService;

export interface TraefikMiddleware {
  retry: { attempts: number };
}

/** `http` is omitted to withdraw every route from this provider. */
export interface TraefikDynamicConfig {
  http?: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
    middlewares: Record<string, TraefikMiddleware>;
  };
}

export interface TraefikRenderOptions {
  /** EntryPoints the routers attach to. Defaults to {@link DEFAULT_ENTRY_POINT}. */
  entryPoints?: string[];
  /**
   * The node whose upstreams are used while healthy, the others only when it
   * is not: what a colocated Traefik names, so traffic stays on its machine.
   * Absent spreads every request over every upstream, which is what an ingress
   * in front of the whole fleet wants.
   */
  prefer?: string;
  /**
   * Certificate resolver from the operator's own STATIC Traefik configuration.
   * Absent writes no `tls` at all, and the document is what it was before this
   * existed: whatever the operator configured elsewhere decides.
   */
  certResolver?: string;
}

/**
 * Renders the fleet's routing as Traefik dynamic configuration.
 *
 * Every host becomes a router and a service over the upstreams answering on
 * it, each checked at its health path. A `*.base` entry becomes a `HostRegexp`
 * router for exactly one label under that base, at a priority below every exact
 * `Host` router, so a name somebody claimed exactly always wins over the
 * wildcard that encloses it. With a preferred node, that node's
 * upstreams are used while healthy and the others only when they are not — a
 * `failover` service, which is what "prefer" means and what a weighting would
 * not do. Without one, requests are spread over every upstream.
 *
 * With a certificate resolver named, every router also says where its
 * certificate comes from, and a host one of the document's wildcard bases
 * covers names that base's wildcard rather than itself — see
 * {@link certificatesOf}. Without one, nothing here mentions TLS.
 *
 * Return `{}` rather than empty maps: Traefik otherwise retains its previous
 * provider configuration.
 */
export function renderTraefikConfig(
  routing: FleetRouting,
  opts?: TraefikRenderOptions,
): TraefikDynamicConfig {
  const entryPoints = opts?.entryPoints ?? [DEFAULT_ENTRY_POINT];
  const tlsOf = certificatesOf(routing, opts?.certResolver);
  const routers: Record<string, TraefikRouter> = {};
  const services: Record<string, TraefikService> = {};

  for (const route of [...routing.routes].sort((a, b) => compare(a.host, b.host))) {
    const base = wildcardBase(route.host);
    /* Hosts are embedded in rule syntax, so validate again at this boundary. */
    assertHost(base ?? route.host);

    const key = base === null ? traefikKey(route.host) : traefikWildcardKey(base);
    routers[key] = {
      /* One label under the base and no more, which is what the claim covers. */
      rule:
        base === null ? `Host(\`${route.host}\`)` : `HostRegexp(\`^[^.]+\\.${escaped(base)}$\`)`,
      service: key,
      entryPoints: [...entryPoints],
      middlewares: [RETRY_MIDDLEWARE],
      ...(base === null ? {} : { priority: WILDCARD_PRIORITY }),
      ...tlsOf(route.host),
    };
    Object.assign(
      services,
      servicesOf(key, route.upstreams, opts?.prefer, {
        path: APP_HEALTH_PATH,
        /* The health check asks one upstream, so it carries a real name: the
           base itself, never the pattern that stands for every name under it. */
        hostname: base ?? route.host,
      }),
    );
  }

  const api = routing.api;
  if (api !== undefined) {
    for (const host of [...api.hosts].sort(compare)) {
      assertHost(host);

      /* The API rule excludes denied paths; the higher-priority denial handles them. */
      const denied = api.denied.flatMap(deniedRules);

      /* The denial carries the same `tls` as the route it guards. A router
         without one matches only plain HTTP, so a denial that left it out would
         stand aside on the TLS entryPoint and let `/v1/storage` through on the
         one name this document publishes it nowhere else on. */
      routers[traefikApiDenyKey(host)] = {
        rule: `Host(\`${host}\`) && (${denied.join(" || ")})`,
        service: NOOP_SERVICE,
        entryPoints: [...entryPoints],
        priority: API_DENY_PRIORITY,
        ...tlsOf(host),
      };

      const key = traefikApiKey(host);
      routers[key] = {
        rule: [`Host(\`${host}\`)`, ...denied.map((rule) => `!${rule}`)].join(" && "),
        service: key,
        entryPoints: [...entryPoints],
        middlewares: [RETRY_MIDDLEWARE],
        priority: API_PRIORITY,
        ...tlsOf(host),
      };
      Object.assign(
        services,
        servicesOf(key, api.upstreams, opts?.prefer, { path: API_HEALTH_PATH }),
      );
    }
  }

  /* Empty maps make Traefik retain stale provider configuration. */
  if (Object.keys(routers).length === 0) return {};

  return {
    http: {
      routers,
      services,
      middlewares: { [RETRY_MIDDLEWARE]: { retry: { attempts: RETRY_ATTEMPTS } } },
    },
  };
}

/** The router and service name the routing for `host` is written under. */
export function traefikKey(host: string): string {
  return `${TRAEFIK_KEY_PREFIX}${host}`;
}

/** The router and service name a base's covered subdomains are written under. */
export function traefikWildcardKey(base: string): string {
  return `${TRAEFIK_WILDCARD_PREFIX}${base}`;
}

/** The router and service name the API at one platform apex is written under. */
export function traefikApiKey(domain: string): string {
  return `${TRAEFIK_API_PREFIX}${domain}`;
}

/** The router name the denial guarding one platform apex is written under. */
export function traefikApiDenyKey(domain: string): string {
  return `${TRAEFIK_API_DENY_PREFIX}${domain}`;
}

/**
 * What every router of this document says about its certificate, given the host
 * it matches — or nothing at all, when no resolver was named.
 *
 * A host one of the document's {@link FleetRouting.wildcards} bases covers
 * names THE BASE and its `*.BASE`, so the base, its environments, every other
 * name the catch-all answers and the fleet's own apex all ask for one
 * certificate instead of one each. Anything else — a host claimed without its
 * subdomains — names the resolver alone and lets Traefik read the subject off
 * the `Host` rule, which is the one it would issue for anyway.
 */
function certificatesOf(
  routing: FleetRouting,
  certResolver: string | undefined,
): (host: string) => { tls?: TraefikRouterTls } {
  if (certResolver === undefined) return () => ({});

  const bases = new Set(routing.wildcards ?? []);
  return (host) => {
    const base = coveringBase(host, bases);
    return {
      tls: {
        certResolver,
        ...(base === null ? {} : { domains: [{ main: base, sans: [wildcardHost(base)] }] }),
      },
    };
  };
}

/**
 * The base whose wildcard certificate covers `host`, or null when none does.
 *
 * A `*.BASE` key is covered by its own base and by nothing else: a certificate
 * for the base ABOVE it covers one label, and the key stands for the label
 * below that.
 */
function coveringBase(host: string, bases: Set<string>): string | null {
  const wildcard = wildcardBase(host);
  if (wildcard !== null) return bases.has(wildcard) ? wildcard : null;
  if (bases.has(host)) return host;

  const split = splitHostLabel(host);
  return split !== null && bases.has(split.base) ? split.base : null;
}

/**
 * The service `key` names, and the ones it is built from: one load balancer,
 * or — when a preferred node answers here and it is not the only one — a
 * failover from that node's balancer to a balancer over the rest.
 */
function servicesOf(
  key: string,
  upstreams: FleetUpstream[],
  prefer: string | undefined,
  check: { path: string; hostname?: string },
): Record<string, TraefikService> {
  const local = upstreams.filter((upstream) => upstream.node === prefer);
  const peers = upstreams.filter((upstream) => upstream.node !== prefer);
  if (local.length === 0 || peers.length === 0) return { [key]: balancer(upstreams, check) };

  return {
    [key]: { failover: { service: `${key}_local`, fallback: `${key}_peers` } },
    [`${key}_local`]: balancer(local, check),
    [`${key}_peers`]: balancer(peers, check),
  };
}

function balancer(
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

/** A host inside a Go regexp: only its dots mean anything there. */
function escaped(host: string): string {
  return host.replaceAll(".", "\\.");
}

/** Matches a denied path and its subtree, not a similarly prefixed path. */
function deniedRules(prefix: string): string[] {
  return [`Path(\`${prefix}\`)`, `PathPrefix(\`${prefix}/\`)`];
}

/* Code-unit ordering, so the document does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
