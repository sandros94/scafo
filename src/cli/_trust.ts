/* Project OIDC trust-policy editing and output. */

import { OIDC_AUDIENCE } from "../core/auth/oidc.ts";
import { ScafoError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { trustKey } from "../core/registry/paths.ts";
import { setTrustPolicy } from "../core/registry/trust.ts";
import type { TrustIssuer, TrustPolicy } from "../core/types/registry.ts";

/** An empty policy: a project that admits no workload token at all. */
export const EMPTY_TRUST_POLICY: TrustPolicy = { v: 1, issuers: [] };

export interface SetTrustIssuerOptions {
  project: string;
  /** Issuer URL, exactly as the tokens it mints carry it in `iss`. */
  iss: string;
  /** Audience the workload must request its token for. */
  aud: string;
  /** Subject patterns admitted; `*` matches any run of characters. */
  subjects: string[];
}

/**
 * Adds an issuer to a project's policy, or replaces the subjects of one already
 * there.
 *
 * The match is on issuer AND audience together, because they are one grant: the
 * same issuer minting tokens for a second audience is a second entry, and
 * replacing the subjects of one must not touch the other. Everything else in the
 * policy is left as it stands, so setting up a second CI provider never quietly
 * revokes the first.
 */
export async function setTrustIssuer(
  registry: RegistryContext,
  opts: SetTrustIssuerOptions,
): Promise<TrustPolicy> {
  assertIssuerUrl(opts.iss);
  if (opts.subjects.length === 0) {
    throw new ScafoError("invalid-input", "No subject given", {
      detail:
        `--subject must name at least one subject the issuer is trusted for, such as ` +
        `"repo:acme/shop:ref:refs/heads/*"; an issuer with no subject admits nothing and ` +
        `is indistinguishable from not being trusted at all`,
    });
  }

  const current = await readTrustPolicy(registry, opts.project);
  const entry: TrustIssuer = { iss: opts.iss, aud: opts.aud, subjects: [...opts.subjects] };

  const replaced = current.issuers.some(
    (issuer) => issuer.iss === opts.iss && issuer.aud === opts.aud,
  );
  const issuers = replaced
    ? current.issuers.map((issuer) =>
        issuer.iss === opts.iss && issuer.aud === opts.aud ? entry : issuer,
      )
    : [...current.issuers, entry];

  return setTrustPolicy(registry, opts.project, { v: 1, issuers });
}

/**
 * Removes every entry naming `iss`, whatever audience it was granted for.
 *
 * The document stays, with no issuers left in it: an empty policy and a missing
 * one deny the same tokens, and one that is there says the project has a policy
 * somebody has looked at.
 *
 * Throws `ScafoError("not-found")` when the project does not trust that issuer
 * at all — a mistyped URL that reported success would leave the issuer it was
 * meant to revoke still trusted.
 */
export async function removeTrustIssuer(
  registry: RegistryContext,
  project: string,
  iss: string,
): Promise<TrustPolicy> {
  const current = await readTrustPolicy(registry, project);
  const issuers = current.issuers.filter((issuer) => issuer.iss !== iss);

  if (issuers.length === current.issuers.length) {
    throw new ScafoError("not-found", "Issuer is not trusted", {
      detail:
        `"${project}" does not trust "${iss}"; it trusts ` +
        `${current.issuers.length === 0 ? "no issuer at all" : current.issuers.map((issuer) => `"${issuer.iss}"`).join(", ")}`,
    });
  }
  return setTrustPolicy(registry, project, { v: 1, issuers });
}

/**
 * The policy as it stands, or an empty one when the project has none. A project
 * with no policy is not an error to look at: it is the state every project
 * starts in, and the answer — nothing may deploy it with a workload token — is
 * the same one an empty policy gives.
 */
export async function readTrustPolicy(
  registry: RegistryContext,
  project: string,
): Promise<TrustPolicy> {
  const found = await readJson<TrustPolicy>(registry, trustKey(project));
  return found?.value ?? EMPTY_TRUST_POLICY;
}

/**
 * Renders a policy, one issuer per block and one subject per line.
 *
 * Subjects are printed verbatim, globs and all: an operator checking a policy is
 * checking the pattern, and a `*` rendered as anything else would hide exactly
 * the mistake they are looking for.
 */
export function formatTrustPolicy(policy: TrustPolicy): string {
  if (policy.issuers.length === 0) {
    return "no issuer is trusted, so no workload token can deploy this project";
  }

  return policy.issuers
    .map((issuer) =>
      [
        `${issuer.iss} (aud ${issuer.aud})`,
        ...issuer.subjects.map((subject) => `  ${subject}`),
      ].join("\n"),
    )
    .join("\n");
}

/** Audience a workload requests its token for when the operator names none. */
export const DEFAULT_TRUST_AUDIENCE: string = OIDC_AUDIENCE;

/**
 * An issuer is an https URL: discovery is `<iss>/.well-known/openid-configuration`,
 * so anything else is a policy entry no token could ever match.
 *
 * `http` is allowed alongside it because a self-hosted issuer on a private
 * network is a real setup, and the verifier already refuses everything that is
 * neither.
 */
function assertIssuerUrl(iss: string): void {
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    throw invalidIssuer(iss, "it is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidIssuer(iss, `"${url.protocol}" is neither https nor http`);
  }
}

function invalidIssuer(iss: string, why: string): ScafoError {
  return new ScafoError("invalid-input", "Invalid issuer", {
    detail:
      `--issuer must be the URL the tokens carry in their "iss" claim, because that is what ` +
      `"<iss>/.well-known/openid-configuration" is asked for, and ${why}: got "${iss}"`,
  });
}
