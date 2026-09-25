/*
 * What a piece of work costs the bucket, in the terms a bill is written in: how
 * many operations of each kind went through the store, how many bytes they
 * moved, how many LISTING PAGES a real S3 would have answered with, which kind
 * of registry key each one touched, and how many were ever in flight at once.
 *
 * BESIDE `src/core/registry/counting.ts`, NOT INSTEAD OF IT. That counter is
 * what a daemon carries in production — four numbers, monotonic, allocation-free
 * — and this one is a measuring instrument: it resets, it weighs bytes and
 * pages, and it attributes every operation to a key kind, none of which a
 * running node should pay for. It answers `counts()` all the same, so anything
 * that takes a {@link CountingStore} takes this.
 *
 * PASSTHROUGH IN EVERY OTHER RESPECT: it answers, raises and preserves ETags
 * exactly as the store under it does, which is what makes it safe to put in
 * front of a reconcile pass or a held request.
 */

import { isScafoError } from "../../src/core/error.ts";
import type { CountingStore, StoreOpCounts } from "../../src/core/registry/counting.ts";
import {
  applicationsPrefix,
  coordinatorKey,
  deploymentsPrefix,
  deploysPrefix,
  domainsPrefix,
  freezeKey,
  fleetPrefix,
  identitiesPrefix,
  nodesPrefix,
  observePrefix,
  operatorsPrefix,
  placementPrefix,
  tlsLocksPrefix,
  tlsObjectsPrefix,
  trustKey,
} from "../../src/core/registry/paths.ts";
import type {
  ByteRange,
  CasHeaders,
  CasStore,
  StoredEntry,
  StoredHead,
  StoredObject,
} from "../../src/core/types/store.ts";

/** Keys a single S3 `ListObjectsV2` page may name; a listing costs one request per page. */
export const LIST_PAGE_KEYS: number = 1000;

/** Every operation the store interface offers, counted apart from the others. */
export const STORE_OPS: readonly StoreOp[] = [
  "get",
  "getBytes",
  "put",
  "del",
  "list",
  "listEntries",
] as const;

export type StoreOp = "get" | "getBytes" | "put" | "del" | "list" | "listEntries";

/** The kind of record a key names, read off its prefix. */
export const KEY_KINDS: readonly KeyKind[] = [
  "applications",
  "placement",
  "nodes",
  "deploys",
  "deployments",
  "trust",
  "domains",
  "coordinator",
  "freeze",
  "operators",
  "identities",
  "observe",
  "tls",
  "fleets",
  "other",
] as const;

export type KeyKind =
  | "applications"
  | "placement"
  | "nodes"
  | "deploys"
  | "deployments"
  | "trust"
  | "domains"
  | "coordinator"
  | "freeze"
  | "operators"
  | "identities"
  | "observe"
  | "tls"
  | "fleets"
  | "other";

/** What one kind of operation cost. */
export interface OpStat {
  /** Calls dispatched, whether they answered or raised. */
  count: number;
  /**
   * Bytes the call moved: a record's body, a ranged read's slice, or, for a
   * listing, the keys it answered with — which is what a listing transfers.
   */
  bytes: number;
  /** Requests a real S3 would have answered with; only a listing costs more than one. */
  pages: number;
}

/** One operation kind against one kind of key. */
export interface KindRow {
  kind: KeyKind;
  op: StoreOp;
  stat: OpStat;
}

/** Everything one measured stretch of work cost the bucket. */
export interface MeterSnapshot {
  ops: Record<StoreOp, OpStat>;
  /** Only the pairs that happened; the rest would be noise in a table. */
  kinds: KindRow[];
  /** `get` and `getBytes` together: reads, whatever they were read for. */
  gets: number;
  puts: number;
  dels: number;
  /** Listing CALLS, as against the requests they cost. */
  listCalls: number;
  /** Requests the listings cost: one per thousand keys answered, at least one. */
  listPages: number;
  bytesRead: number;
  bytesWritten: number;
  /** Conditional writes the store refused, which a caller re-reads and retries. */
  conflicts: number;
  /** Most operations in flight at one moment: the concurrency the work reached. */
  peakInFlight: number;
  /** Every request together, listing pages included. */
  requests: number;
}

/** A {@link CasStore} that says what went through it, and forgets on demand. */
export interface MeteringStore extends CountingStore {
  /** Forgets everything measured so far, so one scenario is measured alone. */
  reset(): void;
  /** What has gone through since the last {@link MeteringStore.reset}. */
  snapshot(): MeterSnapshot;
}

