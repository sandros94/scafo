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
  /** How long one discovery or key-set request may take before it is abandoned. */
  timeoutS: number;
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
  const timeoutMs = opts.timeoutS * 1000;
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
      const inFlight = fetchKeys(opts.fetchFn, iss, timeoutMs).then(
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

async function fetchKeys(fetchFn: typeof fetch, iss: string, timeoutMs: number): Promise<JWKSet> {
  const discovery = `${iss.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const document = await fetchJson(fetchFn, discovery, timeoutMs);

  const jwksUri = (document as { jwks_uri?: unknown }).jwks_uri;
  if (typeof jwksUri !== "string" || !isHttpUrl(jwksUri)) {
    throw authInvalid(`${discovery} has no usable "jwks_uri"`);
  }

  const keys = await fetchJson(fetchFn, jwksUri, timeoutMs);
  if (!isJWKSet(keys)) throw authInvalid(`${jwksUri} is not a JWK Set`);
  return keys;
}

/*
 * Every request carries its own deadline, headers and body alike: an issuer that
 * accepts the connection and then says nothing would otherwise hold the entry
 * open forever, and with it every verification waiting on that one in-flight
 * fetch. The signal is how it is bounded, so an injected `fetchFn` must honour
 * it as `fetch` does.
 */
async function fetchJson(fetchFn: typeof fetch, url: string, timeoutMs: number): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);

  let response: Response;
  try {
    response = await fetchFn(url, { headers: { accept: "application/json" }, signal });
  } catch (error) {
    throw authInvalid(
      signal.aborted ? timedOut(url, timeoutMs) : `Requesting ${url} failed`,
      error,
    );
  }
  if (!response.ok) throw authInvalid(`${url} responded ${String(response.status)}`);

  try {
    return await response.json();
  } catch (error) {
    throw authInvalid(
      signal.aborted ? timedOut(url, timeoutMs) : `${url} did not return JSON`,
      error,
    );
  }
}

function timedOut(url: string, timeoutMs: number): string {
  return `Requesting ${url} timed out after ${String(timeoutMs)}ms`;
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
