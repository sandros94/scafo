/*
 * Ingress driver for an operator-run Traefik, which is told what to route by
 * being READ rather than by being written to.
 *
 * This is the one structural difference from the Caddy driver, and it decides
 * everything else here. Caddy is pushed: the driver calls its admin API and owns
 * the routes it created inside a server the operator also writes into. Traefik
 * pulls: its `http` provider polls a URL every few seconds and takes whatever it
 * finds there as the WHOLE of that provider's dynamic configuration. So `apply`
 * makes no network call at all — it renders the configuration and caches it, and
 * the agent's `GET /v1/ingress/traefik` hands that cache to Traefik when it asks.
 *
 * Two consequences worth stating, because they are not symmetric with Caddy:
 *
 * 1. There is no coexistence question. What this driver renders is everything
 *    Traefik's http provider knows; the operator's own routers come from their
 *    other providers (file, docker, kubernetes) and are never in this document,
 *    so nothing here can clobber them and nothing here needs to be careful about
 *    reading them first.
 * 2. A change is visible one poll later rather than at once. The reconcile loop
 *    still calls `apply` after every pass; what that pass publishes reaches
 *    traffic when Traefik next asks for it.
 *
 * The operator runs Traefik, defines the entryPoint these routers attach to, and
 * points its http provider at the agent. Setting that up is documented with the
 * deployment instructions.
 */

import type { IngressBackend, IngressDesired, IngressDriver } from "../../core/types/ingress.ts";
import { assertHost } from "../../core/utils/host.ts";

/**
 * EntryPoint the rendered routers attach to when the operator names none.
 *
 * Named rather than omitted, even though Traefik reads an absent `entryPoints`
 * as "every entryPoint there is". Every entryPoint includes the ones scalo has
 * no business on — a TLS listener it holds no certificate for, the port the
 * dashboard is served on — and a router that attaches itself to all of them
 * claims surface the operator did not offer it.
 */
export const DEFAULT_ENTRY_POINT: string = "web";

/**
 * Namespace of every router and service this driver renders, mirroring the
 * decision the Caddy driver's `@id` prefix records.
 *
 * The separator is an underscore for the same reason it is one there: it cannot
 * occur in a DNS name, so the boundary between the namespace and the host stays
 * unambiguous. Traefik places one further constraint on these names — `@`
 * separates a name from the provider that supplied it (`scalo_shop.test@http`),
 * and a name containing one resolves to nothing — which a host cannot contain
 * either.
 */
export const TRAEFIK_KEY_PREFIX: string = "scalo_";

/** One router: which requests it matches, and what serves them. */
export interface TraefikRouter {
  /** Traefik's rule language; a host match is written with backticks. */
  rule: string;
  /** Name of the service in the same document, unqualified by a provider. */
  service: string;
  entryPoints: string[];
}

/** A service that sends every request it is given to one place. */
export interface TraefikLoadBalancerService {
  loadBalancer: { servers: Array<{ url: string }> };
}

/**
 * A service that divides its requests between OTHER services by weight.
 *
 * Traefik has no weights on a load balancer's servers: a weighted split is a
 * service of its own, naming per-leg child services that each hold one server.
 * The names are UNQUALIFIED, which is what makes them resolve within the
 * document this driver publishes — a name carrying `@` names another provider's.
 *
 * Pinned empirically against `traefik:v3` (v3.7.10) through its http provider
 * rather than taken from the documentation: 200 requests over a two-leg
 * `[90, 10]` split arrived 180/20, and unqualified child names resolved.
 */
export interface TraefikWeightedService {
  weighted: { services: Array<{ name: string; weight: number }> };
}

/** One service: where the requests its router matched are sent. */
export type TraefikService = TraefikLoadBalancerService | TraefikWeightedService;

/**
 * A Traefik dynamic configuration as this driver renders it.
 *
 * `http` is optional, and its absence is the whole of how "route nothing" is
 * said — see {@link renderTraefikConfig}.
 */
export interface TraefikDynamicConfig {
  http?: {
    routers: Record<string, TraefikRouter>;
    services: Record<string, TraefikService>;
  };
}

export interface TraefikDriverOptions {
  /** EntryPoints the routers attach to. Defaults to {@link DEFAULT_ENTRY_POINT}. */
  entryPoints?: string[];
}

/** An {@link IngressDriver} whose configuration is served rather than pushed. */
export interface TraefikDriver extends IngressDriver {
  /** The configuration as of the last `apply`; what the agent's route publishes. */
  snapshot(): TraefikDynamicConfig;
}

/**
 * Builds the driver that routes traffic through Traefik.
 *
 * `apply` never fails: rendering is pure and there is nothing to reach. What can
 * fail is Traefik's own poll, which Traefik reports on its own side — a provider
 * that cannot read its endpoint keeps the configuration it last read and retries,
 * so a node whose agent is briefly down keeps serving what it was serving.
 */
