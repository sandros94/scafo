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

/**
 * Routes public traffic to the processes a node runs, by being TOLD: an ingress
 * with an admin API is converged by calling it after every reconcile pass. An
 * ingress that polls instead reads the fleet's routing off the node API in its
 * own format ({@link IngressFormat}) and needs no driver.
 */
export interface IngressDriver {
  /**
   * Converges the ingress to exactly this routing and nothing beyond it: hosts
   * that are no longer desired stop being served. Idempotent, so a caller may
   * apply the same routing after every reconcile pass.
   */
  apply(desired: IngressDesired): Promise<void>;
}

/**
 * Renders the fleet's routing in the document format one ingress polls for.
 * Served by every node under `/v1/ingress/routes/<name>`, so an ingress in
 * front of the fleet may read it from whichever node answers. `prefer` names
 * the node the routing was ordered for, when the ingress asked for one, for a
 * format that can say more than an order — that node first, the rest only when
 * it fails.
 */
export type IngressFormat = (routing: FleetRouting, opts: { prefer?: string }) => unknown;

/**
 * Where one host is answered across the fleet: a running process on a node,
 * named by the node and by the address a peer or an ingress dials it at.
 */
export interface FleetUpstream {
  node: string;
  /** `host:port` — the node's advertised address and the process's public port. */
  address: string;
}

/**
 * One host and everyone who answers on it. `upstreams` is ORDERED, and the order
 * is a priority: an ingress tries the first and falls through to the next only
 * when the first is unhealthy. It is never a weighting — nothing here asks for
 * traffic to be split. A renderer sorts by node id and a consumer may ask for
 * one node to be put first, which is how a colocated ingress stays local.
 */
export interface FleetRoute {
  host: string;
  project: string;
  env: string;
  upstreams: FleetUpstream[];
}

/**
 * The fleet's API at the platform apexes, answered by every live node's daemon.
 * {@link ApiRouting.denied} applies here unchanged: an ingress answers those
 * prefixes itself and never proxies them.
 */
export interface FleetApiRouting {
  hosts: string[];
  upstreams: FleetUpstream[];
  denied: string[];
}

/**
 * The routing of the whole fleet, as any ingress in front of it reads it: every
 * host any environment answers on, and every node currently answering. Rendered
 * by every node from the same registry, so every node's copy says the same
 * thing, give or take a heartbeat.
 */
export interface FleetRouting {
  v: 1;
  /** Sorted by host. */
  routes: FleetRoute[];
  /** Absent when the rendering node does not publish the API. */
  api?: FleetApiRouting;
}
