/*
 * The seam between placement and whatever puts a node's running processes on the
 * public network. Core describes the contract; a driver
 * (`scafo/drivers/ingress/caddy`) implements it, and the reconcile loop calls it
 * with the routing it renders after every pass.
 */

/** One routable backend: a running runtime process serving an environment. */
export interface IngressBackend {
  project: string;
  env: string;
  /** Loopback port the process answers public traffic on. */
  port: number;
}

/** One host and the current environment process that answers on it. */
export interface IngressRoute {
  host: string;
  backend: IngressBackend;
}

/**
 * The fleet's own API, served at each platform domain's BARE APEX so that a CI
 * job, a CLI or a dashboard reaches any node of the installation at one
 * well-known name — the registry is in the bucket, so any node answers any call.
 *
 * AN EXPLICIT ROUTE PER APEX, which is also why the apex has no wildcard
 * certificate and mints its own.
 *
 * {@link ApiRouting.denied} IS THE SECURITY RULE OF THIS SURFACE AND A DRIVER
 * MUST ENFORCE IT AT THE INGRESS, not by trusting the daemon behind it: a request
 * for one of these prefixes on one of these hosts must be answered by the
 * ingress itself and must never be proxied. Both prefixes are matched at a path
 * SEGMENT boundary — the prefix exactly, or the prefix followed by `/` and
 * anything — which is what the two implemented drivers were pinned to.
 */
export interface ApiRouting {
  /** Loopback port the daemon answers on. */
  port: number;
  /** Bare platform-domain apexes routed to the daemon, sorted. */
  hosts: string[];
  /** Path prefixes that must NEVER be proxied through {@link ApiRouting.hosts}. */
  denied: string[];
}

/** The whole of the routing an ingress should present for this node. */
export interface IngressDesired {
  /**
   * Host to backend, sorted by host. Hosts are fully qualified: a host label
   * under one of the platform domains, or a custom domain an environment claimed.
   */
  routes: IngressRoute[];
  /**
   * The platform apexes serving the fleet's API, when this node publishes it.
   * Absent when `api.public` is off, which is the routing scafo renders when the
   * apex answers nothing at all.
   *
   * These entries sit below every {@link IngressDesired.routes} host: a renderer
   * leaves an apex out entirely when an application already answers on it.
   */
  api?: ApiRouting;
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
 * configuration and caches it, and the ingress itself polls the daemon for it.
 *
 * The distinction is the ingress's own, not scafo's. An ingress with an admin
 * API (Caddy) is converged by calling it, and `apply` is where the work happens.
 * An ingress configured by a provider it polls (Traefik's `http` provider) can
 * only be told anything by being asked, so the node has to publish what it would
 * otherwise have pushed — which is what {@link snapshot} is for, and why the
 * daemon serves a route per such ingress.
 *
 * `unknown` because the document's shape belongs to the ingress that reads it;
 * the daemon only ever hands it back as JSON.
 */
export interface PullingIngressDriver extends IngressDriver {
  /** The configuration as of the last {@link IngressDriver.apply}. */
  snapshot(): unknown;
}
