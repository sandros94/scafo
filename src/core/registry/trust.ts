/* Which CI issuers may deploy an application, and which of their subjects. */

import type { TrustIssuer, TrustPolicy } from "../types/registry.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, requireJson, updateJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { trustKey } from "./paths.ts";

/**
 * Replaces the application's trust policy, creating it when absent.
 *
 * The policy may be written before the application exists: an admin pre-grants
 * a name, and the first deploy under it creates the application.
 */
export async function setTrustPolicy(
  ctx: RegistryContext,
  application: string,
  policy: TrustPolicy,
): Promise<TrustPolicy> {
  const key = trustKey(application);

  try {
    await createJson(ctx, key, policy);
    return policy;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const updated = await updateJson<TrustPolicy>(ctx, key, () => policy);
    return updated.value;
  }
}

export async function getTrustPolicy(
  ctx: RegistryContext,
  application: string,
): Promise<TrustPolicy> {
  const found = await requireJson<TrustPolicy>(ctx, trustKey(application));
  return found.value;
}

/**
 * Finds the issuer that authorizes `claims`: `iss` and `aud` must match exactly,
 * then any one of its subject patterns must match `sub`. Patterns are literal
 * except for `*`, which matches any run of characters. Null means no match, and
 * callers must treat that as a denial.
 */
export function matchTrust(
  policy: TrustPolicy | null,
  claims: { iss: string; aud: string; sub: string },
): TrustIssuer | null {
  if (policy === null) return null;

  for (const issuer of policy.issuers) {
    if (issuer.iss !== claims.iss || issuer.aud !== claims.aud) continue;
    if (issuer.subjects.some((pattern) => matchesSubject(pattern, claims.sub))) return issuer;
  }
  return null;
}

function matchesSubject(pattern: string, subject: string): boolean {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "s").test(subject);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}
