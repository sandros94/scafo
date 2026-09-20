/*
 * Custom domains on the terminal: what a claim reads as, and whether DNS already
 * points at the installation.
 *
 * THE DNS CHECK NEVER REFUSES ANYTHING. Scafo takes no proof of ownership — one
 * installation is one trust domain, and a certificate is never issued for a name
 * that does not resolve here anyway — so asking a resolver is a courtesy to
 * whoever just claimed a host, not a gate in front of the claim. It answers
 * after the registry has been written, it is bounded, and every way it can fail
 * ends in the same warning the operator would need to read anyway: point the
 * name here.
 */

import { lookup } from "node:dns/promises";
import type { DomainChange } from "./_applications.ts";

/** How the helper asks DNS. Injected, so a test never touches the network. */
export type HostResolver = (host: string) => Promise<string[]>;

/**
 * What DNS said about a host that was just claimed:
 * - `ok`: it already resolves to an address the application answers on.
 * - `pending`: it resolves somewhere else, or nowhere the installation is.
 * - `unknown`: the resolver said nothing usable — no record, or no answer in time.
 */
export type DnsOutcome = "ok" | "pending" | "unknown";

/** How long every lookup of one check has between them; the CLI waits no longer. */
export const DNS_BUDGET_MS: number = 3000;

/**
 * The label the wildcard check resolves under the claimed base.
 *
 * A NAME NOTHING WILL EVER BE DEPLOYED AT, because the question is whether the
 * `*` record exists rather than whether any particular subdomain does: if this
 * resolves where the installation is, every other name under the base does too.
 */
export const DNS_PROBE_LABEL: string = "scafo-dns-check";

/** The name the wildcard check asks a resolver about. */
export function wildcardProbeHost(base: string): string {
  return `${DNS_PROBE_LABEL}.${base}`;
}

export interface DomainDnsOptions {
  /** The host that was claimed. */
  host: string;
  /** The application's hosts under the installation's platform domains. */
  platformHosts: string[];
  /** Defaults to the machine's own resolver. */
  resolve?: HostResolver;
  /** Defaults to {@link DNS_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Whether the claimed host and the application's platform hosts resolve to any
 * address in common.
 *
 * Addresses rather than records: a CNAME, an ALIAS and a copied A record are all
 * the same answer to the question being asked, and the one thing they have in
 * common is what they resolve to.
 */
export async function checkDomainDns(opts: DomainDnsOptions): Promise<DnsOutcome> {
  const resolve = opts.resolve ?? systemResolver;
  const budgetMs = opts.budgetMs ?? DNS_BUDGET_MS;

  const quietly = async (host: string): Promise<string[] | null> => {
    try {
      return await withBudget(resolve(host), budgetMs);
    } catch {
      /* NXDOMAIN, SERVFAIL, no resolver, no network, no answer in time: every
         one of them means the same thing here, which is that nothing has been
         confirmed. */
      return null;
    }
  };

  const [claimed, ...platform] = await Promise.all([
    quietly(opts.host),
    ...opts.platformHosts.map(quietly),
  ]);
  if (claimed === null || claimed.length === 0) return "unknown";

  const ours = new Set(platform.flatMap((found) => found ?? []));
  if (ours.size === 0) return "unknown";

  return claimed.some((address) => ours.has(address)) ? "ok" : "pending";
}

/** The machine's own resolver, A and AAAA, following CNAMEs as it does. */
export const systemResolver: HostResolver = async (host) => {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
};

/** How a claim reads on the terminal: the host, the application, and what happens next. */
export function describeDomainClaim(change: DomainChange, via: string): string {
  const name = change.application.name;
  const covered = (change.application.wildcardDomains ?? []).includes(change.host);
  return (
    `scafo: "${change.host}" is claimed for "${name}" through ${via}` +
    (covered
      ? `, with every name one label under it: "<env>.${change.host}" answers from ` +
        `"${name}-<env>" wherever this installation has one, and every other subdomain ` +
        `from "${name}" itself`
      : "") +
    `; every ingress of this installation picks it up within one reconcile interval, because ` +
    `nothing is pushed into one`
  );
}

/**
 * What an operator has to do at the ingress for a wildcard claim, which scafo
 * cannot do for them: a name under the base that is not an environment of the
 * application gets no certificate of its own, because scafo approves issuance
 * only for names it can name — see the certificate ask.
 */
export function describeWildcardCertificates(host: string): string {
  return (
    `a subdomain of "${host}" that is not an application of this installation is served over ` +
    `HTTPS only where the ingress already holds a certificate covering "*.${host}": scafo ` +
    `approves on-demand issuance for "${host}" and for a subdomain naming an application, and ` +
    `never for an arbitrary one, so obtain the wildcard certificate through DNS-01 at the ingress`
  );
}

/** The wildcard record that is still to be created, in the same words a host's is. */
export function describeWildcardDnsPending(host: string, platformHosts: string[]): string {
  const target = platformHosts[0];
  return (
    `"*.${host}" does not resolve to this installation yet: create the wildcard record` +
    (target === undefined ? "" : `, for instance a CNAME to "${target}"`) +
    `, or the subdomains this claim covers reach nothing`
  );
}

/** What an operator reads when the wildcard record is already in place. */
export function describeWildcardDnsSettled(host: string): string {
  return `scafo: "*.${host}" already resolves to this installation, so its subdomains reach it too`;
}

/** The same for a release, naming what stops answering. */
export function describeDomainRelease(change: DomainChange, via: string): string {
  return (
    `scafo: "${change.host}" is no longer claimed for "${change.application.name}" through ` +
    `${via}; every ingress stops answering for it within one reconcile interval, and the ` +
    `application keeps every other host it has`
  );
}

/** What an operator reads when DNS already points at the installation. */
export function describeDnsSettled(host: string): string {
  return `scafo: "${host}" already resolves to this installation, so it is served as soon as the routing moves`;
}

/**
 * What is still to do, as the CLI's warning channel carries it. One line,
 * whether the name resolves elsewhere or the resolver said nothing at all: the
 * next step is the same either way.
 */
export function describeDnsPending(host: string, platformHosts: string[]): string {
  const target = platformHosts[0];
  return (
    `"${host}" does not resolve to this installation yet: point it here` +
    (target === undefined ? "" : `, for instance with a CNAME to "${target}"`) +
    `, and the certificate is issued on the first request that arrives after it does`
  );
}

/* ---------------------------------------------------------------- internals */

/** Rejects once `budgetMs` has passed, and never holds the process open for it. */
async function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`no answer within ${String(budgetMs)}ms`));
    }, budgetMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
