/*
 * Internal: what this node currently serves, rendered once per reconcile pass for
 * the one reader left that needs it node-locally — the access counters.
 */

import type { ApplicationRecord } from "../core/types/registry.ts";
import { renderRoutes, type RouteClaim } from "../core/placement/routes.ts";
import type { IngressDesired } from "../core/types/ingress.ts";
import type { RuntimeProcess } from "../core/types/runtime.ts";
import type { DaemonContext } from "./app.ts";
import { parseHostPort } from "./config.ts";

/** What one pass ended with, as this node's own routing is rendered from it. */
export interface IngressInput {
  /** Applications this node serves, as the records this pass resolved for them. */
  desired: ApplicationRecord[];
  /** Processes this node is running and routes. */
  processes: RuntimeProcess[];
}

/**
 * Renders the routing for what this node has running and tells the counters whose
 * host is whose. Returns the routing, which is also what makes this readable in a
 * test without a counter attached.
 *
 * NOTHING IS PUSHED ANYWHERE. Both ingresses read the fleet's routing off the
 * node API — `/v1/ingress/routes` for Caddy's `scafo` upstreams module,
 * `/v1/ingress/routes/traefik` for Traefik's http provider — so a pass converges
 * the ingress by leaving the document it polls correct, and a node with no
 * ingress in front of it simply runs its processes without routing to them.
 *
 * The routing carries the daemon's own port only when the fleet API is public.
 */
export function recordRouting(daemon: DaemonContext, input: IngressInput): IngressDesired {
  const { desired, processes } = input;

  /* An application record mirrors every domain claimed for it, so the custom
     domains come along with the desired state and cost no extra registry reads.
     A claim the application does not list yet is one whose claim call has not
     finished, and which nothing should be routed to. */
  const claims: RouteClaim[] = [];
  for (const entry of desired) {
    for (const host of entry.domains) claims.push({ host, application: entry.name });
  }

  const port = parseHostPort(daemon.config.node.listen, "node.listen").port;
  const routing = renderRoutes({
    platformDomains: daemon.config.platformDomains,
    applications: desired,
    processes,
    claims,
    /* The same daemon, at the same port, reached under a different contract: the
       platform apexes serve the fleet's API rather than an application, and the
       ingress keeps the colocated prefixes off them. Omitted outright when the
       operator turned that off, so the routing is the one scafo rendered before
       the apex answered anything. */
    ...(daemon.config.api.public ? { api: { port } } : {}),
  });

  /* THIS IS ALSO WHAT SAYS WHOSE HOST IS WHOSE. The counters read the ingress's
     access log, and only this knows that a custom domain belongs to an
     application — a second reading of that would be a second routing. */
  daemon.ingressCounters?.observeRouting({ routes: routing.routes, claims });

  return routing;
}
