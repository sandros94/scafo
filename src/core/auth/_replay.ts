/* Internal: single-use enforcement for node token ids. */

import { createBoundedMap } from "./_cache.ts";

export interface ReplayCacheOptions {
  now: () => Date;
  /** Maximum token ids held. Defaults to {@link REPLAY_CAPACITY}. */
  capacity?: number;
}

export interface ReplayCache {
  /** True when `jti` was recorded and has not yet expired. */
  seen(jti: string): boolean;
  /** Records `jti` as spent until `expiresAtMs`. */
  record(jti: string, expiresAtMs: number): void;
}

/** Roughly 5 MB of ids; enough to cover the busiest 60-second window. */
export const REPLAY_CAPACITY: number = 100_000;

/**
 * Remembers spent token ids until they expire, so a captured token cannot be
 * used twice.
 *
 * CAVEAT: the window is per process. Nodes are stateless and share no state, so
 * a token replayed against a different daemon instance is caught only by its
 * lifetime (≤60s), not by this cache.
 */
export function createReplayCache(opts: ReplayCacheOptions): ReplayCache {
  const capacity = opts.capacity ?? REPLAY_CAPACITY;
  const spent = createBoundedMap<number>(capacity);

  return {
    seen(jti) {
      const expiresAtMs = spent.get(jti);
      if (expiresAtMs === undefined) return false;
      if (expiresAtMs > opts.now().getTime()) return true;

      spent.delete(jti);
      return false;
    },

    record(jti, expiresAtMs) {
      /* Expired ids are swept only under pressure; the sweep is O(size). */
      if (spent.size >= capacity) {
        const nowMs = opts.now().getTime();
        spent.prune((expiry) => expiry > nowMs);
      }
      spent.set(jti, expiresAtMs);
    },
  };
}
