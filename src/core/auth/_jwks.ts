/* Internal: OIDC discovery and the per-issuer JWKS cache (keys reused ≤5 min). */

import type { JWKSet } from "unjwt/jwk";
import { isJWKSet } from "unjwt/utils";
import { authInvalid } from "./_shared.ts";

export interface JwksCacheOptions {
  /** How long a fetched key set is reused. */
  ttlS: number;
  /** How long a failed discovery is reused before retrying it. */
  failureTtlS: number;
  /** Maximum issuer entries, including in-flight and failed discoveries. */
  maxEntries: number;
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
  const failureTtlMs = opts.failureTtlS * 1000;
  const entries = new Map<string, Entry>();

  return {
    async get(iss) {
      const nowMs = opts.now().getTime();
      const cached = entries.get(iss);
      if (
        cached?.keys !== undefined &&
        cached.fetchedAt !== undefined &&
        nowMs - cached.fetchedAt < ttlMs
      ) {
        touch(entries, iss, cached);
        return cached.keys;
      }
      if (
        cached?.failure !== undefined &&
        cached.failedAt !== undefined &&
        nowMs - cached.failedAt < failureTtlMs
      ) {
        touch(entries, iss, cached);
        throw cached.failure;
      }
      if (cached?.inFlight !== undefined) return cached.inFlight;

      /* TODO: a key rotated mid-TTL is only picked up once the entry goes
         stale; refetching on an unknown kid would let a caller drive traffic
         to the issuer. */
      const entry = cached ?? reserve(entries, iss, opts.maxEntries);
      delete entry.keys;
      delete entry.fetchedAt;
      delete entry.failure;
      delete entry.failedAt;
      const inFlight = fetchKeys(opts.fetchFn, iss).then(
        (keys) => {
          settle(entries, iss, entry, { keys, fetchedAt: opts.now().getTime() });
          return keys;
        },
        (error: unknown) => {
          const failure =
            error instanceof Error ? error : authInvalid("Issuer discovery failed", error);
          settle(entries, iss, entry, { failure, failedAt: opts.now().getTime() });
          throw failure;
        },
      );
      entry.inFlight = inFlight;
      touch(entries, iss, entry);
      return inFlight;
    },
  };
}

interface Entry {
  keys?: JWKSet;
  fetchedAt?: number;
  failure?: Error;
  failedAt?: number;
  inFlight?: Promise<JWKSet>;
}

function touch(entries: Map<string, Entry>, iss: string, entry: Entry): void {
  entries.delete(iss);
  entries.set(iss, entry);
}

function reserve(entries: Map<string, Entry>, iss: string, maxEntries: number): Entry {
  while (entries.size >= maxEntries) {
    const evictable = [...entries].find(([, entry]) => entry.inFlight === undefined);
    if (evictable === undefined) {
      throw authInvalid("OIDC key cache is busy fetching configured issuers");
    }
    entries.delete(evictable[0]);
  }
  const entry: Entry = {};
  entries.set(iss, entry);
  return entry;
}

function settle(
  entries: Map<string, Entry>,
  iss: string,
  entry: Entry,
  result: Omit<Entry, "inFlight">,
): void {
  if (entries.get(iss) !== entry) return;
  delete entry.inFlight;
  Object.assign(entry, result);
  touch(entries, iss, entry);
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
