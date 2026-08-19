/* Internal: node public keys, read from the registry and cached for a TTL. */

import { importKey } from "unjwt/jwk";
import { isCryptoKey } from "unjwt/utils";
import { isScaloError } from "../error.ts";
import type { RegistryContext } from "../registry/context.ts";
import { getNode } from "../registry/nodes.ts";
import { createBoundedMap } from "./_cache.ts";

export interface NodeKeyCacheOptions {
  /** How long a lookup — including a negative one — stays valid. */
  ttlS: number;
  now: () => Date;
  /** Maximum distinct key ids held. Defaults to {@link NODE_KEY_CAPACITY}. */
  capacity?: number;
}

export interface NodeKeyCache {
  /** Verification key of `kid`, or `null` when no usable node record exists. */
  get(kid: string): Promise<CryptoKey | null>;
}

/** Registry nodes are few; the cap only bounds lookups of ids that do not exist. */
export const NODE_KEY_CAPACITY: number = 10_000;

/**
 * Caches the Ed25519 public key of every node id looked up, negative results
 * included. The TTL is the revocation bound: a node deleted from the registry
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
 * Reads and imports a node's key. An absent node, an id no key could be stored
 * under, and an unimportable key are all "no key" — the caller turns that into
 * the same rejection every other failure produces. Store failures propagate:
 * they say nothing about the token.
 */
async function load(ctx: RegistryContext, kid: string): Promise<CryptoKey | null> {
  let publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  try {
    ({ publicKey } = await getNode(ctx, kid));
  } catch (error) {
    if (isScaloError(error) && (error.code === "not-found" || error.code === "invalid-slug")) {
      return null;
    }
    throw error;
  }

  try {
    const imported = await importKey(publicKey, { alg: "EdDSA", expect: "public" });
    return isCryptoKey(imported) ? imported : null;
  } catch {
    return null;
  }
}
