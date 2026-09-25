/*
 * Reading, and on an operator's word deleting, ONE Celld node lease.
 *
 * UNSTABLE, and narrower than it looks. `fleets/<application>/nodes/<node>.json`
 * is Celld's own record: the object a process must read or create before it has
 * any authority at all, and the fence its peers judge it by. Nothing in scafo
 * writes one, nothing here repairs one, and nothing automatic may delete one.
 *
 * It exists because a store can corrupt exactly that object. A bucket answered a
 * LIST and a `HEAD` for a lease key and a `404` to every `GET` of it; the Celld
 * process could then neither read the lease nor create it, and since the node
 * name is the scafo node id — stable across restarts, deliberately, so an
 * acknowledged write survives one — every restart wedged on the same key, every
 * fifteen seconds, forever. No amount of restarting is a way out of that, and
 * the only thing that is, is deleting the object. This module is the operator's
 * hands on that one deletion, and it goes the moment Celld recovers such a lease
 * itself.
 *
 * SO IT ONLY EVER LOOKS AND DELETES. A verdict is the three reads laid side by
 * side — what the listing says, what a `HEAD` says, what a `GET` says — and a
 * deletion is refused outright while those reads say a live process owns it.
 */

import { safeJsonParse } from "unsecure/sanitize";
import { ScafoError } from "../error.ts";
import type { StoredEntry, StoredHead } from "../types/store.ts";
import type { CelldNodeLease } from "./_celld-contract.ts";
import { assertVerifiedCelldRelease } from "./_celld-gate.ts";
import type { RegistryContext } from "./context.ts";
import { celldNodeLeaseKey, celldNodesPrefix, parseCelldNodeLeaseKey } from "./paths.ts";

/** The command an operator types, as every refusal and warning of it says. */
export const LEASE_COMMAND: string = "scafo app lease";

/**
 * What the three reads together say about one lease key.
 *
 * `absent` is not a diagnosis, only the answer to a question about a key nothing
 * has ever written: an enumeration never produces one, and a named node does.
 */
export type CelldLeaseVerdict =
  /** Readable, a node lease, and its expiry has not passed: a process may hold it. */
  | "held"
  /** Readable and a node lease, and its expiry has passed. */
  | "expired"
  /** Listed or `HEAD`-able and unreadable all the same, or a body that is no node lease. */
  | "unreadable"
  /** Nothing under the key at all: no listing, no `HEAD`, no body. */
  | "absent";

/** What one of the three reads answered, or why it answered nothing. */
export interface LeaseRead {
  /** Whether this read found an object at all. */
  present: boolean;
  /** The ETag it carried, when it carried one. */
  etag?: string;
  /** The size it declared, in bytes. */
  size?: number;
  /** When it says the object was last written, ISO-8601. */
  lastModified?: string;
  /** What the store raised instead of answering. Evidence, never a failure to propagate. */
  error?: string;
}

/** One lease key as the bucket answers for it right now. */
export interface CelldLeaseReading {
  application: string;
  /** The Celld node the key is filed under. */
  node: string;
  /** The key itself, so an operator can go and look at it with their own tools. */
  key: string;
  /** What a listing of the fleet's `nodes/` prefix said about it. */
  listed: LeaseRead;
  /** What a `HEAD` of the key said. */
  head: LeaseRead;
  /** What a `GET` of the key said. */
  get: LeaseRead;
  verdict: CelldLeaseVerdict;
  /** The evidence the verdict rests on, in one sentence. */
  why: string;
  /** The lease's own expiry, ISO-8601, when the body carried one that reads as a time. */
  expiresAt?: string;
  /**
   * The node the BODY names, when that is not the node the key is filed under.
   * Celld's own reaper collects a lease only when the two agree, so a record that
   * disagrees is one nothing upstream will ever tidy away.
   */
  recordNode?: string;
}

export interface InspectLeasesOptions {
  application: string;
  /** One node, or every lease the fleet holds when it is left out. */
  node?: string;
  /** The moment an expiry is judged against. */
  now: Date;
}

/**
 * Every node lease of one application, or the one a node names, each with the
 * three reads it was judged on.
 *
 * Refuses with `ScafoError("capability-missing")` before anything is read when
 * the installation is not answering on a Celld release this build was verified
 * against — the same gate, for the same reason, as `scafo deployment prune`.
 */
export async function inspectCelldLeases(
  ctx: RegistryContext,
  opts: InspectLeasesOptions,
): Promise<CelldLeaseReading[]> {
  await assertVerifiedCelldRelease(ctx, { now: opts.now, command: LEASE_COMMAND });

  /* ONE listing for the whole prefix, whether or not a node was named: a
     diagnosis of one key still wants to say whether the listing names it, and
     that is the only read that can answer the question. */
  const listed = new Map<string, StoredEntry>();
  for (const entry of await ctx.store.listEntries(celldNodesPrefix(opts.application))) {
    const node = parseCelldNodeLeaseKey(opts.application, entry.key);
    /* Anything else under the prefix belongs to something this does not read. */
    if (node !== null) listed.set(node, entry);
  }

  const nodes =
    opts.node === undefined ? [...listed.keys()].sort() : [assertLeaseNode(opts, opts.node)];

  const readings: CelldLeaseReading[] = [];
  for (const node of nodes) {
    readings.push(await readLease(ctx, opts, node, listed.get(node)));
  }
  return readings;
}

