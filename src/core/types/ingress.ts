/*
 * The seam between placement and whatever puts a node's ready processes on the
 * public network. Core describes the contract; a driver
 * (`scalo/drivers/ingress/caddy`) implements it, and the reconcile loop calls it
 * with the routing it renders after every pass.
 */

/** One routable backend: a ready runtime process serving a build. */
export interface IngressBackend {
  project: string;
  env: string;
  build: string;
  /** Loopback port the process answers public traffic on. */
  port: number;
}

/** The whole of the routing an ingress should present for this node. */
export interface IngressDesired {
  /**
   * Host to backend, sorted by host. Hosts are fully qualified: a host label
   * under one of the platform domains, or a custom domain an environment claimed.
   */
  routes: Array<{ host: string; backend: IngressBackend }>;
}

/** Routes public traffic to the processes a node runs. */
export interface IngressDriver {
  /**
   * Converges the ingress to exactly this routing and nothing beyond it: hosts
   * that are no longer desired stop being served. Idempotent, so a caller may
   * apply the same routing after every reconcile pass.
   */
  apply(desired: IngressDesired): Promise<void>;
}

/**
 * An ingress that is READ rather than written to: `apply` renders its
 * configuration and caches it, and the ingress itself polls the agent for it.
 *
 * The distinction is the ingress's own, not scalo's. An ingress with an admin
 * API (Caddy) is converged by calling it, and `apply` is where the work happens.
 * An ingress configured by a provider it polls (Traefik's `http` provider) can
 * only be told anything by being asked, so the node has to publish what it would
 * otherwise have pushed — which is what {@link snapshot} is for, and why the
 * agent serves a route per such ingress.
 *
 * `unknown` because the document's shape belongs to the ingress that reads it;
 * the agent only ever hands it back as JSON.
 */
export interface PullingIngressDriver extends IngressDriver {
  /** The configuration as of the last {@link IngressDriver.apply}. */
  snapshot(): unknown;
}
