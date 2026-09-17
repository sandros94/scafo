/* Workload OIDC tokens: what a CI job presents to deploy a project. */

import type { JWSAlgorithm } from "unjwt/jws";
import { verify as verifyJws } from "unjwt/jws";
import { ScafoError } from "../error.ts";
import { assertPositiveSafeInteger } from "../utils/number.ts";
import type { OidcActor, TrustIssuer, TrustPolicy } from "../types/registry.ts";
import { readJson } from "../registry/cas.ts";
import type { RegistryContext } from "../registry/context.ts";
import { trustKey } from "../registry/paths.ts";
import { matchTrust } from "../registry/trust.ts";
import { createJwksCache } from "./_jwks.ts";
import { asClaims, authInvalid, decodeCompactClaims, numberClaim, stringClaim } from "./_shared.ts";

/**
 * Audience a grant names when the operator chose none, and so the one a workload
 * requests its token for by default. What any single token must carry comes from
 * the trust policy entry admitting it, never from this constant.
 */
export const OIDC_AUDIENCE: string = "scafo";

/**
 * Asymmetric signatures only. An `HS*` token would be "verified" against a
 * published JWKS key as if it were a shared secret, so the family is refused
 * outright rather than filtered per key.
 */
const ALLOWED_ALGS: JWSAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
];

export interface OidcVerifierOptions {
  /** Clock skew tolerated at both ends of the validity window, in seconds. Defaults to 30. */
  skewS?: number;
  /** How long an issuer's JWKS is reused, in seconds. Defaults to 300. */
  jwksTtlS?: number;
  /** How long a failed issuer discovery is backed off, in seconds. Defaults to 30. */
  jwksFailureTtlS?: number;
  /** Maximum issuer key and failure entries remembered at once. Defaults to 64. */
  jwksCacheEntries?: number;
  /** How long one request to an issuer may take, in seconds. Defaults to 5. */
  jwksTimeoutS?: number;
  /** Overrides the global `fetch`, for tests and for proxied deployments. */
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/** Who a verified workload token belongs to, and which policy entry admitted it. */
export interface OidcIdentity {
  /** The auth-owned identity persisted with an admitted workload deployment. */
  actor: OidcActor;
  project: string;
  issuer: TrustIssuer;
}

export interface OidcVerifier {
  /**
   * Resolves the workload's identity for `project`. Throws
   * `ScafoError("auth-invalid")` when the token itself does not hold up, and
   * `ScafoError("trust-mismatch")` when it does but the project's trust policy
   * does not name its issuer or subject.
   */
  verify(token: string, project: string): Promise<OidcIdentity>;
}

/**
 * Builds a verifier for deploy-intake tokens. Trust is checked before anything
 * is fetched: an issuer the project does not name is refused without a request,
 * so a token can never steer the daemon at a URL of its choosing. An issuer or
 * policy selected from unsigned claims is not an authorization result: it is
 * only enough to choose the preconfigured discovery endpoint.
 */
export function createOidcVerifier(ctx: RegistryContext, opts?: OidcVerifierOptions): OidcVerifier {
  const skewS = opts?.skewS ?? 30;
  const now = opts?.now ?? ((): Date => new Date());
  const fetchFn: typeof fetch = opts?.fetchFn ?? ((input, init) => globalThis.fetch(input, init));

  const jwks = createJwksCache({
    ttlS: cacheDuration(opts?.jwksTtlS ?? 300, "jwksTtlS"),
    failureTtlS: cacheDuration(opts?.jwksFailureTtlS ?? 30, "jwksFailureTtlS"),
    maxEntries: cacheEntries(opts?.jwksCacheEntries ?? 64),
    timeoutS: requestTimeout(opts?.jwksTimeoutS ?? 5),
    fetchFn,
    now,
  });

  return {
    async verify(token, project) {
      const iss = stringClaim(decodeCompactClaims(token), "iss");

      const policy = await readJson<TrustPolicy>(ctx, trustKey(project));
      if (policy === null) {
        throw authInvalid("Project has no trust policy");
      }
      if (!policy.value.issuers.some((issuer) => issuer.iss === iss)) {
        throw authInvalid("Issuer is not configured for this project");
      }

      let payload: unknown;
      try {
        ({ payload } = await verifyJws(token, await jwks.get(iss), {
          algorithms: ALLOWED_ALGS,
          validateClaims: false,
        }));
      } catch (error) {
        throw authInvalid("Signature verification failed", error);
      }

      const claims = asClaims(payload);
      const sub = stringClaim(claims, "sub");
      assertWindow(claims, Math.floor(now().getTime() / 1000), skewS);

      /* The audience belongs to the grant, not to this deployment: the same
         issuer minting tokens for a second audience is a second policy entry,
         so what `aud` must name is read from the entries the project wrote for
         `iss`. A token naming none of them was minted for somebody else, which
         is the token failing rather than the policy denying it. */
      const audiences = grantedAudiences(policy.value, iss, claims.aud);
      if (audiences.length === 0) {
        throw authInvalid(`Claim "aud" names no audience "${iss}" is trusted for`);
      }

      const issuer = matchAudiences(policy.value, audiences, { iss, sub });
      if (issuer === null) {
        throw trustMismatch(`"${sub}" is not a trusted subject of "${iss}" for "${project}"`);
      }
      return { actor: { issuer: iss, subject: sub }, project, issuer };
    },
  };
}

/**
 * Audiences `iss` was granted that the token was minted for, in policy order.
 * `aud` is a string or an array of them (RFC 7519 §4.1.3), and each value is a
 * separate grant the token could be presented under.
 */
function grantedAudiences(policy: TrustPolicy, iss: string, aud: unknown): string[] {
  const claimed = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  return policy.issuers
    .filter((issuer) => issuer.iss === iss && claimed.includes(issuer.aud))
    .map((issuer) => issuer.aud);
}

/**
 * The first grant among `audiences` whose subject patterns admit `sub`. A token
 * carrying several granted audiences is admitted under any one of them, so a
 * narrower grant listed first never hides a wider one behind it.
 */
function matchAudiences(
  policy: TrustPolicy,
  audiences: string[],
  claims: { iss: string; sub: string },
): TrustIssuer | null {
  for (const aud of audiences) {
    const issuer = matchTrust(policy, { ...claims, aud });
    if (issuer !== null) return issuer;
  }
  return null;
}

function assertWindow(claims: Record<string, unknown>, nowS: number, skewS: number): void {
  if (nowS > numberClaim(claims, "exp") + skewS) throw authInvalid("Token has expired");
  if (nowS < numberClaim(claims, "iat") - skewS)
    throw authInvalid("Token was issued in the future");

  if (claims.nbf !== undefined && nowS < numberClaim(claims, "nbf") - skewS) {
    throw authInvalid("Token is not valid yet");
  }
}

function trustMismatch(detail: string): ScafoError {
  return new ScafoError("trust-mismatch", "Trust policy does not admit this token", { detail });
}

function cacheDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ScafoError("invalid-input", `Invalid ${name}`, {
      detail: `${name} must be a finite number of seconds at least zero`,
    });
  }
  return value;
}

function cacheEntries(value: number): number {
  assertPositiveSafeInteger(value, "jwksCacheEntries");
  return value;
}

/* Unlike the cache durations, zero is not a setting: it would abandon every
   request before it was sent, leaving no issuer reachable at all. */
function requestTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScafoError("invalid-input", "Invalid jwksTimeoutS", {
      detail: "jwksTimeoutS must be a finite number of seconds above zero",
    });
  }
  return value;
}