export function createTraefikDriver(opts?: TraefikDriverOptions): TraefikDriver {
  const entryPoints = opts?.entryPoints ?? [DEFAULT_ENTRY_POINT];

  /*
   * Empty until the first reconcile pass, and deliberately not "nothing to say".
   * A node that has just started is running none of its processes yet — the
   * supervisor's children went with the agent — so the honest answer to "what
   * does this node serve" is "nothing", and routing that follows readiness must
   * say so. Serving the previous configuration instead would point Traefik at
   * ports nothing listens on, which is a 502 per request where this is a 404.
   */
  let current: TraefikDynamicConfig = renderTraefikConfig({ routes: [] });

  return {
    apply(desired: IngressDesired): Promise<void> {
      /* Synchronous inside; the async signature is the seam's, and keeping it
         means the reconcile loop treats both ingresses identically. */
      current = renderTraefikConfig(desired, entryPoints);
      return Promise.resolve();
    },
    snapshot(): TraefikDynamicConfig {
      return current;
    },
  };
}

/**
 * Renders the routing as Traefik's dynamic configuration.
 *
 * Deterministic: hosts are emitted in sorted order, so two renders of the same
 * routing are the same document byte for byte — which matters more here than it
 * would for a pushed ingress, because Traefik hashes the body it polls and does
 * no work at all when the bytes have not changed.
 *
 * A host with SEVERAL backends becomes a {@link TraefikWeightedService} naming
 * one child service per leg, which is the only place Traefik puts weights; a
 * host with one keeps the plain load balancer it has always had.
 *
 * EMPTY ROUTING IS THE INTERESTING CASE, and it is not what it looks like. The
 * obvious rendering — `{"http":{"routers":{},"services":{}}}` — does NOT clear
 * Traefik's routing. Its http provider decodes the body through the same parser
 * the file provider uses, which rejects a map with no entries: it answers
 * `cannot decode configuration data: routers cannot be a standalone element`,
 * treats the poll as failed, and KEEPS THE CONFIGURATION IT LAST READ. A node
 * that stopped serving an environment would go on serving it for as long as the
 * agent stayed up. `{"http":{}}` fails the same way one level up. Omitting the
 * key entirely — an empty document — is what Traefik reads as "this provider
 * routes nothing", and it withdraws the routers within one poll.
 *
 * Verified against Traefik 3.7.10; see the driver's suite for the pinned
 * behaviour and `test/integration/e2e-traefik.test.ts` for it against the real
 * container.
 */
export function renderTraefikConfig(
  desired: IngressDesired,
  entryPoints: string[] = [DEFAULT_ENTRY_POINT],
): TraefikDynamicConfig {
  if (desired.routes.length === 0) return {};

  const routers: Record<string, TraefikRouter> = {};
  const services: Record<string, TraefikService> = {};

  for (const { host, backends } of [...desired.routes].sort((a, b) => compare(a.host, b.host))) {
    /*
     * Checked here even though every host arrives having passed `assertHost`
     * upstream — a label built from validated slugs under a configured platform
     * domain, or a custom domain validated when it was claimed. The reason is
     * particular to this format: a Traefik rule is a small language carried in a
     * string, so a host holding a backtick or a parenthesis would not be a
     * malformed name, it would be a different rule. Caddy's route matches on a
     * JSON string and has nothing to escape into, which is why its driver checks
     * nothing. A host that fails here is recorded as an ingress failure of the
     * pass, the way an unreachable admin API is.
     */
    assertHost(host);

    const key = traefikKey(host);
    routers[key] = { rule: `Host(\`${host}\`)`, service: key, entryPoints: [...entryPoints] };

    /* One backend is a load balancer over one server, not a weighted service
       over one child: the indirection would buy nothing and would rewrite the
       document — which Traefik hashes — for every host on the node. */
    const only = backends.length === 1 ? backends[0] : undefined;
    if (only !== undefined) {
      services[key] = { loadBalancer: { servers: [{ url: upstreamUrl(only.backend) }] } };
      continue;
    }

    services[key] = {
      weighted: {
        services: backends.map((leg) => ({
          name: traefikLegKey(host, leg.backend.build),
          weight: leg.weight,
        })),
      },
    };
    for (const leg of backends) {
      services[traefikLegKey(host, leg.backend.build)] = {
        loadBalancer: { servers: [{ url: upstreamUrl(leg.backend) }] },
      };
    }
  }

  return { http: { routers, services } };
}

/** The router and service name the routing for `host` is written under. */
export function traefikKey(host: string): string {
  return `${TRAEFIK_KEY_PREFIX}${host}`;
}

/**
 * The child service one leg of a weighted `host` is written under.
 *
 * Separated from the host by the same underscore the namespace uses, and for the
 * same reason: an underscore cannot occur in a DNS name or in a build id, so no
 * child key can collide with another host's key or with a router's. A separator
 * a host CAN contain — `--`, which every environment label carries — would make
 * `scalo_<host>--<build>` ambiguous against a claimed domain shaped like one.
 */
export function traefikLegKey(host: string, build: string): string {
  return `${TRAEFIK_KEY_PREFIX}${host}_${build}`;
}

/** Runtime processes only ever listen on loopback; the ingress faces the network. */
function upstreamUrl(backend: IngressBackend): string {
  return `http://127.0.0.1:${String(backend.port)}`;
}

/* Code-unit ordering, so the document does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
