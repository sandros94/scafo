/* Pure fleet-wide routing from what every live node says it serves. */

import type { FleetApiRouting, FleetRoute, FleetRouting, FleetUpstream } from "../types/ingress.ts";
import type { ApplicationRecord, NodeRecord } from "../types/registry.ts";
import { formatHostPort, wildcardBase } from "../utils/host.ts";
import { isNodeLive } from "../registry/nodes.ts";
import { hostBindings } from "./host-bindings.ts";
import { API_DENIED_PREFIXES } from "./routes.ts";

export interface RenderFleetRoutingInput {
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /**
   * Every application the fleet may route to: placed, deployed, not retired.
   * Its record carries the custom domains claimed for it.
   */
  applications: ApplicationRecord[];
  /** Every registered node; the renderer keeps the live ones. */
  nodes: NodeRecord[];
  /** What "live" is judged against. */
  now: Date;
  /** Overrides the liveness window nodes are judged by. */
  livenessWindowMs?: number;
  /** Publish the fleet API at the platform apexes. */
  api?: boolean;
}

/**
 * Renders the routing of the whole fleet.
 *
 * An application's hosts — its name under every platform domain, and every
 * domain claimed for it — all point at the same upstreams: every live,
 * non-draining node whose record says it serves that application, at the node's
 * advertised address and the port it named. A host nobody serves is left out;
 * an ingress that has nothing to send traffic to should not accept it.
 *
 * Draining and stale nodes are dropped here rather than left to health checks.
 * A node that said it is leaving is one the ingress should stop choosing NOW,
 * and one that stopped beating may be gone in a way no health check reports
 * quickly — a black-holed address times out, it does not refuse.
 *
 * WHICH HOST IS WHOSE IS NOT DECIDED HERE. {@link hostBindings} states that
 * once, in precedence order — application hosts, then claims, then what a claim
 * made WITH its subdomains covers — and this walks it and publishes the entries
 * something is currently answering. A host nobody serves is skipped rather than
 * taken, so an unserved environment falls through to the wildcard that encloses
 * it, exactly as the next binding for that host says.
 */
export function renderFleetRouting(input: RenderFleetRoutingInput): FleetRouting {
  const live = input.nodes
    .filter((node) => isNodeLive(node, input.now, windowOf(input)))
    .sort((a, b) => compare(a.id, b.id));

  /* One walk of the bindings asks about the same application many times. */
  const served = new Map<string, FleetUpstream[]>();
  const upstreamsFor = (application: string): FleetUpstream[] => {
    const held = served.get(application);
    if (held !== undefined) return held;

    const found = upstreamsOf(live, application);
    served.set(application, found);
    return found;
  };

  const routes = new Map<string, FleetRoute>();
  for (const binding of hostBindings({
    platformDomains: input.platformDomains,
    applications: input.applications,
  })) {
    if (routes.has(binding.host)) continue;

    const upstreams = upstreamsFor(binding.application);
    if (upstreams.length === 0) continue;
    routes.set(binding.host, {
      host: binding.host,
      application: binding.application,
      upstreams: [...upstreams],
    });
  }

  const api = input.api === true ? apiRouting(input.platformDomains, live, routes) : undefined;
  const wildcards = wildcardBases(input.platformDomains, routes);

  return {
    v: 1,
    routes: [...routes.keys()].sort(compare).map((host) => routes.get(host) as FleetRoute),
    ...(wildcards.length === 0 ? {} : { wildcards }),
    ...(api === undefined ? {} : { api }),
  };
}

/**
 * The same routing with one node's upstreams put first on every route: what a
 * colocated ingress asks for, so traffic that can be answered on this machine
 * is, and leaves it only when the local process is unhealthy. Order among the
 * others is kept. A node that serves nothing changes nothing.
 */
export function preferNode(routing: FleetRouting, nodeId: string): FleetRouting {
  const first = (upstreams: FleetUpstream[]): FleetUpstream[] => [
    ...upstreams.filter((upstream) => upstream.node === nodeId),
    ...upstreams.filter((upstream) => upstream.node !== nodeId),
  ];
  return {
    ...routing,
    routes: routing.routes.map((route) => ({ ...route, upstreams: first(route.upstreams) })),
    ...(routing.api === undefined
      ? {}
      : { api: { ...routing.api, upstreams: first(routing.api.upstreams) } }),
  };
}

/**
 * The bases a `*.BASE` certificate is wanted for, sorted and without repeats.
 *
 * Every platform domain, because an application is always served at its name
 * one label under one — whether anything is deployed right now or not, since an
 * ingress obtains a certificate before it can answer the first request on it.
 * Then the base of every wildcard KEY this render published, which is a claim
 * made with its subdomains whose holder something is currently answering for:
 * the entry is the question, so the answer cannot disagree with it.
 */
function wildcardBases(platformDomains: string[], routes: Map<string, FleetRoute>): string[] {
  const bases = new Set(platformDomains);
  for (const host of routes.keys()) {
    const base = wildcardBase(host);
    if (base !== null) bases.add(base);
  }
  return [...bases].sort(compare);
}

/** Every live node serving `application`, in node order, at the port it named. */
function upstreamsOf(live: NodeRecord[], application: string): FleetUpstream[] {
  const upstreams: FleetUpstream[] = [];
  for (const node of live) {
    const served = node.serving?.[application];
    if (served === undefined) continue;
    upstreams.push({
      node: node.id,
      address: formatHostPort(node.addresses.internal, served.port),
    });
  }
  return upstreams;
}

/** API apexes not already claimed by an application route, answered by every live node. */
function apiRouting(
  platformDomains: string[],
  live: NodeRecord[],
  routes: Map<string, FleetRoute>,
): FleetApiRouting {
  return {
    hosts: [...new Set(platformDomains.filter((domain) => !routes.has(domain)))].sort(compare),
    upstreams: live.map((node) => ({
      node: node.id,
      address: formatHostPort(node.addresses.internal, node.addresses.apiPort),
    })),
    denied: [...API_DENIED_PREFIXES],
  };
}

function windowOf(input: RenderFleetRoutingInput): { windowMs?: number } {
  return input.livenessWindowMs === undefined ? {} : { windowMs: input.livenessWindowMs };
}

/* Code-unit ordering, so the routing does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
