/* Custom domains: one claim per host, mirrored on the environment that serves it. */

import { ScaloError } from "../error.ts";
import type { DomainClaim, EnvironmentRecord } from "../types/registry.ts";
import { isCasConflict, isNotFound } from "./_shared.ts";
import { createJson, deleteKey, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { domainKey, environmentKey } from "./paths.ts";

/**
 * Claims `host` for an environment. Re-claiming for the same environment is
 * idempotent; a claim held by anyone else throws `ScaloError("reference-held")`.
 *
 * Writes go referent-first: the environment is checked, then the claim is
 * created, then the environment lists the host. A crash in between leaves a
 * claim nothing routes to — certificates can be issued, traffic still 404s —
 * and re-running the call repairs it.
 */
export async function claimDomain(
  ctx: RegistryContext,
  host: string,
  project: string,
  env: string,
): Promise<DomainClaim> {
  const key = domainKey(host);
  await requireJson<EnvironmentRecord>(ctx, environmentKey(project, env));

  let claim: DomainClaim = { v: 1, project, environment: env, claimedAt: nowIso(ctx) };
  try {
    await createJson(ctx, key, claim);
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<DomainClaim>(ctx, key);
    if (existing.value.project !== project || existing.value.environment !== env) {
      throw new ScaloError("reference-held", "Domain is claimed by another environment", {
        detail:
          `"${host}" is held by environment "${existing.value.environment}" ` +
          `of project "${existing.value.project}"`,
        cause: error,
      });
    }
    claim = existing.value;
  }

  await updateJson<EnvironmentRecord>(ctx, environmentKey(project, env), (current) =>
    current.domains.includes(host) ? current : { ...current, domains: [...current.domains, host] },
  );

  return claim;
}

/**
 * Drops a claim, removing the host from the environment first so nothing points
 * at a claim that is about to disappear. Absent claims and already-deleted
 * environments are both tolerated, which makes the call safe to re-run.
 */
export async function releaseDomain(ctx: RegistryContext, host: string): Promise<void> {
  const key = domainKey(host);
  const claim = await readJson<DomainClaim>(ctx, key);
  if (claim === null) return;

  try {
    await updateJson<EnvironmentRecord>(
      ctx,
      environmentKey(claim.value.project, claim.value.environment),
      (current) => ({ ...current, domains: current.domains.filter((domain) => domain !== host) }),
    );
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
