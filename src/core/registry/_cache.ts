/*
 * The pure half of the registry view: what a listing says has to be read, and
 * which kinds of record are due for a look at all.
 *
 * Nothing here touches a bucket or a clock. The view hands it a listing, a cache
 * and a moment, and gets back a decision it can carry out — which is what makes
 * "unchanged costs nothing" a property a unit test can hold.
 */

import type { StoredEntry } from "../types/store.ts";

/** The kinds of record a view keeps, each listed under a prefix of its own. */
export const REGISTRY_KINDS: readonly RegistryKind[] = [
  "applications",
  "placements",
  "nodes",
] as const;

export type RegistryKind = "applications" | "placements" | "nodes";

/** One cached record, filed under the ETag it was read at. */
export interface CachedRecord<T> {
  etag: string;
  value: T;
}

/** What one listing, held against the cache, says a refresh has to do. */
export interface ListingDiff {
  /**
   * Names whose ETag differs from the cached one, or that were never cached:
   * exactly the records that have to be read, and nothing else.
   */
  changed: string[];
  /** Cached names the listing no longer carries; the objects are gone. */
  dropped: string[];
  /** Names the listing and the cache agree on; their cached values still stand. */
  unchanged: string[];
}

/**
 * Holds `entries` against `cached` and says which records have to be read.
 *
 * `nameOf` answers the name a key belongs to, or null for a key that is no
 * record of this kind — a phantom, a nested key, or something else that was once
 * written under the prefix. Those are ignored rather than read.
 */
export function diffListing<T>(
  entries: readonly StoredEntry[],
  cached: ReadonlyMap<string, CachedRecord<T>>,
  nameOf: (key: string) => string | null,
): ListingDiff {
  const diff: ListingDiff = { changed: [], dropped: [], unchanged: [] };
  const listed = new Set<string>();

  for (const entry of entries) {
    const name = nameOf(entry.key);
    if (name === null) continue;

    listed.add(name);
    if (cached.get(name)?.etag === entry.etag) diff.unchanged.push(name);
    else diff.changed.push(name);
  }

  for (const name of cached.keys()) {
    if (!listed.has(name)) diff.dropped.push(name);
  }

  diff.changed.sort();
  diff.dropped.sort();
  diff.unchanged.sort();
  return diff;
}

/** Everything the decision of what to refresh is made from. */
export interface RefreshDecision {
  nowMs: number;
  /** The token the hint carries right now; null when there is none to read. */
  hint: string | null;
  /** The token the last pass saw; undefined before any pass has looked. */
  lastHint?: string | null;
  /** When every kind was last refreshed together; null before the first time. */
  lastResyncMs: number | null;
  /** When the nodes were last refreshed; null before the first time. */
  lastNodesMs: number | null;
  /** How long a view may go without a full refresh, however quiet the hint is. */
  resyncIntervalMs: number;
  /** How often liveness is re-read, since no write announces a death. */
  nodeRefreshIntervalMs: number;
}

/**
 * The kinds a pass has to refresh, in listing order and without repeats.
 *
 * Three reasons, and they compose: the view has never been read, or its full
 * resync is due, which both mean every kind; the hint moved, which means every
 * kind routing is decided from; and the node timer is up, which means the nodes.
 * An empty answer is the ordinary case — an installation where nothing happened
 * — and it is what makes an idle pass cost one GET.
 *
 * A MOVED TOKEN ASKS FOR THE NODES TOO, although no heartbeat ever mints one.
 * The token is opaque, so a reader cannot tell which kind moved, and the two
 * changes that are hinted about a node — what it serves, and that it is draining
 * — are the ones the fleet's routing is rendered from. Refreshing only the
 * applications and their placements would leave a route pointing at a port
 * nothing answers on until the node timer came round.
 */
export function kindsDue(input: RefreshDecision): RegistryKind[] {
  if (input.lastResyncMs === null) return [...REGISTRY_KINDS];
  if (input.nowMs - input.lastResyncMs >= input.resyncIntervalMs) return [...REGISTRY_KINDS];
  /* `undefined` is "never looked", which the first branch above already covers;
     what is compared here is one token against the one before it, and a hint
     that has gone from absent to present is a change like any other. */
  if (input.hint !== input.lastHint) return [...REGISTRY_KINDS];

  const due = new Set<RegistryKind>();
  if (
    input.lastNodesMs === null ||
    input.nowMs - input.lastNodesMs >= input.nodeRefreshIntervalMs
  ) {
    due.add("nodes");
  }
  return REGISTRY_KINDS.filter((kind) => due.has(kind));
}
