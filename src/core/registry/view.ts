/*
 * The registry view: one in-memory snapshot of the applications, placements and
 * nodes of the installation, shared by everything on a node that needs them.
 *
 * WHAT IT IS FOR. A periodic pass that read the whole installation to find out
 * that nothing had changed would make an idle fleet pay for its own size several
 * times a minute, forever. This reads the change hint — one GET — and touches
 * nothing else when the token is the one it already saw and no timer is up. When
 * something did move, it lists the kinds that could have moved and reads back
 * only the records whose ETag differs from the one it holds.
 *
 * WHAT IT IS NOT. It is not a cache anyone may write through, and it is not
 * authority: a pass that has to be right about one record still reads that
 * record. Operator routes read the bucket directly for the same reason — an
 * operator asks rarely and must be shown the truth.
 *
 * A REFRESH THAT FAILS THROWS AND CHANGES NOTHING. A registry that could not be
 * read is never "every application was removed": the previous snapshot stands,
 * the caller is told, and the next pass tries again.
 */

import type { ApplicationRecord, NodeRecord, PlacementRecord } from "../types/registry.ts";
import {
  type ConcurrencyGate,
  createConcurrencyGate,
  mapConcurrent,
} from "../utils/concurrency.ts";
import { isSlug } from "../utils/slug.ts";
import {
  type CachedRecord,
  diffListing,
  kindsDue,
  REGISTRY_KINDS,
  type RegistryKind,
} from "./_cache.ts";
import { namesFromKeys } from "./_shared.ts";
import { readJson } from "./cas.ts";
import { readChangeHint, writeChangeHint } from "./changes.ts";
import { nowDate, type RegistryContext } from "./context.ts";
import { NODE_HEARTBEAT_INTERVAL_MS } from "./nodes.ts";
import {
  applicationKey,
  applicationsPrefix,
  NODE_ID_RE,
  nodeKey,
  nodesPrefix,
  placementKey,
  placementPrefix,
} from "./paths.ts";

export type { RegistryKind } from "./_cache.ts";
export { REGISTRY_KINDS } from "./_cache.ts";

/**
 * How long a view may go without reading everything, whatever the hint says.
 *
 * THE BOUND ON A LOST HINT, and the only thing that makes the hint safe to treat
 * as a hint: a token that never landed — an unreachable bucket at the wrong
 * moment, a write that raced a reader — costs at most this much latency, never
 * correctness.
 */
export const DEFAULT_REGISTRY_RESYNC_MS: number = 60_000;

/**
 * How often the node records are re-read.
 *
 * The heartbeat interval, because liveness is the AGE of a heartbeat and no
 * write announces a death: there is nothing for the hint to carry, and a node
 * that stopped beating is only ever noticed by looking.
 */
export const DEFAULT_NODE_REFRESH_INTERVAL_MS: number = NODE_HEARTBEAT_INTERVAL_MS;

/** Everything a view holds, as of the last refresh of each kind. */
export interface RegistrySnapshot {
  /** Application records in name order. */
  applications: readonly ApplicationRecord[];
  /** Placement decisions by application name. */
  placements: ReadonlyMap<string, PlacementRecord>;
  /** Node records in id order. */
  nodes: readonly NodeRecord[];
  /** When each kind was last refreshed, in epoch milliseconds; 0 before the first. */
  readAt: Readonly<Record<RegistryKind, number>>;
}

