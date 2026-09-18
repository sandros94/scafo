/* Custom domains: one claim per host, mirrored on the application that serves it. */

import { ScafoError } from "../error.ts";
import type { ApplicationRecord, DomainClaim } from "../types/registry.ts";
import { updateApplication } from "./applications.ts";
import { isCasConflict, isNotFound } from "./_shared.ts";
import { createJson, deleteKey, readJson, requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { applicationKey, domainKey } from "./paths.ts";

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
): Promise<DomainClaim> {
  const key = domainKey(host);
  await requireJson<ApplicationRecord>(ctx, applicationKey(application));

  let claim: DomainClaim = { v: 1, application, claimedAt: nowIso(ctx) };
  try {
    await createJson(ctx, key, claim);
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<DomainClaim>(ctx, key);
    if (existing.value.application !== application) {
      throw new ScafoError("reference-held", "Domain is claimed by another application", {
        detail: `"${host}" is held by application "${existing.value.application}"`,
        cause: error,
      });
    }
    claim = existing.value;
  }

  await updateApplication(ctx, application, (current) =>
    current.domains.includes(host) ? current : { ...current, domains: [...current.domains, host] },
  );

  return claim;
}

/**
 * Drops a claim, removing the host from the application first so nothing points
 * at a claim that is about to disappear. Absent claims and already-deleted
 * applications are both tolerated, which makes the call safe to re-run.
 */
export async function releaseDomain(ctx: RegistryContext, host: string): Promise<void> {
  const key = domainKey(host);
  const claim = await readJson<DomainClaim>(ctx, key);
  if (claim === null) return;

  try {
    await updateApplication(ctx, claim.value.application, (current) => ({
      ...current,
      domains: current.domains.filter((domain) => domain !== host),
    }));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  await deleteKey(ctx, key);
}

/** Backs the Caddy on-demand-TLS ask endpoint: is this host ours to serve? */
export async function checkDomain(ctx: RegistryContext, host: string): Promise<DomainClaim | null> {
  const found = await readJson<DomainClaim>(ctx, domainKey(host));
  return found === null ? null : found.value;
}
