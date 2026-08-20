/* Node and operator tokens: short-lived, single-use EdDSA bearer tokens. */

import type { JWK_OKP_Private, JWK_OKP_SIGN } from "unjwt/jwk";
import { importKey } from "unjwt/jwk";
import { sign as signJws, verify as verifyJws } from "unjwt/jws";
import { isCryptoKey } from "unjwt/utils";
import { ScafoError } from "../error.ts";
import type { RegistryContext } from "../registry/context.ts";
import { toBase64Url } from "../utils/base64.ts";
import { createNodeKeyCache } from "./_key-cache.ts";
import { createReplayCache } from "./_replay.ts";
import { asClaims, authInvalid, decodeCompactHeader, numberClaim, stringClaim } from "./_shared.ts";

/** The only algorithm a node token may carry. */
const ALG = "EdDSA";

/** Audience of every token addressed to a node agent. */
export const NODE_TOKEN_AUDIENCE: string = "scafo-agent";

/** Hard ceiling on a node token's lifetime; longer tokens are refused at both ends. */
export const NODE_TOKEN_MAX_LIFETIME_S: number = 60;

/** An Ed25519 private key, as a `CryptoKey` or its JWK. */
export type NodeSigningKey = CryptoKey | JWK_OKP_Private<JWK_OKP_SIGN>;

/** Claims of a node token. `sub` is the node id, which is also the header `kid`. */
export interface NodeTokenClaims {
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface SignNodeTokenOptions {
  /** Defaults to {@link NODE_TOKEN_AUDIENCE}. */
  aud?: string;
  /** Seconds until `exp`. Defaults to, and may not exceed, {@link NODE_TOKEN_MAX_LIFETIME_S}. */
  lifetimeS?: number;
  now?: () => Date;
}

export interface NodeVerifierOptions {
  /** Audience this verifier answers for. Defaults to {@link NODE_TOKEN_AUDIENCE}. */
  aud?: string;
  /** Clock skew tolerated at both ends of the validity window, in seconds. Defaults to 30. */
  skewS?: number;
  /** Longest `exp - iat` accepted. Defaults to {@link NODE_TOKEN_MAX_LIFETIME_S}. */
  maxLifetimeS?: number;
  /** How long registry public keys are cached — the revocation bound. Defaults to 60. */
  keyTtlS?: number;
  now?: () => Date;
}

/** Who a verified token belongs to. */
export interface NodeIdentity {
  nodeId: string;
  claims: NodeTokenClaims;
}

export interface NodeVerifier {
  /** Resolves the caller's identity, or throws `ScafoError("auth-invalid")`. */
  verify(token: string): Promise<NodeIdentity>;
}

/**
 * Signs a token for `kid`, the signer's node id. Tokens are single-use: each
 * carries a fresh `jti` that a verifier records once and refuses thereafter.
 *
 * Throws `ScafoError("invalid-input")` for a lifetime outside
 * `(0, NODE_TOKEN_MAX_LIFETIME_S]` or a key that is not an Ed25519 private key.
 */
export async function signNodeToken(
  key: NodeSigningKey,
  kid: string,
  opts?: SignNodeTokenOptions,
): Promise<string> {
  const lifetimeS = opts?.lifetimeS ?? NODE_TOKEN_MAX_LIFETIME_S;
  if (!Number.isFinite(lifetimeS) || lifetimeS <= 0 || lifetimeS > NODE_TOKEN_MAX_LIFETIME_S) {
    throw new ScafoError("invalid-input", "Invalid node token lifetime", {
      detail:
        `"lifetimeS" must be greater than 0 and at most ${String(NODE_TOKEN_MAX_LIFETIME_S)}, ` +
        `got ${String(lifetimeS)}`,
    });
  }

  const iat = Math.floor((opts?.now?.() ?? new Date()).getTime() / 1000);
  const claims = {
    sub: kid,
    aud: opts?.aud ?? NODE_TOKEN_AUDIENCE,
    iat,
    exp: iat + lifetimeS,
    jti: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  } satisfies NodeTokenClaims;

  return signJws(claims, await importSigningKey(key), { alg: ALG, protectedHeader: { kid } });
}

/**
 * Builds a verifier for node tokens presented to this agent. Keys come from the
 * registry (`_scafo/nodes/<id>.json`) and are cached, so a deregistered node is
 * rejected at most `keyTtlS` seconds later.
 *
 * Every rejection is `ScafoError("auth-invalid")`, whatever the cause.
 */
export function createNodeVerifier(ctx: RegistryContext, opts?: NodeVerifierOptions): NodeVerifier {
  const aud = opts?.aud ?? NODE_TOKEN_AUDIENCE;
  const skewS = opts?.skewS ?? 30;
  const maxLifetimeS = opts?.maxLifetimeS ?? NODE_TOKEN_MAX_LIFETIME_S;
  const now = opts?.now ?? ((): Date => new Date());

  const keys = createNodeKeyCache(ctx, { ttlS: opts?.keyTtlS ?? 60, now });
  const replay = createReplayCache({ now });

  return {
    async verify(token) {
      const header = decodeCompactHeader(token);
      /* An alg other than EdDSA — "none", an HMAC, a stronger-looking curve —
         is a substitution attempt, never a key the registry could hold. */
      if (header.alg !== ALG) throw authInvalid(`Header "alg" is not ${ALG}`);

      const kid = stringClaim(header, "kid");
      const key = await keys.get(kid);
      if (key === null) throw authInvalid(`No node is registered as "${kid}"`);

      let payload: unknown;
      try {
        ({ payload } = await verifyJws(token, key, {
          algorithms: [ALG],
          validateClaims: false,
        }));
      } catch (error) {
        throw authInvalid("Signature verification failed", error);
      }

      const claims = readClaims(payload);
      if (claims.sub !== kid) throw authInvalid(`Claim "sub" does not match the key id`);
      if (claims.aud !== aud) throw authInvalid(`Claim "aud" is not "${aud}"`);

      const nowS = Math.floor(now().getTime() / 1000);
      if (nowS < claims.iat - skewS) throw authInvalid("Token is not valid yet");
      if (nowS > claims.exp + skewS) throw authInvalid("Token has expired");

      const lifetimeS = claims.exp - claims.iat;
      if (lifetimeS <= 0 || lifetimeS > maxLifetimeS) {
        throw authInvalid(`Token lifetime exceeds ${String(maxLifetimeS)}s`);
      }
      if (replay.seen(claims.jti)) throw authInvalid("Token has already been used");

      replay.record(claims.jti, (claims.exp + skewS) * 1000);
      return { nodeId: kid, claims };
    },
  };
}

async function importSigningKey(key: NodeSigningKey): Promise<CryptoKey> {
  let imported: unknown;
  try {
    imported = await importKey(key, { alg: ALG, expect: "private" });
  } catch (error) {
    throw new ScafoError("invalid-input", "Invalid node signing key", {
      detail: `the key could not be imported as ${ALG}`,
      cause: error,
    });
  }

  if (!isCryptoKey(imported)) {
    throw new ScafoError("invalid-input", "Invalid node signing key", {
      detail: `${ALG} needs an asymmetric key, got symmetric key material`,
    });
  }
  return imported;
}

function readClaims(payload: unknown): NodeTokenClaims {
  const claims = asClaims(payload);
  return {
    sub: stringClaim(claims, "sub"),
    aud: stringClaim(claims, "aud"),
    iat: numberClaim(claims, "iat"),
    exp: numberClaim(claims, "exp"),
    jti: stringClaim(claims, "jti"),
  };
}
