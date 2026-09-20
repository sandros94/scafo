/*
 * The seam between placement and whatever puts a node's running processes on the
 * public network.
 *
 * EVERY INGRESS PULLS. Nothing here is pushed into an ingress and nothing here
 * calls one: a node renders the fleet's routing and serves it, and the ingress in
 * front reads it — as the generic document, or in the format it speaks natively
 * ({@link IngressFormat}). Caddy reads it through the `scafo` dynamic-upstreams
 * module, Traefik through its http provider, and both present the same ingress
 * token to do it.
 */

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
  /**
   * A fully qualified host, or ONE WILDCARD KEY: `*.shop.example` — everything
   * exactly one label under `shop.example` that no exact entry names.
   *
   * A consumer looks a request's host up exactly first and, failing that,
   * replaces its first label with `*` and looks that up once; two labels below
   * the base match nothing, as under a wildcard certificate. A consumer that
   * knows nothing of the key never matches it and answers as it would for a host
   * the fleet does not serve, which is what it was doing before the key existed.
   */
  host: string;
  application: string;
  upstreams: FleetUpstream[];
}

/**
 * The fleet's own API, served at each platform domain's BARE APEX so that a CI
 * job, a CLI or a dashboard reaches any node of the installation at one
 * well-known name — the registry is in the bucket, so any node answers any call.
 *
 * AN EXPLICIT ROUTE PER APEX, which is also why the apex has no wildcard
 * certificate and mints its own.
 *
 * {@link FleetApiRouting.denied} IS THE SECURITY RULE OF THIS SURFACE AND THE
 * INGRESS MUST ENFORCE IT ITSELF, not by trusting the daemon behind it: a
 * request for one of these prefixes on one of these hosts must be answered by
 * the ingress and must never be proxied. Both prefixes are matched at a path
 * SEGMENT boundary — the prefix exactly, or the prefix followed by `/` and
 * anything — which is what both ingresses are pinned to.
 */
export interface FleetApiRouting {
  /** Bare platform-domain apexes routed to the daemon, sorted. */
  hosts: string[];
  upstreams: FleetUpstream[];
  /** Path prefixes that must NEVER be proxied through {@link FleetApiRouting.hosts}. */
  denied: string[];
}

/**
 * The routing of the whole fleet, as any ingress in front of it reads it: every
 * host any application answers on, and every node currently answering. Rendered
 * by every node from the same registry, so every node's copy says the same
 * thing, give or take a heartbeat.
 *
 * A document with no routes says the fleet answers on nothing, and an ingress
 * withdraws everything it holds on reading one. That is a statement, not a
 * default: a node that has not finished a reconcile pass has no document at all
 * and its routing routes refuse rather than render this.
 */
export interface FleetRouting {
  v: 1;
  /** Sorted by host. */
  routes: FleetRoute[];
  /** Absent when the rendering node does not publish the API. */
  api?: FleetApiRouting;
}
