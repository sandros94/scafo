/*
 * Internal: telling the ingress what this node currently serves — by pushing it
 * to one that is called, or by holding it for one that asks.
 */

import type { DesiredEnvironment } from "../core/placement/reconcile.ts";
import { renderRoutes, type RouteClaim } from "../core/placement/routes.ts";
import type { IngressDriver, PullingIngressDriver } from "../core/types/ingress.ts";
import type { RuntimeProcess } from "../core/types/runtime.ts";
import type { ParkedEnvironment } from "./_desired.ts";
import type { DaemonContext } from "./app.ts";
import { parseHostPort } from "./config.ts";

/**
 * Whether this ingress is one the daemon has to publish a configuration for.
 *
 * Structural rather than a name comparison, and it has to be: the daemon may not
 * import a driver — that is the layering — so it cannot ask which one this is,
 * and it does not need to. What decides whether a configuration route has
 * anything to serve is whether the driver holds one.
 */
export function isPullingIngress(driver: IngressDriver): driver is PullingIngressDriver {
  return typeof (driver as Partial<PullingIngressDriver>).snapshot === "function";
}

/** What one pass ended with, as the ingress is told about it. */
export interface IngressInput {
  /** Environments this node serves, with the builds it resolved for them. */
  desired: DesiredEnvironment[];
  /** Processes this node is running; only the ready ones are routable. */
  processes: RuntimeProcess[];
  /**
   * Environments this node reads as parked. Their hosts are routed to the node's
   * own daemon instead of to a process, so that the request asking for one is
   * what wakes it.
   */
  parked: ParkedEnvironment[];
}

/**
 * Renders the routing for what this node has ready and converges the ingress on
 * it. Does nothing when the node has no ingress configured — its processes still
 * run, they are simply not reachable from outside the node.
 *
 * Called after every reconcile pass rather than only when something changed:
 * `IngressDriver.apply` is idempotent, and a pass that re-states the routing is
 * also what repairs an ingress that was restarted or edited underneath the node.
 *
 * The routing always carries the daemon's own port, because the daemon is what
 * answers for a parked host and for every host under a platform domain that
 * nothing else claims. Only the PORT travels: an ingress that routes to this
 * node's daemon is on this node, so the host is always loopback.
 */
export async function applyIngress(daemon: DaemonContext, input: IngressInput): Promise<void> {
  const ingress = daemon.ingress;
  if (ingress === undefined) return;

  const { desired, processes, parked } = input;

  /* An environment record mirrors every domain claimed for it, so the custom
     domains come along with the desired state and cost no extra registry reads.
     A claim the environment does not list yet is one whose claim call has not
     finished, and which nothing should be routed to. */
  const claims: RouteClaim[] = [];
  for (const entry of desired) {
    for (const host of entry.env.domains) {
      claims.push({ host, project: entry.project, environment: entry.env.name });
    }
  }

  const port = parseHostPort(daemon.config.node.listen, "node.listen").port;
  const routing = renderRoutes({
    platformDomains: daemon.config.platformDomains,
    environments: desired.map((entry) => ({ project: entry.project, env: entry.env })),
    processes,
    claims,
    wake: { port, parked },
    /* The same daemon, at the same port, reached under a different contract: the
       platform apexes serve the fleet's API rather than an application, and the
       ingress keeps the colocated prefixes off them. Omitted outright when the
       operator turned that off, so the routing is the one scafo rendered before
       the apex answered anything. */
    ...(daemon.config.api.public ? { api: { port } } : {}),
  });

  /* WHAT THE INGRESS IS ABOUT TO BE TOLD IS ALSO WHAT SAYS WHOSE HOST IS WHOSE.
     The counters read the ingress's access log, and only this knows that a
     custom domain belongs to an environment and which environment a build's own
     hash host is a leg of — a second reading of that would be a second routing.
     Handed over BEFORE the ingress call, so a pass whose ingress cannot be
     reached still attributes the traffic that ingress is still serving. */
  daemon.ingressCounters?.observeRouting({ routes: routing.routes, claims });

  await ingress.apply(routing);
}
