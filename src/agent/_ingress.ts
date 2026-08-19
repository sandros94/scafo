/*
 * Internal: telling the ingress what this node currently serves — by pushing it
 * to one that is called, or by holding it for one that asks.
 */

import type { DesiredEnvironment } from "../core/placement/reconcile.ts";
import { renderRoutes, type RouteClaim } from "../core/placement/routes.ts";
import type { IngressDriver, PullingIngressDriver } from "../core/types/ingress.ts";
import type { RuntimeProcess } from "../core/types/runtime.ts";
import type { AgentContext } from "./app.ts";

/**
 * Whether this ingress is one the agent has to publish a configuration for.
 *
 * Structural rather than a name comparison, and it has to be: the agent may not
 * import a driver — that is the layering — so it cannot ask which one this is,
 * and it does not need to. What decides whether a configuration route has
 * anything to serve is whether the driver holds one.
 */
export function isPullingIngress(driver: IngressDriver): driver is PullingIngressDriver {
  return typeof (driver as Partial<PullingIngressDriver>).snapshot === "function";
}

/**
 * Renders the routing for what this node has ready and converges the ingress on
 * it. Does nothing when the node has no ingress configured — its processes still
 * run, they are simply not reachable from outside the node.
 *
 * Called after every reconcile pass rather than only when something changed:
 * `IngressDriver.apply` is idempotent, and a pass that re-states the routing is
 * also what repairs an ingress that was restarted or edited underneath the node.
 */
export async function applyIngress(
  agent: AgentContext,
  desired: DesiredEnvironment[],
  processes: RuntimeProcess[],
): Promise<void> {
  const ingress = agent.ingress;
  if (ingress === undefined) return;

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

  await ingress.apply(
    renderRoutes({
      platformDomains: agent.config.platformDomains,
      environments: desired.map((entry) => ({ project: entry.project, env: entry.env })),
      processes,
      claims,
    }),
  );
}
