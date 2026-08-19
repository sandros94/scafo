/* Internal: OIDC discovery and the per-issuer JWKS cache (keys reused ≤5 min). */

import type { JWKSet } from "unjwt/jwk";
import { isJWKSet } from "unjwt/utils";
import { authInvalid } from "./_shared.ts";

export interface JwksCacheOptions {
  /** How long a fetched key set is reused. */
  ttlS: number;
  fetchFn: typeof fetch;
  now: () => Date;
}

export interface JwksCache {
  /**
   * Key set of `iss`, discovered on first use and refetched once stale. Callers
   * must check `iss` against the trust policy first: this fetches whatever URL
   * the issuer names.
   */
  get(iss: string): Promise<JWKSet>;
}

export function createJwksCache(opts: JwksCacheOptions): JwksCache {
  const ttlMs = opts.ttlS * 1000;
  const entries = new Map<string, { keys: JWKSet; fetchedAt: number }>();

  return {
    async get(iss) {
      const nowMs = opts.now().getTime();
      const cached = entries.get(iss);
      if (cached !== undefined && nowMs - cached.fetchedAt < ttlMs) return cached.keys;

      /* TODO: a key rotated mid-TTL is only picked up once the entry goes
         stale; refetching on an unknown kid would let a caller drive traffic
         to the issuer. */
      const keys = await fetchKeys(opts.fetchFn, iss);
      entries.set(iss, { keys, fetchedAt: nowMs });
      return keys;
    },
  };
}

async function fetchKeys(fetchFn: typeof fetch, iss: string): Promise<JWKSet> {
  const discovery = `${iss.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const document = await fetchJson(fetchFn, discovery);

  const jwksUri = (document as { jwks_uri?: unknown }).jwks_uri;
  if (typeof jwksUri !== "string" || !isHttpUrl(jwksUri)) {
    throw authInvalid(`${discovery} has no usable "jwks_uri"`);
  }

  const keys = await fetchJson(fetchFn, jwksUri);
  if (!isJWKSet(keys)) throw authInvalid(`${jwksUri} is not a JWK Set`);
  return keys;
}

async function fetchJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw authInvalid(`Requesting ${url} failed`, error);
  }
  if (!response.ok) throw authInvalid(`${url} responded ${String(response.status)}`);

  try {
    return await response.json();
  } catch (error) {
    throw authInvalid(`${url} did not return JSON`, error);
  }
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || url.protocol === "http:";
}