/** Measures every operation dispatched through `inner`. */
export function meterStore(inner: CasStore): MeteringStore {
  const encoder = new TextEncoder();
  let ops = emptyOps();
  let kinds = new Map<string, OpStat>();
  let conflicts = 0;
  let inFlight = 0;
  let peakInFlight = 0;

  /* Charged when the call is DISPATCHED, not when it succeeds: a read that
     raised still cost a round trip, and a pass that spent its time failing is
     the one whose cost is worth reading. Pages and bytes are only knowable
     afterwards, so they are added when the answer arrives. */
  const begin = (op: StoreOp, key: string): OpStat[] => {
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    const stats = [ops[op], kindStat(kinds, kindOf(key), op)];
    for (const stat of stats) {
      stat.count++;
      stat.pages++;
    }
    return stats;
  };

  const add = (stats: OpStat[], bytes: number, extraPages: number): void => {
    for (const stat of stats) {
      stat.bytes += bytes;
      stat.pages += extraPages;
    }
  };

  const end = (): void => {
    inFlight--;
  };

  const measure = async <T>(
    op: StoreOp,
    key: string,
    call: () => Promise<T>,
    weigh: (value: T) => { bytes: number; extraPages: number },
  ): Promise<T> => {
    const stats = begin(op, key);
    try {
      const value = await call();
      const weight = weigh(value);
      add(stats, weight.bytes, weight.extraPages);
      return value;
    } catch (error) {
      if (isScafoError(error) && error.code === "cas-conflict") conflicts++;
      throw error;
    } finally {
      end();
    }
  };

  const textBytes = (text: string): number => encoder.encode(text).length;

  return {
    get(key: string): Promise<StoredObject | null> {
      return measure(
        "get",
        key,
        () => inner.get(key),
        (found) => ({ bytes: found === null ? 0 : textBytes(found.body), extraPages: 0 }),
      );
    },

    getBytes(key: string, opts?: { range: ByteRange }): Promise<Uint8Array | null> {
      return measure(
        "getBytes",
        key,
        () => inner.getBytes(key, opts),
        (found) => ({ bytes: found?.byteLength ?? 0, extraPages: 0 }),
      );
    },

    /* A metadata read is one round trip, answered without a body. */
    head(key: string): Promise<StoredHead | null> {
      return measure(
        "get",
        key,
        () => inner.head(key),
        () => ({ bytes: 0, extraPages: 0 }),
      );
    },

    put(key: string, body: string | Uint8Array, cas?: CasHeaders): Promise<{ etag: string }> {
      const bytes = typeof body === "string" ? textBytes(body) : body.byteLength;
      return measure(
        "put",
        key,
        () => inner.put(key, body, cas),
        () => ({ bytes, extraPages: 0 }),
      );
    },

    del(key: string): Promise<void> {
      return measure(
        "del",
        key,
        () => inner.del(key),
        () => ({ bytes: 0, extraPages: 0 }),
      );
    },

    /* The in-memory store answers a whole listing at once; a bucket answers a
       thousand keys per request, and the pages that would have cost are what
       the measurement is about. */
    list(prefix: string): Promise<string[]> {
      return measure(
        "list",
        prefix,
        () => inner.list(prefix),
        (keys) => ({
          bytes: keys.reduce((total, key) => total + textBytes(key), 0),
          extraPages: extraPagesOf(keys.length),
        }),
      );
    },

    listEntries(prefix: string): Promise<StoredEntry[]> {
      return measure(
        "listEntries",
        prefix,
        () => inner.listEntries(prefix),
        (entries) => ({
          bytes: entries.reduce((total, entry) => total + textBytes(entry.key), 0),
          extraPages: extraPagesOf(entries.length),
        }),
      );
    },

    counts(): StoreOpCounts {
      return {
        get: ops.get.count + ops.getBytes.count,
        put: ops.put.count,
        del: ops.del.count,
        list: ops.list.count + ops.listEntries.count,
      };
    },

    reset(): void {
      ops = emptyOps();
      kinds = new Map();
      conflicts = 0;
      peakInFlight = inFlight;
    },

    snapshot(): MeterSnapshot {
      const listCalls = ops.list.count + ops.listEntries.count;
      const listPages = ops.list.pages + ops.listEntries.pages;
      return {
        ops: {
          get: { ...ops.get },
          getBytes: { ...ops.getBytes },
          put: { ...ops.put },
          del: { ...ops.del },
          list: { ...ops.list },
          listEntries: { ...ops.listEntries },
        },
        kinds: [...kinds].map(([id, stat]) => {
          const [kind, op] = id.split(" ") as [KeyKind, StoreOp];
          return { kind, op, stat: { ...stat } };
        }),
        gets: ops.get.count + ops.getBytes.count,
        puts: ops.put.count,
        dels: ops.del.count,
        listCalls,
        listPages,
        bytesRead: ops.get.bytes + ops.getBytes.bytes + ops.list.bytes + ops.listEntries.bytes,
        bytesWritten: ops.put.bytes,
        conflicts,
        peakInFlight,
        requests: ops.get.count + ops.getBytes.count + ops.put.count + ops.del.count + listPages,
      };
    },
  };
}

