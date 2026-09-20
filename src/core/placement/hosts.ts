/*
 * The label rules a host of this installation is built from and read back by —
 * the pieces `host-bindings.ts` states the resolution out of.
 *
 * PURE AND REGISTRY-FREE, which is what makes them shareable. They answer with
 * the name a label carries and stop there: whether the installation really has
 * that application is a question only the bucket answers. Ingress counters take
 * a platform label as written, because a log line is counted rather than served.
 */

import { ScafoError } from "../error.ts";
import { HOST_LABEL_RE } from "../utils/host.ts";
import { isSlug } from "../utils/slug.ts";

/**
 * The label a host carries under one of these platform domains, or null when it
 * is under none of them.
 *
 * The apex domain itself is not one: nothing is ever rendered at it, and a
 * request for it is not asking for an application. A custom domain is not one
 * either — resolving those needs the records that claimed them.
 */
export function platformLabel(host: string, platformDomains: string[]): string | null {
  for (const domain of platformDomains) {
    const suffix = `.${domain}`;
    if (host.endsWith(suffix)) return host.slice(0, -suffix.length);
  }
  return null;
}

/**
 * The application a host under one of these platform domains names, or null
 * when it is under none of them or carries a label scafo could never have
 * rendered.
 */
export function platformApplication(host: string, platformDomains: string[]): string | null {
  const label = platformLabel(host, platformDomains);
  return label !== null && isSlug(label) ? label : null;
}

/**
 * The application one label under a wildcard-claimed base names: `preview` under
 * a base claimed for `shop` is `shop-preview`, exactly what `--env preview`
 * addresses on the command line and what `shop-preview.<platform domain>`
 * already serves. Null when the two do not join into a name.
 */
export function familyApplication(holder: string, label: string): string | null {
  const named = `${holder}-${label}`;
  return isSlug(named) ? named : null;
}

/** The inverse: the label `candidate` carries under its holder's base, or null. */
export function familyLabel(holder: string, candidate: string): string | null {
  if (!candidate.startsWith(`${holder}-`)) return null;
  const label = candidate.slice(holder.length + 1);
  return HOST_LABEL_RE.test(label) ? label : null;
}

/**
 * Whether `candidate` is the wildcard's holder or one of the `<holder>-<env>`
 * applications it stands for.
 *
 * WHAT MAY BE CLAIMED UNDER SOMEBODY ELSE'S WILDCARD. A base claimed with its
 * subdomains already answers for every name one label under it, so an exact
 * claim there takes a host out of that holder's hands: only the holder itself
 * and its own family may do it.
 */
export function isFamilyApplication(holder: string, candidate: string): boolean {
  return candidate === holder || candidate.startsWith(`${holder}-`);
}

/**
 * Refuses a host that belongs to this installation rather than to whoever asks
 * for it: a platform domain itself, or any name under one.
 *
 * Those hosts are rendered from APPLICATION NAMES and nothing else, so a claim
 * on one could only ever shadow — or try to shadow — the host an application is
 * already served at. An installation that knows no platform domain refuses
 * nothing here, which is exactly what it can say.
 */
export function assertClaimableHost(host: string, platformDomains: string[]): void {
  const domain = platformDomains.find(
    (candidate) => host === candidate || host.endsWith(`.${candidate}`),
  );
  if (domain === undefined) return;

  throw new ScafoError("invalid-input", "Host belongs to this installation", {
    detail:
      `"${host}" is under the platform domain "${domain}", where every host names an ` +
      `application of this installation: claim a domain of your own, and reach the ` +
      `application at "<name>.${domain}" meanwhile`,
  });
}
