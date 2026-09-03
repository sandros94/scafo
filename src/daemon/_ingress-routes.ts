/*
 * Internal: the `/v1/ingress/routes` routes an ingress polls the fleet's routing
 * from — the generic document, and one per format an ingress reads natively,
 * all under the one prefix the fleet's API denies at its public apex.
 */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import { preferNode } from "../core/placement/fleet-routes.ts";
import type { FleetRouting } from "../core/types/ingress.ts";
import type { DaemonContext } from "./app.ts";
import type { StorageService } from "./storage.ts";

/** What `prefer` is spelled as when the ingress means the node it is asking. */
export const PREFER_SELF: string = "self";

/**
 * Adds the routing routes to `app`, each behind the same token as storage: what
 * an ingress presents to read the fleet's routing is what it presents to keep
 * its certificates, one credential for the one thing that sits in front of the
 * fleet.
 *
 * `?prefer=<node>` puts that node's upstreams first on every route, and
 * `?prefer=self` means the node being asked — what a colocated ingress says, so
 * it never has to know the node's id. A node that serves nothing is preferred
 * to no effect.
 */
export function registerIngressRoutes(
  app: H3,
  daemon: DaemonContext,
  storage: StorageService,
): void {
  const admitted: Middleware = (event, next) => {
    storage.admit(event);
    return next();
  };
  const guarded = { middleware: [admitted] };

  app.get("/v1/ingress/routes", (event): FleetRouting => routing(daemon, event).routing, guarded);

  app.get(
    "/v1/ingress/routes/:format",
    (event): unknown => {
      const name = event.context.params?.format ?? "";
      const format = daemon.ingressFormats?.[name];
      if (format === undefined) {
        throw new ScafoError("not-found", "No such ingress format", {
          detail:
            `this node renders its routing as ${formats(daemon)}; ` +
            `"/v1/ingress/routes" is the generic document`,
        });
      }
      const asked = routing(daemon, event);
      return format(asked.routing, { prefer: asked.prefer });
    },
    guarded,
  );
}

/**
 * The fleet's routing as of the last reconcile pass, ordered for whoever asks,
 * with the node it was ordered for: a format that can say more than an order
 * (Traefik's failover) needs the name, not just the arrangement.
 */
function routing(
  daemon: DaemonContext,
  event: H3Event,
): { routing: FleetRouting; prefer?: string } {
  const current = daemon.reconciler?.fleetRouting() ?? { v: 1, routes: [] };
  const asked = event.url.searchParams.get("prefer");
  if (asked === null || asked === "") return { routing: current };
  const prefer = asked === PREFER_SELF ? daemon.nodeId : asked;
  return { routing: preferNode(current, prefer), prefer };
}

function formats(daemon: DaemonContext): string {
  const names = Object.keys(daemon.ingressFormats ?? {}).sort();
  return names.length === 0
    ? "nothing but the generic document"
    : names.map((n) => `"${n}"`).join(", ");
}
