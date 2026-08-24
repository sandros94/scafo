/* Workload OIDC tokens: what a CI job presents to deploy a project. */

import type { JWSAlgorithm } from "unjwt/jws";
import { verify as verifyJws } from "unjwt/jws";
import { ScafoError } from "../error.ts";
import type { TrustIssuer, TrustPolicy } from "../types/registry.ts";
import { readJson } from "../registry/cas.ts";
import type { RegistryContext } from "../registry/context.ts";
import { trustKey } from "../registry/paths.ts";
import { matchTrust } from "../registry/trust.ts";
import { createJwksCache } from "./_jwks.ts";
import { asClaims, authInvalid, decodeCompactClaims, numberClaim, stringClaim } from "./_shared.ts";

/** Audience a workload must request its token for. */
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
  /** Audience this deployment answers for. Defaults to {@link OIDC_AUDIENCE}. */
  aud?: string;
  /** Clock skew tolerated at both ends of the validity window, in seconds. Defaults to 30. */
  skewS?: number;
  /** How long an issuer's JWKS is reused, in seconds. Defaults to 300. */
  jwksTtlS?: number;
  /** Overrides the global `fetch`, for tests and for proxied deployments. */
  fetchFn?: typeof fetch;
  now?: () => Date;
}

/** Who a verified workload token belongs to, and which policy entry admitted it. */
export interface OidcIdentity {
  iss: string;
  sub: string;
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
 * so a token can never steer the daemon at a URL of its choosing.
 */
export function createOidcVerifier(ctx: RegistryContext, opts?: OidcVerifierOptions): OidcVerifier {
  const aud = opts?.aud ?? OIDC_AUDIENCE;
  const skewS = opts?.skewS ?? 30;
  const now = opts?.now ?? ((): Date => new Date());
  const fetchFn: typeof fetch = opts?.fetchFn ?? ((input, init) => globalThis.fetch(input, init));

  const jwks = createJwksCache({ ttlS: opts?.jwksTtlS ?? 300, fetchFn, now });

  return {
    async verify(token, project) {
      const iss = stringClaim(decodeCompactClaims(token), "iss");

      const policy = await readJson<TrustPolicy>(ctx, trustKey(project));
      if (policy === null) {
        throw trustMismatch(`project "${project}" has no trust policy`);
      }
      if (!policy.value.issuers.some((issuer) => issuer.iss === iss)) {
        throw trustMismatch(`project "${project}" does not trust issuer "${iss}"`);
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
      assertAudience(claims.aud, aud);
      assertWindow(claims, Math.floor(now().getTime() / 1000), skewS);

      const issuer = matchTrust(policy.value, { iss, aud, sub });
      if (issuer === null) {
        throw trustMismatch(`"${sub}" is not a trusted subject of "${iss}" for "${project}"`);
      }
      return { iss, sub, project, issuer };
    },
  };
}

/** `aud` is a string or an array of them (RFC 7519 §4.1.3); either must name us. */
function assertAudience(aud: unknown, expected: string): void {
  const values = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!values.includes(expected)) throw authInvalid(`Claim "aud" does not include "${expected}"`);
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
