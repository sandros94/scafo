/* Pure fleet-wide routing from what every live node says it serves. */

import type { FleetApiRouting, FleetRoute, FleetRouting, FleetUpstream } from "../types/ingress.ts";
import type { ApplicationRecord, NodeRecord } from "../types/registry.ts";
import { formatHostPort } from "../utils/host.ts";
import { isNodeLive } from "../registry/nodes.ts";
import { API_DENIED_PREFIXES, hostUnder } from "./routes.ts";

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
 * First writer wins between route classes: application hosts, then claims, in
 * code-unit order, so a claim can never shadow a platform host.
 */
export function renderFleetRouting(input: RenderFleetRoutingInput): FleetRouting {
  const live = input.nodes
    .filter((node) => isNodeLive(node, input.now, windowOf(input)))
    .sort((a, b) => compare(a.id, b.id));

  const applications = [...input.applications].sort((a, b) => compare(a.name, b.name));

  const routes = new Map<string, FleetRoute>();
  const add = (host: string | null, route: Omit<FleetRoute, "host">): void => {
    if (host === null || routes.has(host)) return;
    routes.set(host, { host, ...route });
  };

  for (const application of applications) {
    const upstreams = upstreamsOf(live, application.name);
    if (upstreams.length === 0) continue;

    for (const domain of input.platformDomains) {
      add(hostUnder(domain, application.name), { application: application.name, upstreams });
    }
  }

  const claims = applications
    .flatMap((application) =>
      application.domains.map((host) => ({ host, application: application.name })),
    )
    .sort((a, b) => compare(a.host, b.host));
  for (const claim of claims) {
    const upstreams = upstreamsOf(live, claim.application);
    if (upstreams.length > 0) add(claim.host, { application: claim.application, upstreams });
  }

  const api = input.api === true ? apiRouting(input.platformDomains, live, routes) : undefined;

  return {
    v: 1,
    routes: [...routes.keys()].sort(compare).map((host) => routes.get(host) as FleetRoute),
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
