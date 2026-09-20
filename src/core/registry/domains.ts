/*
 * Custom domains: one claim per host, mirrored on the application that serves it.
 *
 * A CLAIM MAY ALSO COVER THE ONE LABEL BELOW ITS HOST. `--wildcard` on
 * `shop.example` serves `shop.example` from the application, `preview.shop.example`
 * from `<application>-preview` when there is one, and anything else one label
 * under it from the application itself. It is a flag on the claim rather than a
 * second record, so a base and its subdomains can never be held by two claims
 * that disagree, and the mirror on the application record is what the routing
 * render reads.
 */

import { ScafoError } from "../error.ts";
import { familyApplication, isFamilyApplication } from "../placement/hosts.ts";
import type { ApplicationRecord, DomainClaim } from "../types/registry.ts";
import { normalizeCustomDomain, splitHostLabel } from "../utils/host.ts";
import { assertApplicationUnblocked, updateApplication } from "./applications.ts";
import { isCasConflict, isNotFound, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { applicationKey, domainKey, domainsPrefix } from "./paths.ts";

/**
 * How many custom domains one application may hold.
 *
 * A BOUND ON THE RECORD rather than on the fleet: every host lands in the
 * application's own document, which every node reads on every reconcile pass and
 * every ingress reads the routing rendered from — so an application that claimed
 * a thousand of them would be a cost paid by the whole installation, on a loop.
 * Sixty-four is far more than a product needs and far less than that.
 */
export const MAX_APPLICATION_DOMAINS: number = 64;

/** What a claim may ask for beyond the host itself. */
export interface ClaimDomainOptions {
  /**
   * Claim the single label below `host` along with it. An upgrade is idempotent
   * and a claim already carrying it is never silently downgraded by a later
   * claim that leaves the flag out.
   */
  wildcard?: boolean;
}

/**
 * Claims `host` for an application. Re-claiming for the same application is
 * idempotent; a claim held by anyone else throws `ScafoError("reference-held")`.
 *
 * Writes go referent-first: the application is checked, then the claim is
 * created, then the application lists the host. A crash in between leaves a
 * claim nothing routes to — certificates can be issued, traffic still 404s —
 * and re-running the call repairs it.
 */
export async function claimDomain(
  ctx: RegistryContext,
  host: string,
  application: string,
  opts?: ClaimDomainOptions,
): Promise<DomainClaim> {
  const claimed = normalizeCustomDomain(host);
  const key = domainKey(claimed);
  const wildcard = opts?.wildcard === true;
  const record = await requireJson<ApplicationRecord>(ctx, applicationKey(application));
  /* A blocked application is served nowhere, so a host claimed for it would
     route to nothing; releasing one stays allowed, so nothing is trapped. */
  assertApplicationUnblocked(record.value);
  assertRoom(record.value, claimed);

  const blocking = wildcard
    ? await foreignChild(ctx, claimed, application)
    : await foreignParent(ctx, claimed, application);
  if (blocking !== null) throw blockedBy(claimed, blocking);

  let claim: DomainClaim = {
    v: 1,
    application,
    claimedAt: nowIso(ctx),
    ...(wildcard ? { wildcard: true as const } : {}),
  };
  try {
    await createJson(ctx, key, claim);
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<DomainClaim>(ctx, key);
    assertHeldBy(existing.value, claimed, application, error);
    claim = existing.value;

    /* An upgrade, never a downgrade: a claim that already covers its subdomains
       keeps doing so when somebody re-runs the plain `add`, because dropping it
       silently would take every subdomain out of routing. */
    if (wildcard && existing.value.wildcard !== true) {
      const updated = await updateJson<DomainClaim>(ctx, key, (current) => {
        assertHeldBy(current, claimed, application);
        return { ...current, wildcard: true as const };
      });
      claim = updated.value;
    }
  }

  const covering = claim.wildcard === true;
  await updateApplication(ctx, application, (current) => {
    const held = current.domains.includes(claimed);
    /* Checked again inside the update: the read above is not the write, and two
       claims landing at once would otherwise both pass a full record. */
    if (!held) assertRoom(current, claimed);

    const domains = held ? current.domains : [...current.domains, claimed];
    const wildcards = new Set(current.wildcardDomains ?? []);
    if (covering) wildcards.add(claimed);
    return mirrored(current, domains, wildcards);
  });

  return claim;
}

/**
 * Drops a claim, removing the host from the application first so nothing points
 * at a claim that is about to disappear. Absent claims and already-deleted
 * applications are both tolerated, which makes the call safe to re-run.
 */
export async function releaseDomain(ctx: RegistryContext, host: string): Promise<void> {
  await drop(ctx, host, null);
}

/**
 * Drops a claim one application holds, and only that one.
 *
 * `not-found` when the host is claimed by somebody else, in the same words as a
 * host nobody claimed at all: releasing is a statement about this application's
 * own domains, so a caller must never be able to take another's claim — nor to
 * learn, by the shape of the refusal, that there is one to take.
 */
export async function releaseApplicationDomain(
  ctx: RegistryContext,
  host: string,
  application: string,
): Promise<void> {
  await drop(ctx, host, application);
}

/** A standing claim that keeps an application from claiming the host it asked for. */
export interface DomainConflict {
  /** The host the standing claim is on: the wanted host, its base, or one under it. */
  host: string;
  /** The application holding it. */
  application: string;
  /** How that host relates to the one somebody asked for. */
  relation: "exact" | "parent" | "child";
}

/**
 * The claim that would refuse this one, or null when nothing would — exactly
 * what {@link claimDomain} weighs, asked as a question rather than thrown.
 *
 * It exists so the node API can decide whether the caller is allowed to READ the
 * holder's name: a refusal names it only to a caller whose scope reaches it.
 */
export async function domainConflict(
  ctx: RegistryContext,
  host: string,
  application: string,
  opts?: ClaimDomainOptions,
): Promise<DomainConflict | null> {
  const claimed = normalizeCustomDomain(host);

  const existing = await readJson<DomainClaim>(ctx, domainKey(claimed));
  if (existing !== null && existing.value.application !== application) {
    return { host: claimed, application: existing.value.application, relation: "exact" };
  }
  return opts?.wildcard === true
    ? foreignChild(ctx, claimed, application)
    : foreignParent(ctx, claimed, application);
}

/**
 * How a refused claim reads, with `holder` naming the application that holds it
 * or standing in for the name where the caller may not read it.
 */
export function describeDomainConflict(
  wanted: string,
  conflict: DomainConflict,
  holder: string,
): string {
  if (conflict.relation === "parent") {
    return (
      `"${wanted}" is one label under "${conflict.host}", which ${holder} holds with its ` +
      `subdomains: only that application and its environments may claim a host there`
    );
  }
  if (conflict.relation === "child") {
    return (
      `"${conflict.host}", one label under "${wanted}", is held by ${holder}: claim ` +
      `"${wanted}" without its subdomains, or have that host released first`
    );
  }
  return `"${wanted}" is held by ${holder}`;
}

/** The claim filed for exactly this host, or null. Nothing above it is read. */
export async function checkDomain(ctx: RegistryContext, host: string): Promise<DomainClaim | null> {
  const found = await readJson<DomainClaim>(ctx, domainKey(host));
  return found === null ? null : found.value;
}

/**
 * The application a claim NAMES for `host`: the one that claimed it exactly, or
 * — one label under a host claimed with its subdomains — `<holder>-<label>`,
 * which is the application `<holder>-<label>.<platform domain>` already serves.
 *
 * It never answers the wildcard's HOLDER for an arbitrary subdomain, although
 * the routing does route one there. The certificate ask is the caller that needs
 * that difference, and it is where the reasoning lives.
 */
export async function claimedApplication(
  ctx: RegistryContext,
  host: string,
): Promise<string | null> {
  const exact = await readJson<DomainClaim>(ctx, domainKey(host));
  if (exact !== null) return exact.value.application;

  const split = splitHostLabel(host);
  if (split === null) return null;

  const parent = await readJson<DomainClaim>(ctx, domainKey(split.base));
  if (parent === null || parent.value.wildcard !== true) return null;
  return familyApplication(parent.value.application, split.label);
}

/* ---------------------------------------------------------------- internals */

/**
 * The release both forms share. `owner` names the application entitled to the
 * claim, or null for the fleet's own release — the reaper deleting an
 * application takes whatever it holds.
 *
 * The owner is read and then acted on, because a store gives us no conditional
 * delete: what makes that safe is that a claim only ever changes hands through a
 * release, so the window is one this caller opened itself.
 */
async function drop(ctx: RegistryContext, host: string, owner: string | null): Promise<void> {
  const claimed = owner === null ? host : normalizeCustomDomain(host);
  const key = domainKey(claimed);
  const claim = await readJson<DomainClaim>(ctx, key);

  if (claim === null || (owner !== null && claim.value.application !== owner)) {
    if (owner === null) return;
    throw new ScafoError("not-found", "No such domain", {
      detail: `"${claimed}" is not a domain of application "${owner}"`,
    });
  }

  try {
    await updateApplication(ctx, claim.value.application, (current) =>
      mirrored(
        current,
        current.domains.filter((domain) => domain !== claimed),
        new Set((current.wildcardDomains ?? []).filter((domain) => domain !== claimed)),
      ),
    );
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await deleteKey(ctx, key);
}

/**
 * The record with its hosts as this call leaves them. `wildcardDomains` is a
 * SUBSET of `domains` kept in the same order, and the key is dropped outright
 * when nothing is in it, so an application that never asked for one carries no
 * trace of the field.
 */
function mirrored(
  current: ApplicationRecord,
  domains: string[],
  wildcards: Set<string>,
): ApplicationRecord {
  const { wildcardDomains: _held, ...rest } = current;
  const kept = domains.filter((domain) => wildcards.has(domain));
  return { ...rest, domains, ...(kept.length === 0 ? {} : { wildcardDomains: kept }) };
}

/** Refuses when `claim` is somebody else's, in the words an operator reads. */
function assertHeldBy(
  claim: DomainClaim,
  host: string,
  application: string,
  cause?: unknown,
): void {
  if (claim.application === application) return;
  throw blockedBy(host, { host, application: claim.application, relation: "exact" }, cause);
}

/** The one refusal a claim somebody else holds produces, wherever it is noticed. */
function blockedBy(wanted: string, conflict: DomainConflict, cause?: unknown): ScafoError {
  return new ScafoError("reference-held", "Domain is claimed by another application", {
    detail: describeDomainConflict(wanted, conflict, `application "${conflict.application}"`),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The claim one label above `host` that somebody outside this application's
 * family made WITH its subdomains, or null.
 *
 * That base already answers for this host, so an exact claim here would carve a
 * name out of its holder's own wildcard. One GET, not a listing: the only claim
 * that could cover a host that way is the one on its immediate parent, and that
 * key is known without looking.
 */
async function foreignParent(
  ctx: RegistryContext,
  host: string,
  application: string,
): Promise<DomainConflict | null> {
  const split = splitHostLabel(host);
  if (split === null) return null;

  const parent = await readJson<DomainClaim>(ctx, domainKey(split.base));
  if (parent === null || parent.value.wildcard !== true) return null;
  if (isFamilyApplication(parent.value.application, application)) return null;

  return { host: split.base, application: parent.value.application, relation: "parent" };
}

/**
 * The host one label under `base` that an application outside this one's family
 * already holds, or null. A wildcard over it would claim to answer for a name
 * that is somebody else's, and the exact claim would rightly keep winning.
 *
 * THIS ONE HAS TO LIST `_scafo/domains/`, because the question is about every
 * host there might be under the base rather than one known key. Claiming a
 * domain is a rare operator action, and it is the only thing that pays for it.
 */
async function foreignChild(
  ctx: RegistryContext,
  base: string,
  application: string,
): Promise<DomainConflict | null> {
  const prefix = domainsPrefix();
  for (const host of namesFromKeys(await ctx.store.list(prefix), prefix)) {
    if (splitHostLabel(host)?.base !== base) continue;

    const child = await readJson<DomainClaim>(ctx, domainKey(host));
    if (child === null || isFamilyApplication(application, child.value.application)) continue;
    return { host, application: child.value.application, relation: "child" };
  }
  return null;
}

/** Refuses a host that would take the record past {@link MAX_APPLICATION_DOMAINS}. */
function assertRoom(application: ApplicationRecord, host: string): void {
  if (application.domains.includes(host)) return;
  if (application.domains.length < MAX_APPLICATION_DOMAINS) return;

  throw new ScafoError("invalid-input", "Too many domains", {
    detail:
      `"${application.name}" already holds ${String(MAX_APPLICATION_DOMAINS)} domains, which is ` +
      `as many as one application may: release one before claiming "${host}"`,
  });
}
