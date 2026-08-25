/* Internal: caller public keys, read from the registry and cached for a TTL. */

import { importKey } from "unjwt/jwk";
import { isCryptoKey } from "unjwt/utils";
import { isScafoError } from "../error.ts";
import { readJson } from "../registry/cas.ts";
import type { RegistryContext } from "../registry/context.ts";
import { nodeKey, operatorKey } from "../registry/paths.ts";
import type { NodeRecord, OperatorRecord } from "../types/registry.ts";
import { createBoundedMap } from "./_cache.ts";

export interface NodeKeyCacheOptions {
  /** How long a lookup — including a negative one — stays valid. */
  ttlS: number;
  now: () => Date;
  /** Maximum distinct key ids held. Defaults to {@link NODE_KEY_CAPACITY}. */
  capacity?: number;
}

export interface NodeKeyCache {
  /**
   * Verification key of `kid`, or `null` when neither namespace holds a usable
   * record for it. See {@link load}: a machine and an operator are the same
   * caller here.
   */
  get(kid: string): Promise<CryptoKey | null>;
}

/** A fleet's machines and keys are few; the cap only bounds lookups of ids that do not exist. */
export const NODE_KEY_CAPACITY: number = 10_000;

/**
 * Caches the Ed25519 public key of every id looked up, negative results
 * included. The TTL is the revocation bound: a record deleted from the registry
 * keeps being accepted for at most `ttlS` seconds.
 */
export function createNodeKeyCache(ctx: RegistryContext, opts: NodeKeyCacheOptions): NodeKeyCache {
  const ttlMs = opts.ttlS * 1000;
  const entries = createBoundedMap<{ key: CryptoKey | null; fetchedAt: number }>(
    opts.capacity ?? NODE_KEY_CAPACITY,
  );

  return {
    async get(kid) {
      const nowMs = opts.now().getTime();
      const cached = entries.get(kid);
      if (cached !== undefined && nowMs - cached.fetchedAt < ttlMs) return cached.key;

      const key = await load(ctx, kid);
      entries.set(kid, { key, fetchedAt: nowMs });
      return key;
    },
  };
}

/**
 * Reads and imports the key `kid` names, out of EITHER namespace.
 *
 * A MACHINE AND AN OPERATOR ARE THE SAME CALLER TO A VERIFIER, which is what
 * survived the split that gave operator keys a keyspace of their own: this
 * resolves a public key from `_scafo/operators/<kid>.json` or
 * `_scafo/nodes/<kid>.json`, and the route the token then reaches is where the
 * two are told apart. One id belongs to one identity — refused from both write
 * sides — so at most one of the two answers, and which one is not this
 * surface's business.
 *
 * BOTH READS GO OUT AT ONCE rather than one after the other. A miss costs the
 * bucket two GETs either way in the worst case, and the difference is a whole
 * round trip in front of every first request of a caller. Steady state is
 * unchanged: this is behind the cache, so a busy fleet pays it once per key per
 * TTL.
 *
 * An absent record, an id no key could be stored under, and an unimportable key
 * are all "no key" — the caller turns that into the same rejection every other
 * failure produces. Store failures propagate: they say nothing about the token.
 */
async function load(ctx: RegistryContext, kid: string): Promise<CryptoKey | null> {
  let publicKey: { kty: "OKP"; crv: "Ed25519"; x: string } | undefined;
  try {
    const [operator, node] = await Promise.all([
      readJson<OperatorRecord>(ctx, operatorKey(kid)),
      readJson<NodeRecord>(ctx, nodeKey(kid)),
    ]);
    publicKey = (operator ?? node)?.value.publicKey;
  } catch (error) {
    /* An id neither keyspace could hold is not a lookup that failed, it is a
       lookup that could not be made — and it says exactly as much about the
       token as a miss does. */
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
  if (publicKey === undefined) return null;

  try {
    const imported = await importKey(publicKey, { alg: "EdDSA", expect: "public" });
    return isCryptoKey(imported) ? imported : null;
  } catch {
    return null;
  }
}