export interface RegistryView {
  /**
   * Reads the hint, refreshes whatever that and the timers make due, and answers
   * the snapshot that results. This is what a periodic pass calls.
   *
   * Costs ONE GET when the token has not moved and no timer is up. Throws what
   * the registry read threw, leaving the previous snapshot standing.
   */
  sync(): Promise<RegistrySnapshot>;
  /** Refreshes exactly these kinds, whatever the hint and the timers say. */
  refresh(kinds: readonly RegistryKind[]): Promise<RegistrySnapshot>;
  /** What the view holds right now, without touching the bucket. */
  current(): RegistrySnapshot;
  /**
   * Node records no older than the node-refresh interval, refreshing them first
   * when they are. What deploy intake's version-skew gate asks.
   */
  freshNodes(): Promise<readonly NodeRecord[]>;
  /**
   * Mints a change token, so every other node refreshes on its next pass.
   *
   * For the changes the decorator cannot see: what this node SERVES, and that it
   * is draining, both of which live in its own node record — which is not hinted,
   * because a heartbeat rewrites one every thirty seconds. Never throws.
   */
  hint(): Promise<void>;
}

export interface RegistryViewOptions {
  /** Full refresh interval. Defaults to {@link DEFAULT_REGISTRY_RESYNC_MS}. */
  resyncIntervalMs?: number;
  /** Node refresh interval. Defaults to {@link DEFAULT_NODE_REFRESH_INTERVAL_MS}. */
  nodeRefreshIntervalMs?: number;
  /** Record reads in flight at once; a gate may be shared, never nested. */
  concurrency?: number | ConcurrencyGate;
}

/** One kind's caches and the plumbing that reads it. */
interface KindReader<T> {
  prefix: string;
  keyOf: (name: string) => string;
  /** The name a listed key belongs to, or null when it is no record of this kind. */
  nameOf: (key: string) => string | null;
  cache: Map<string, CachedRecord<T>>;
}

