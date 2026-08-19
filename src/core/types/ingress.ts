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
