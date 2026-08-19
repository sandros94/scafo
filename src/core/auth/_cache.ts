/* Internal: the bounded map both auth caches are built on. */

/**
 * Fixed-capacity map. Entries keep insertion order, so a write past `capacity`
 * drops the oldest ones — an unauthenticated caller cannot grow it without bound
 * by inventing key ids or token ids.
 */
export interface BoundedMap<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  /** Drops every entry `keep` rejects. */
  prune(keep: (value: T) => boolean): void;
  readonly size: number;
}

export function createBoundedMap<T>(capacity: number): BoundedMap<T> {
  const entries = new Map<string, T>();

  return {
    get(key) {
      return entries.get(key);
    },

    set(key, value) {
      /* Delete first so a refreshed entry counts as the newest one. */
      entries.delete(key);
      entries.set(key, value);

      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },

    delete(key) {
      entries.delete(key);
    },

    prune(keep) {
      for (const [key, value] of entries) {
        if (!keep(value)) entries.delete(key);
      }
    },

    get size() {
      return entries.size;
    },
  };
}