/** Builds the view a node's passes share. Nothing is read until it is asked for. */
export function createRegistryView(ctx: RegistryContext, opts?: RegistryViewOptions): RegistryView {
  const resyncIntervalMs = opts?.resyncIntervalMs ?? DEFAULT_REGISTRY_RESYNC_MS;
  const nodeRefreshIntervalMs = opts?.nodeRefreshIntervalMs ?? DEFAULT_NODE_REFRESH_INTERVAL_MS;
  const gate =
    typeof opts?.concurrency === "object"
      ? opts.concurrency
      : createConcurrencyGate(opts?.concurrency);

  const applications = kindReader<ApplicationRecord>(applicationsPrefix(), applicationKey, isSlug);
  const placements = kindReader<PlacementRecord>(placementPrefix(), placementKey, isSlug);
  const nodes = kindReader<NodeRecord>(nodesPrefix(), nodeKey, (name) => NODE_ID_RE.test(name));

  const readAt: Record<RegistryKind, number> = { applications: 0, placements: 0, nodes: 0 };
  let lastResyncMs: number | null = null;
  let lastHint: string | null | undefined;
  /* One refresh at a time, and the next one WAITS rather than joins: the loops
     that share a view ask different questions of it — a pass asks what the hint
     says, the skew gate asks for liveness — and a caller handed the answer to
     somebody else's question would act on a kind that was never refreshed. */
  let chain: Promise<unknown> = Promise.resolve();

  function snapshot(): RegistrySnapshot {
    return {
      applications: [...applications.cache.values()].map((held) => held.value),
      placements: new Map([...placements.cache].map(([name, held]) => [name, held.value] as const)),
      nodes: [...nodes.cache.values()].map((held) => held.value),
      readAt: { ...readAt },
    };
  }

  /**
   * Lists one kind and reads back only what moved, leaving the cache untouched
   * until every read has landed: a listing that answered and a read that did not
   * must not leave a half-refreshed kind behind.
   */
  async function refreshKind<T>(reader: KindReader<T>): Promise<() => void> {
    const entries = await ctx.store.listEntries(reader.prefix);
    const diff = diffListing(entries, reader.cache, reader.nameOf);
    const etags = new Map(
      entries.map((entry) => [reader.nameOf(entry.key) ?? "", entry.etag] as const),
    );

    /* The gate bounds these from the outside and each task holds its slot for the
       one read it makes; a task that awaited the same gate from inside would
       deadlock as soon as every slot was taken. */
    const read = await mapConcurrent(diff.changed, gate, async (name) =>
      readJson<T>(ctx, reader.keyOf(name)),
    );

    return (): void => {
      for (const name of diff.dropped) reader.cache.delete(name);
      for (const [index, name] of diff.changed.entries()) {
        const found = read[index];
        /* Deleted between the listing and the read: absent on the next pass, and
           absent here rather than held at a stale value. */
        if (found === null || found === undefined) {
          reader.cache.delete(name);
          continue;
        }
        /* Filed under the ETag the LISTING named rather than the one the read
           answered with. They differ only when the record moved in between, and
           then the next listing has to see a difference and read it again —
           holding the newer ETag would make the view believe it was current. */
        reader.cache.set(name, { etag: etags.get(name) ?? found.etag, value: found.value });
      }
      sortCache(reader.cache);
    };
  }

  /** Refreshes `kinds` together, committing all of them or none. */
  async function refreshNow(kinds: readonly RegistryKind[]): Promise<RegistrySnapshot> {
    if (kinds.length === 0) return snapshot();

    const commits = await Promise.all(
      kinds.map(async (kind) => {
        if (kind === "applications") return refreshKind(applications);
        if (kind === "placements") return refreshKind(placements);
        return refreshKind(nodes);
      }),
    );

    const at = nowDate(ctx).getTime();
    for (const commit of commits) commit();
    for (const kind of kinds) readAt[kind] = at;
    if (REGISTRY_KINDS.every((kind) => kinds.includes(kind))) lastResyncMs = at;
    return snapshot();
  }

  /** Runs `run` once whatever is already running has finished, failure included. */
  function serialize(run: () => Promise<RegistrySnapshot>): Promise<RegistrySnapshot> {
    const next = chain.then(run, run);
    /* The chain itself must never hold a rejection: a refresh that failed is the
       caller's to hear about, not the next caller's. */
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    sync(): Promise<RegistrySnapshot> {
      return serialize(async () => {
        const hint = await readChangeHint(ctx);
        const due = kindsDue({
          nowMs: nowDate(ctx).getTime(),
          hint,
          lastHint,
          lastResyncMs,
          lastNodesMs: readAt.nodes === 0 ? null : readAt.nodes,
          resyncIntervalMs,
          nodeRefreshIntervalMs,
        });
        const result = await refreshNow(due);
        /* Remembered only once the refresh it asked for has landed: a token
           recorded past a failed read would make the next pass believe it had
           already seen that change. */
        lastHint = hint;
        return result;
      });
    },

    refresh: (kinds): Promise<RegistrySnapshot> => serialize(async () => refreshNow(kinds)),

    current: (): RegistrySnapshot => snapshot(),

    async freshNodes(): Promise<readonly NodeRecord[]> {
      /* The age is re-read after waiting: a refresh that was already running may
         have been the very one this was about to ask for. */
      for (let attempt = 0; attempt < 2; attempt++) {
        const age = nowDate(ctx).getTime() - readAt.nodes;
        if (readAt.nodes !== 0 && age < nodeRefreshIntervalMs) break;
        await serialize(async () => refreshNow(["nodes"]));
      }
      return snapshot().nodes;
    },

    async hint(): Promise<void> {
      await writeChangeHint(ctx.store);
    },
  };
}

/** One kind's reader, with the name rule that says which keys are records of it. */
function kindReader<T>(
  prefix: string,
  keyOf: (name: string) => string,
  isName: (name: string) => boolean,
): KindReader<T> {
  return {
    prefix,
    keyOf,
    nameOf: (key: string): string | null => {
      const [name] = namesFromKeys([key], prefix);
      return name !== undefined && isName(name) ? name : null;
    },
    cache: new Map(),
  };
}

/** Keeps a cache in name order, which is the order every consumer reports in. */
function sortCache<T>(cache: Map<string, CachedRecord<T>>): void {
  const sorted = [...cache].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  cache.clear();
  for (const [name, held] of sorted) cache.set(name, held);
}
