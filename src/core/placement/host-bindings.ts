/*
 * WHICH APPLICATION A HOST NAMES, and the one place that decision is made.
 *
 * Three rules, weighed in this order. An EXACT host: an application's name under
 * every platform domain, and every host claimed for one — the base of a wildcard
 * claim included, because a claim is made on the host itself first. Then, under a
 * host claimed WITH its subdomains, the ENVIRONMENT one label below it:
 * `<label>.<base>` is `<holder>-<label>` when the installation has an application
 * of that name, which is exactly what `--env <label>` addresses and what
 * `<holder>-<label>.<platform domain>` already answers on. Then the CATCH-ALL:
 * every other name one label below the base is the holder's. Two labels below is
 * nobody's, as under a wildcard certificate.
 *
 * BOTH DIRECTIONS COME OUT OF ONE ENUMERATION. {@link hostBindings} states the
 * rules once, in precedence order; the fleet's routing walks it forward and
 * publishes the entries something is serving, and the access counters index it
 * backwards and read a request host off the index. Neither restates a rule, so
 * they cannot disagree about whose host is whose.
 */

import { familyLabel, platformApplication } from "./hosts.ts";
import { isHost, splitHostLabel, wildcardBase, wildcardHost } from "../utils/host.ts";
import { hostUnder } from "./routes.ts";

/**
 * What host resolution needs of an application: its name, and the hosts claimed
 * for it as its own record mirrors them. An `ApplicationRecord` is one.
 */
export interface HostApplication {
  name: string;
  domains: string[];
  /** The subset of {@link HostApplication.domains} claimed with their subdomains. */
  wildcardDomains?: string[];
}

/** One host this installation answers on, and the application that answers it. */
export interface HostBinding {
  /** A fully qualified host, or the one wildcard key a base stands for: `*.shop.example`. */
  host: string;
  application: string;
}

export interface HostBindingsInput {
  /** Apex domains the platform serves subdomains under. */
  platformDomains: string[];
  /**
   * The applications resolution may name. A caller hands in the set its own
   * question is about: everything the fleet may route to, or every record the
   * registry holds.
   */
  applications: readonly HostApplication[];
}

/**
 * Every host binding these applications define, IN PRECEDENCE ORDER: platform
 * hosts, then claims in host order, then — per wildcard base, in host order —
 * its environments and finally its catch-all key.
 *
 * A name too long for DNS is left out rather than failing every other host.
 * Duplicates are possible and deliberate: the first binding for a host is the
 * one that wins, and a consumer that drops entries for its own reasons lets the
 * next one take the host, which is how an unserved claim falls through to a
 * wildcard that encloses it.
 */
export function hostBindings(input: HostBindingsInput): HostBinding[] {
  const applications = [...input.applications].sort((a, b) => compare(a.name, b.name));
  const bindings: HostBinding[] = [];

  for (const application of applications) {
    for (const domain of input.platformDomains) {
      const host = hostUnder(domain, application.name);
      if (host !== null) bindings.push({ host, application: application.name });
    }
  }

  const claims = applications
    .flatMap((application) =>
      application.domains.map((host) => ({ host, application: application.name })),
    )
    .sort((a, b) => compare(a.host, b.host));
  bindings.push(...claims);

  const bases = applications
    .flatMap((application) =>
      (application.wildcardDomains ?? []).map((host) => ({ host, application: application.name })),
    )
    .sort((a, b) => compare(a.host, b.host));
  for (const base of bases) {
    for (const member of applications) {
      const label = familyLabel(base.application, member.name);
      if (label === null) continue;

      const host = `${label}.${base.host}`;
      if (!isHost(host)) continue;
      bindings.push({ host, application: member.name });
    }
    bindings.push({ host: wildcardHost(base.host), application: base.application });
  }

  return bindings;
}

/** Reads a request host back into the application it names. */
export interface HostIndex {
  /** The application `host` names, or null when nothing of this installation does. */
  resolve(host: string): string | null;
}

/**
 * Indexes {@link hostBindings} for reading a host back, in map lookups and
 * nothing else: an exact host, then the platform grammar, then the one wildcard
 * key its base stands for.
 *
 * WHAT "NAMES" MEANS HERE IS EXISTENCE, not serving, and that is the same
 * predicate the routing render resolves with — the render is this enumeration
 * plus a separate filter for whether anything is currently answering, which is a
 * question about PUBLISHING a route rather than about whose host it is. A reader
 * of history must not ask the second question: a log line exists because
 * something already answered, and a claim outlives every process that ever did,
 * so an application that is between deployments would otherwise have its own
 * traffic counted as nobody's.
 *
 * The platform grammar is kept as a rule of its own, below the exact hosts and
 * above the wildcards: a host under a platform domain is rendered from an
 * application's name and from nothing else, so it reads back on its own even for
 * a name the handed-in set does not hold.
 */
export function createHostIndex(input: HostBindingsInput): HostIndex {
  const platformDomains = [...input.platformDomains];
  const exact = new Map<string, string>();
  /* Keyed by the base rather than by `*.base`, which is how a host is looked
     up: its first label is taken off and what is left is asked for once. */
  const covered = new Map<string, string>();

  for (const binding of hostBindings(input)) {
    const base = wildcardBase(binding.host);
    const into = base === null ? exact : covered;
    const key = base ?? binding.host;
    if (!into.has(key)) into.set(key, binding.application);
  }

  return {
    resolve(host: string): string | null {
      const named = exact.get(host);
      if (named !== undefined) return named;

      const platform = platformApplication(host, platformDomains);
      if (platform !== null) return platform;

      const split = splitHostLabel(host);
      return split === null ? null : (covered.get(split.base) ?? null);
    },
  };
}

/* Code-unit ordering, so the bindings do not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
