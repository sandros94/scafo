/* Internal: caller keys and their authorization, cached together for a TTL. */

import { importKey } from "unjwt/jwk";
import { isCryptoKey } from "unjwt/utils";
import { isScafoError, ScafoError } from "../error.ts";
import { readJson } from "../registry/cas.ts";
import type { RegistryContext } from "../registry/context.ts";
import { readOperator, type TrustedOperator } from "../registry/operators.ts";
import { nodeKey, operatorKey } from "../registry/paths.ts";
import type { NodeRecord, OperatorRecord } from "../types/registry.ts";
import { createConcurrencyGate } from "../utils/concurrency.ts";
import { createBoundedMap } from "./_cache.ts";

export interface NodeKeyCacheOptions {
  /** How long a lookup — including a negative one — stays valid. */
  ttlS: number;
  now: () => Date;
  /** Maximum positive identities held. Defaults to {@link NODE_KEY_CAPACITY}. */
  capacity?: number;
  /** Maximum negative identities held. Defaults to {@link NODE_KEY_NEGATIVE_CAPACITY}. */
  negativeCapacity?: number;
  /** Registry lookups in flight at one time. Defaults to {@link NODE_KEY_LOOKUP_CONCURRENCY}. */
  lookupConcurrency?: number;
  /** Distinct lookups allowed to wait. Overflow is refused without a registry read. */
  lookupQueue?: number;
}

export type CachedKeyIdentity =
  | { kind: "node"; nodeId: string }
  | { kind: "operator"; nodeId: string; operator: TrustedOperator };

export interface CachedNodeKey {
  key: CryptoKey;
  identity: CachedKeyIdentity;
}

export interface NodeKeyCache {
  /**
   * The verification key and exact authorization of `kid`, or null when neither
   * namespace holds one usable, unambiguous identity.
   */
  get(kid: string): Promise<CachedNodeKey | null>;
}

/** Positive callers are long-lived fleet identities, never eviction pressure from misses. */
export const NODE_KEY_CAPACITY: number = 10_000;
/** Unknown ids are attacker-controlled, so their cache has a smaller, separate bound. */
export const NODE_KEY_NEGATIVE_CAPACITY: number = 1_000;
/** Independent unknown identities may cost at most this many simultaneous read pairs. */
export const NODE_KEY_LOOKUP_CONCURRENCY: number = 8;
/** Waiting unknown identities are bounded separately from work already dispatched. */
export const NODE_KEY_LOOKUP_QUEUE: number = 32;

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * Caches a caller's public key with the namespace and operator authorization it
 * verified against. A warm key therefore keeps exactly its old identity until
 * the TTL expires; a registry rewrite cannot turn it into another caller.
 */
export function createNodeKeyCache(ctx: RegistryContext, opts: NodeKeyCacheOptions): NodeKeyCache {
  assertCacheOptions(opts);
  const ttlMs = opts.ttlS * 1000;
  const positives = createBoundedMap<CacheEntry<CachedNodeKey>>(opts.capacity ?? NODE_KEY_CAPACITY);
  const negatives = createBoundedMap<CacheEntry<null>>(
    opts.negativeCapacity ?? NODE_KEY_NEGATIVE_CAPACITY,
  );
  const lookups = createConcurrencyGate(opts.lookupConcurrency ?? NODE_KEY_LOOKUP_CONCURRENCY, {
    maxQueue: opts.lookupQueue ?? NODE_KEY_LOOKUP_QUEUE,
  });
  const pending = new Map<string, Promise<CachedNodeKey | null>>();

  return {
    async get(kid) {
      const nowMs = opts.now().getTime();
      const positive = positives.get(kid);
      if (positive !== undefined && fresh(positive, nowMs, ttlMs)) return positive.value;

      const negative = negatives.get(kid);
      if (negative !== undefined && fresh(negative, nowMs, ttlMs)) return null;

      const shared = pending.get(kid);
      if (shared !== undefined) return shared;

      const started = lookups.tryRun(() => load(ctx, kid));
      if (started === null) return null;

      pending.set(kid, started);
      try {
        const entry = await started;
        if (entry === null) negatives.set(kid, { value: null, fetchedAt: nowMs });
        else positives.set(kid, { value: entry, fetchedAt: nowMs });
        return entry;
      } finally {
        pending.delete(kid);
      }
    },
  };
}

async function load(ctx: RegistryContext, kid: string): Promise<CachedNodeKey | null> {
  let operator: OperatorRecord | null;
  let node: NodeRecord | null;
  try {
    [operator, node] = await Promise.all([
      readJson<OperatorRecord>(ctx, operatorKey(kid)).then((found) => found?.value ?? null),
      readJson<NodeRecord>(ctx, nodeKey(kid)).then((found) => found?.value ?? null),
    ]);
  } catch (error) {
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }

  if (operator !== null && node !== null) return null;
  if (operator === null && node === null) return null;
  if (operator !== null && operator.id !== kid) return null;
  if (node !== null && node.id !== kid) return null;
  if (operator !== null) {
    return importCachedKey(operator.publicKey, {
      kind: "operator",
      nodeId: kid,
      operator: readOperator(operator),
    });
  }
  if (node === null) return null;
  return importCachedKey(node.publicKey, { kind: "node", nodeId: kid });
}

async function importCachedKey(
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string },
  identity: CachedKeyIdentity,
): Promise<CachedNodeKey | null> {
  try {
    const key = await importKey(publicKey, { alg: "EdDSA", expect: "public" });
    return isCryptoKey(key) ? { key, identity } : null;
  } catch {
    return null;
  }
}

function fresh(entry: CacheEntry<unknown>, nowMs: number, ttlMs: number): boolean {
  return nowMs - entry.fetchedAt < ttlMs;
}

function assertCacheOptions(opts: NodeKeyCacheOptions): void {
  assertFiniteAtLeast("ttlS", opts.ttlS, 0);
  assertSafeCount("capacity", opts.capacity, 0);
  assertSafeCount("negativeCapacity", opts.negativeCapacity, 0);
  assertSafeCount("lookupConcurrency", opts.lookupConcurrency, 1);
  assertSafeCount("lookupQueue", opts.lookupQueue, 0);
}

function assertFiniteAtLeast(name: string, value: number, minimum: number): void {
  if (Number.isFinite(value) && value >= minimum) return;
  throw invalidCacheOption(name, `a finite number at least ${String(minimum)}`, value);
}

function assertSafeCount(name: string, value: number | undefined, minimum: number): void {
  if (value === undefined) return;
  if (Number.isSafeInteger(value) && value >= minimum) return;
  throw invalidCacheOption(name, `a safe integer at least ${String(minimum)}`, value);
}

function invalidCacheOption(name: string, wanted: string, value: number): ScafoError {
  return new ScafoError("invalid-input", "Invalid node key cache option", {
    detail: `"${name}" must be ${wanted}, got ${String(value)}`,
  });
}