/** Requests a listing of `keys` keys costs BEYOND the one already charged. */
export function extraPagesOf(keys: number): number {
  return Math.max(1, Math.ceil(keys / LIST_PAGE_KEYS)) - 1;
}

/**
 * The kind of record `key` names.
 *
 * Read off the prefixes `src/core/registry/paths.ts` builds rather than off
 * strings written again here: a layout change has to reach this file, and a
 * classification that quietly stopped matching would read as an installation
 * that stopped touching a kind of record.
 */
export function kindOf(key: string): KeyKind {
  if (key === freezeKey()) return "freeze";
  if (key.startsWith(prefixes.coordinator)) return "coordinator";
  for (const [kind, prefix] of prefixed) {
    if (key.startsWith(prefix)) return kind;
  }
  return "other";
}

/** A name every per-application prefix helper accepts, so the kind prefix falls out of it. */
const SAMPLE = "a";

/** The prefix each kind of key lives under, from the helpers that build them. */
const prefixes = {
  applications: applicationsPrefix(),
  placement: placementPrefix(),
  nodes: nodesPrefix(),
  deploys: kindPrefix(deploysPrefix(SAMPLE), `${SAMPLE}/`),
  deployments: kindPrefix(deploymentsPrefix(SAMPLE), `${SAMPLE}/`),
  trust: kindPrefix(trustKey(SAMPLE), `${SAMPLE}.json`),
  domains: domainsPrefix(),
  coordinator: kindPrefix(coordinatorKey(), "lease.json"),
  operators: operatorsPrefix(),
  identities: identitiesPrefix(),
  observe: observePrefix(),
  tlsObjects: tlsObjectsPrefix(),
  tlsLocks: tlsLocksPrefix(),
  fleets: kindPrefix(fleetPrefix(SAMPLE), SAMPLE),
};

/* Longest first, so a prefix that contains another never claims its keys. */
const prefixed: Array<[KeyKind, string]> = (
  [
    ["applications", prefixes.applications],
    ["placement", prefixes.placement],
    ["nodes", prefixes.nodes],
    ["deploys", prefixes.deploys],
    ["deployments", prefixes.deployments],
    ["trust", prefixes.trust],
    ["domains", prefixes.domains],
    ["operators", prefixes.operators],
    ["identities", prefixes.identities],
    ["observe", prefixes.observe],
    ["tls", prefixes.tlsObjects],
    ["tls", prefixes.tlsLocks],
    ["fleets", prefixes.fleets],
  ] as Array<[KeyKind, string]>
).sort((a, b) => b[1].length - a[1].length);

/** The part of a built key that is the kind's own, with the sample's half removed. */
function kindPrefix(key: string, suffix: string): string {
  if (!key.endsWith(suffix)) throw new Error(`"${key}" does not end in "${suffix}"`);
  return key.slice(0, -suffix.length);
}

function kindStat(kinds: Map<string, OpStat>, kind: KeyKind, op: StoreOp): OpStat {
  const id = `${kind} ${op}`;
  let stat = kinds.get(id);
  if (stat === undefined) {
    stat = { count: 0, bytes: 0, pages: 0 };
    kinds.set(id, stat);
  }
  return stat;
}

function emptyOps(): Record<StoreOp, OpStat> {
  return {
    get: { count: 0, bytes: 0, pages: 0 },
    getBytes: { count: 0, bytes: 0, pages: 0 },
    put: { count: 0, bytes: 0, pages: 0 },
    del: { count: 0, bytes: 0, pages: 0 },
    list: { count: 0, bytes: 0, pages: 0 },
    listEntries: { count: 0, bytes: 0, pages: 0 },
  };
}