export interface DropLeaseOptions {
  /** The moment the read-back judges an expiry against. */
  now: Date;
  /** Deletes a lease whose verdict is `held`; the refusal names it. */
  force?: boolean;
}

/** What a drop did, and what the bucket said afterwards. */
export interface CelldLeaseDrop {
  /** The reading the decision was made on. */
  before: CelldLeaseReading;
  /** Whether a delete was issued at all; nothing is deleted where nothing is. */
  deleted: boolean;
  /** The same key read again afterwards, which is the only proof the delete took. */
  after: CelldLeaseReading;
  /** Whether the store still names the key after the delete. */
  stillThere: boolean;
}

/**
 * Deletes ONE lease key and reads it back.
 *
 * Refuses with `ScafoError("reference-held")` when the reading says `held`: an
 * unexpired lease is one a running process believes is its own, and deleting it
 * lets a second process take the node's cells while the first still serves them.
 * `--force` is the operator saying they know the process is gone.
 *
 * The reading is passed in rather than taken again, so what is deleted is what
 * the operator was shown and consented to.
 */
export async function dropCelldLease(
  ctx: RegistryContext,
  before: CelldLeaseReading,
  opts: DropLeaseOptions,
): Promise<CelldLeaseDrop> {
  if (before.verdict === "held" && opts.force !== true) {
    throw new ScafoError("reference-held", "Node lease is held", {
      detail:
        `"${before.key}": ${before.why}, so a Celld process may be holding it; stop the ` +
        `process on node "${before.node}", or wait for the lease to run out, and drop it ` +
        `then — "--force" drops it anyway, which lets a second process take this node's ` +
        `cells while the first still serves them`,
    });
  }

  const deleted = before.verdict !== "absent";
  /* Exactly this key, and never a prefix: the deletion an operator consented to
     is one object, and the rest of the fleet's leases are other nodes' fences. */
  if (deleted) await ctx.store.del(before.key);

  /* READ BACK RATHER THAN REPORT SUCCESS. The store that answered a `HEAD` for
     an object it would not `GET` is not one to take a `204` from on trust, and
     an operator who deleted a wedged key needs to know whether it is really
     gone before they restart the node. */
  const after = await readLeaseAgain(ctx, before, opts.now);
  return { before, deleted, after, stillThere: after.verdict !== "absent" };
}

/** The reading a drop is planned on: one node's lease, judged as `show` judges it. */
export async function planLeaseDrop(
  ctx: RegistryContext,
  opts: InspectLeasesOptions & { node: string },
): Promise<CelldLeaseReading> {
  const [reading] = await inspectCelldLeases(ctx, opts);
  /* `inspectCelldLeases` answers one reading for a named node, whatever the
     bucket holds — an absent key is a reading too. */
  if (reading === undefined) {
    throw new ScafoError("internal", "Lease was not read", {
      detail: `nothing was read for "${celldNodeLeaseKey(opts.application, opts.node)}"`,
    });
  }
  return reading;
}

/* ---------------------------------------------------------------- internals */

/** The same key, read the same way, after a deletion. */
async function readLeaseAgain(
  ctx: RegistryContext,
  before: CelldLeaseReading,
  now: Date,
): Promise<CelldLeaseReading> {
  const entries = await ctx.store.listEntries(celldNodesPrefix(before.application));
  const entry = entries.find((one) => one.key === before.key);
  return readLease(ctx, { application: before.application, now }, before.node, entry);
}

/**
 * The three reads of one key, and the verdict they add up to.
 *
 * NONE OF THEM IS ALLOWED TO FAIL THE WHOLE READING. A store that raises on a
 * `HEAD` or a `GET` of the very object being diagnosed is describing the
 * problem, and a diagnosis that threw at the first sign of it would be a tool
 * that works everywhere except where it is needed.
 */
async function readLease(
  ctx: RegistryContext,
  opts: { application: string; now: Date },
  node: string,
  entry: StoredEntry | undefined,
): Promise<CelldLeaseReading> {
  const key = celldNodeLeaseKey(opts.application, node);

  const listed: LeaseRead =
    entry === undefined
      ? { present: false }
      : {
          present: true,
          etag: entry.etag,
          ...(entry.size === undefined ? {} : { size: entry.size }),
          ...isoOf(entry.lastModified),
        };

  let head: LeaseRead;
  try {
    head = headRead(await ctx.store.head(key));
  } catch (error) {
    head = { present: false, error: describe(error) };
  }

  let get: LeaseRead;
  let text: string | undefined;
  try {
    const object = await ctx.store.get(key);
    if (object === null) get = { present: false };
    else {
      get = { present: true, etag: object.etag, size: byteLength(object.body) };
      text = object.body;
    }
  } catch (error) {
    get = { present: false, error: describe(error) };
  }

  const evidence: LeaseEvidence = { application: opts.application, node, key, listed, head, get };
  return { ...evidence, ...judge(evidence, text, opts.now) };
}

