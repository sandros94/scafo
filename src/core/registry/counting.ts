/*
 * What a piece of work cost the bucket: a {@link CasStore} that counts the
 * operations dispatched through it, and the {@link RegistryContext} wrapping one.
 *
 * PASSTHROUGH IN EVERY OTHER RESPECT. It answers, raises and preserves ETags
 * exactly as the store it wraps does — a counted store and the store under it
 * are indistinguishable to anything but the counter, which is what makes it safe
 * to put one in front of a reconcile pass or a held request.
 *
 * THE COUNTS ARE MONOTONIC AND THE CALLER TAKES DELTAS. A wrapper is per-caller
 * rather than per-installation for exactly that reason: two callers sharing one
 * would each read the other's work into their own numbers.
 */

import type { RegistryContext } from "./context.ts";
import type { ByteRange, CasHeaders, CasStore, StoredObject } from "../types/store.ts";

/** Store operations dispatched, by kind, since the counter was created. */
export interface StoreOpCounts {
  get: number;
  put: number;
  del: number;
  /**
   * Listings, counted apart from the rest: one costs a page per thousand keys
   * rather than a round trip, so a pass that lists is not comparable to one that
   * reads the same number of objects.
   */
  list: number;
}

/** A {@link CasStore} that says how much has gone through it. */
export interface CountingStore extends CasStore {
  /** The counts as they stand; a fresh object, safe to keep as a baseline. */
  counts(): StoreOpCounts;
}

/** A {@link RegistryContext} whose store is counted, with the counter beside it. */
export interface CountedRegistry {
  /** Hand this to the work being measured, and nothing else. */
  registry: RegistryContext;
  counts(): StoreOpCounts;
}

/**
 * Counts every operation dispatched through `inner`.
 *
 * An operation is counted when it is DISPATCHED, not when it succeeds: a read
 * that raised still cost a round trip, and a pass that spent its time failing is
 * the one whose cost is worth reading.
 */
export function createCountingStore(inner: CasStore): CountingStore {
  const counts: StoreOpCounts = { get: 0, put: 0, del: 0, list: 0 };

  return {
    get(key: string): Promise<StoredObject | null> {
      counts.get++;
      return inner.get(key);
    },

    /* Counted as a read, because that is what it costs: the same round trip,
       answered without the text decode. */
    getBytes(key: string, opts?: { range: ByteRange }): Promise<Uint8Array | null> {
      counts.get++;
      return inner.getBytes(key, opts);
    },

    put(key: string, body: string, cas?: CasHeaders): Promise<{ etag: string }> {
      counts.put++;
      return inner.put(key, body, cas);
    },

    del(key: string): Promise<void> {
      counts.del++;
      return inner.del(key);
    },

    list(prefix: string): Promise<string[]> {
      counts.list++;
      return inner.list(prefix);
    },

    counts: (): StoreOpCounts => ({ ...counts }),
  };
}

/**
 * The same context with a counted store under it, and everything else — the
 * injected clock above all — carried over unchanged.
 */
export function countingRegistry(ctx: RegistryContext): CountedRegistry {
  const store = createCountingStore(ctx.store);
  return { registry: { ...ctx, store }, counts: (): StoreOpCounts => store.counts() };
}

/** Reads, writes and deletes together: round trips, as against {@link StoreOpCounts.list}. */
export function storeOpsOf(counts: StoreOpCounts): number {
  return counts.get + counts.put + counts.del;
}
