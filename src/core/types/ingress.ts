/*
 * The seam between placement and whatever puts a node's ready processes on the
 * public network. Core describes the contract; a driver
 * (`scafo/drivers/ingress/caddy`) implements it, and the reconcile loop calls it
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

/** One backend of a host, and the share of that host's traffic it takes. */
export interface WeightedBackend {
  backend: IngressBackend;
  /**
   * Whole number of at least 1. The weights of ONE host always sum to 100, so a
   * driver may write them out as percentages without rescaling, and a host with
   * a single backend always carries 100.
   */
  weight: number;
}

/** One host and everything that answers on it. */
export interface IngressRoute {
  host: string;
  /**
   * Backends in the order the routing states them — the environment's alias leg
   * first, then its split legs — never empty. A driver that load-balances by
   * position must keep this order, because that is what the weights line up with.
   */
  backends: WeightedBackend[];
}

/** Traffic that must reach the node's own agent: hosts to wake, and whole domains to answer for. */
export interface WakeRouting {
  /** Loopback port the agent answers on. */
  port: number;
  /** Fully qualified hosts routed to the agent outright — parked environments' hosts and their custom domains. */
  hosts: string[];
  /** Platform domains whose UNMATCHED subdomain hosts fall through to the agent, after every explicit route. */
  domains: string[];
}

/**
 * The fleet's own API, served at each platform domain's BARE APEX so that a CI
 * job, a CLI or a dashboard reaches any node of the installation at one
 * well-known name — the registry is in the bucket, so any node answers any call.
 *
 * AN EXPLICIT ROUTE PER APEX, never a widening of the catch-all: a `*.<domain>`
 * matcher covers exactly one label and therefore never the domain itself, which
 * is also why the apex has no wildcard certificate and mints its own.
 *
 * {@link ApiRouting.denied} IS THE SECURITY RULE OF THIS SURFACE AND A DRIVER
 * MUST ENFORCE IT AT THE INGRESS, not by trusting the agent behind it: a request
 * for one of these prefixes on one of these hosts must be answered by the
 * ingress itself and must never be proxied. Both prefixes are matched at a path
 * SEGMENT boundary — the prefix exactly, or the prefix followed by `/` and
 * anything — which is what the two implemented drivers were pinned to.
 */
export interface ApiRouting {
  /** Loopback port the agent answers on. */
  port: number;
  /** Bare platform-domain apexes routed to the agent, sorted. */
  hosts: string[];
  /** Path prefixes that must NEVER be proxied through {@link ApiRouting.hosts}. */
  denied: string[];
}

/** The whole of the routing an ingress should present for this node. */
export interface IngressDesired {
  /**
   * Host to backends, sorted by host. Hosts are fully qualified: a host label
   * under one of the platform domains, or a custom domain an environment claimed.
   */
  routes: IngressRoute[];
  /**
   * Where a request nothing above answers goes. Absent when the node has no
   * agent address to send one to, which is the routing scafo rendered before
   * scale-to-zero existed.
   *
   * PRECEDENCE IS THE WHOLE CONTRACT, AND IT IS ONE RULE: every explicit route
   * beats the catch-all. A {@link IngressDesired.routes} entry is explicit
   * because a ready process answers on it, a {@link WakeRouting.hosts} entry is
   * explicit because a parked environment answers on it once woken, and a
   * {@link WakeRouting.domains} entry is the catch-all that must never shadow
   * either. A driver MUST therefore order or prioritize its catch-alls so they
   * are consulted last, whatever its format calls that — an array position for
   * an ingress that matches top-down, an explicit rank for one that scores
   * rules. Getting it wrong does not misroute one host: it sends a whole
   * platform domain's live traffic to the agent.
   *
   * The two kinds of entry are separate because they fail differently. A wake
   * host is a name scafo KNOWS about and is holding open, so a request to one
   * is answered by starting something; an unmatched host under a platform
   * domain is a name scafo knows nothing about, and the agent answers it 404 —
   * which is why the domains are routed at all rather than left to whatever the
   * ingress does with a host it has no route for.
   */
  wake?: WakeRouting;
  /**
   * The platform apexes serving the fleet's API, when this node publishes it.
   * Absent when `api.public` is off, which is the routing scafo renders when the
   * apex answers nothing at all.
   *
   * PRECEDENCE, IN BOTH DIRECTIONS. These entries sit BELOW every
   * {@link IngressDesired.routes} host and every {@link WakeRouting.hosts} entry
   * — a renderer leaves an apex out of them entirely when either already answers
   * on it — and ABOVE the {@link WakeRouting.domains} catch-alls, which matters
   * whenever one platform domain is a subdomain of another (`dev.example.com`
   * under `example.com`): the catch-all for the outer domain matches the inner
   * one's apex, and the API must win.
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
 * configuration and caches it, and the ingress itself polls the agent for it.
 *
 * The distinction is the ingress's own, not scafo's. An ingress with an admin
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