/** A `HEAD` answer as a read of its own; a null is the store saying there is nothing. */
function headRead(found: StoredHead | null): LeaseRead {
  if (found === null) return { present: false };
  return {
    present: true,
    ...(found.etag === undefined ? {} : { etag: found.etag }),
    ...(found.size === undefined ? {} : { size: found.size }),
    ...isoOf(found.lastModified),
  };
}

/** A reading before it has been judged: the key, and the three reads of it. */
type LeaseEvidence = Omit<CelldLeaseReading, "verdict" | "why" | "expiresAt" | "recordNode">;

/** The verdict, the sentence behind it, and whatever the body itself said. */
function judge(
  evidence: LeaseEvidence,
  text: string | undefined,
  now: Date,
): Pick<CelldLeaseReading, "verdict" | "why" | "expiresAt" | "recordNode"> {
  const lease = text === undefined ? null : asNodeLease(text);

  if (lease !== null) {
    const expiresAt = new Date(lease.expires_ms).toISOString();
    const mismatch = lease.node === evidence.node ? {} : { recordNode: lease.node };
    const disagrees =
      lease.node === evidence.node
        ? ""
        : `, and it names node "${lease.node}" rather than the one it is filed under, which ` +
          `keeps Celld's own reaper from ever collecting it`;

    /* Upstream's rule, everywhere it reads one: a lease is live while its
       expiry is still ahead of wall time. */
    return lease.expires_ms > now.getTime()
      ? {
          verdict: "held",
          why: `it is a node lease that runs until ${expiresAt}${disagrees}`,
          expiresAt,
          ...mismatch,
        }
      : {
          verdict: "expired",
          why: `it is a node lease that ran out at ${expiresAt}${disagrees}`,
          expiresAt,
          ...mismatch,
        };
  }

  if (evidence.get.present) {
    return {
      verdict: "unreadable",
      why: `it was read whole and is not a node lease: it carries no "node" and no "expires_ms"`,
    };
  }

  const seen = [
    evidence.listed.present ? "the listing names it" : undefined,
    evidence.head.present ? "a HEAD of it answers" : undefined,
  ].filter((one): one is string => one !== undefined);

  if (seen.length > 0) {
    return {
      verdict: "unreadable",
      why:
        `${seen.join(" and ")}, and ${gotNothing(evidence.get)} — the store holds something ` +
        `here that it will not answer, which is the shape of the corruption this command exists for`,
    };
  }
  if (evidence.get.error !== undefined) {
    return { verdict: "unreadable", why: `${gotNothing(evidence.get)}, and nothing else sees it` };
  }
  return {
    verdict: "absent",
    why: "nothing is there: the listing, a HEAD and a GET all say so",
  };
}

/** How the `GET` failed to hand over a body, in the words of what it did. */
function gotNothing(get: LeaseRead): string {
  return get.error === undefined
    ? "a GET of it says it is not there"
    : `a GET of it fails (${get.error})`;
}

/**
 * The lease `text` holds, or null when it is not one.
 *
 * The SHAPE IS THE WHOLE TEST, and it is upstream's own: `node` and
 * `expires_ms` are the two fields Celld requires of this object and everything
 * else carries a default, so a body that has them is a lease Celld would read
 * and a body that does not is one it would refuse. See `_celld-contract.ts`.
 */
function asNodeLease(text: string): CelldNodeLease | null {
  let value: unknown;
  try {
    /* Bucket text, read without the keys an object answers for on its own. */
    value = safeJsonParse<unknown>(text);
  } catch {
    return null;
  }

  const record = value as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;

  const node = record.node;
  const expires = record.expires_ms;
  if (typeof node !== "string" || node === "") return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  return { node, expires_ms: expires };
}

/** The node a command named, refused here rather than at the key builder. */
function assertLeaseNode(opts: { application: string }, node: string): string {
  /* Built and thrown away: the builder is where the name rule lives, and a name
     it refuses must be refused before anything is read. */
  celldNodeLeaseKey(opts.application, node);
  return node;
}

function isoOf(at: Date | undefined): { lastModified?: string } {
  if (at === undefined || Number.isNaN(at.getTime())) return {};
  return { lastModified: at.toISOString() };
}

function byteLength(body: string): number {
  return new TextEncoder().encode(body).byteLength;
}

function describe(error: unknown): string {
  if (error instanceof ScafoError) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
