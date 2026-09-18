/*
 * Operator-driven cleanup of the deployments Celld has published for one
 * environment.
 *
 * UNSTABLE. Celld keeps every deployment it has ever written and deletes none
 * of them (denoland/celld#181); until it grows a lifecycle of its own, the only
 * thing that can free that space is an operator saying so. This module is that
 * operator's hands, and it follows upstream the moment upstream has an answer.
 *
 * Two things make it safe to delete inside a fleet scafo does not own. The
 * first is that CELLD'S OWN POINTERS decide what survives: a deployment any
 * pointer names is never a candidate, and a fleet whose fleet-wide pointer
 * cannot be read is refused outright rather than guessed at. The second is that
 * the shared asset blobs are collected BY REFERENCE: they are content
 * addressed, so a blob is deleted only once no deployment that stays names its
 * digest, and an asset index that cannot be read refuses the whole plan rather
 * than being read as a deployment that references nothing.
 */

import { ScafoError } from "../error.ts";
import type { DeploymentRecord } from "../types/registry.ts";
import type { StoredEntry } from "../types/store.ts";
import { deleteKey, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import {
  deployBlobsPrefix,
  deployImagesPrefix,
  deploymentKey,
  deployPointerKey,
  deployPrefix,
  deployQueuesPrefix,
} from "./paths.ts";

/** One deployment Celld published, as the bucket still holds it. */
export interface StoredDeployment {
  /** Celld script name: the first segment under the environment's `deploy/`. */
  script: string;
  /** Celld version id, which is also what scafo files its deployment record under. */
  version: string;
  /** Prefix its objects live under, including the trailing separator. */
  prefix: string;
  /** Every key beneath {@link StoredDeployment.prefix}, lexicographically sorted. */
  keys: string[];
  /** When scafo recorded this version, when it recorded it at all. */
  createdAt?: string;
  /** Key of that deployment record, when there is one to delete alongside the objects. */
  recordKey?: string;
}

/** Why a deployment survived the plan it was weighed in. */
export type PruneKeepReason =
  /** A Celld pointer names it; it is what the environment serves, or could serve. */
  | "current"
  /** Among the newest the plan was told to keep. */
  | "within-keep"
  /** Younger than the age the plan was told to delete past. */
  | "within-age";

export interface KeptDeployment extends StoredDeployment {
  reason: PruneKeepReason;
}

export interface PrunePlan {
  project: string;
  env: string;
  /** Versions a Celld pointer names, sorted; none of these is ever deleted. */
  current: string[];
  /** Everything that stays, newest first, each with why it stays. */
  keep: KeptDeployment[];
  /** Everything that goes, in the same newest-first order. */
  delete: StoredDeployment[];
  /** The shared asset blobs the same weighing selected: how many stay, and which keys go. */
  blobs: PrunedBlobs;
}

/** What becomes of the content-addressed asset blobs an environment shares. */
export interface PrunedBlobs {
  /** How many objects under `deploy-blobs/` the plan leaves where they are. */
  keep: number;
  /** Keys of the blobs no deployment that stays references, and old enough to go. */
  delete: string[];
}

export interface PlanPruneOptions {
  project: string;
  env: string;
  /** How many of the newest deployments survive regardless of their age. */
  keep: number;
  /**
   * How old a deployment past `keep` must be before it is selected. ALWAYS
   * WEIGHED: a deployment is selected only when it is both past `keep` and older
   * than this. Zero is the gate lifted — whatever its age.
   */
  olderThanMs: number;
  /** The moment ages are measured from. */
  now: Date;
}

export interface PruneResult {
  /** Store keys actually deleted, in the order they went. */
  deleted: string[];
}

/** What Celld's pointers hold; scafo reads these three fields and writes none. */
interface DeployPointer {
  version: string;
  prefix: string;
  script_name: string;
}

/**
 * Weighs one environment's deployments against its own pointers, the count to
 * keep, and the age window. BOTH GATES ARE WEIGHED: what goes is past the count
 * AND older than the window. Reads only; {@link executePrune} deletes.
 */
export async function planPrune(ctx: RegistryContext, opts: PlanPruneOptions): Promise<PrunePlan> {
  const prefix = deployPrefix(opts.project, opts.env);
  const keys = await ctx.store.list(prefix);

  const current = await readPointers(ctx, opts, prefix, keys);
  const ordered = (await readDeployments(ctx, opts, prefix, keys)).sort(byNewestFirst);

  const plan: PrunePlan = {
    project: opts.project,
    env: opts.env,
    current,
    keep: [],
    delete: [],
    blobs: { keep: 0, delete: [] },
  };
  const named = new Set(current);
  const nowMs = opts.now.getTime();

  for (const [index, deployment] of ordered.entries()) {
    if (named.has(deployment.version)) {
      plan.keep.push({ ...deployment, reason: "current" });
    } else if (index < opts.keep) {
      plan.keep.push({ ...deployment, reason: "within-keep" });
    } else if (!isOlderThan(deployment, nowMs, opts.olderThanMs)) {
      plan.keep.push({ ...deployment, reason: "within-age" });
    } else {
      plan.delete.push(deployment);
    }
  }

  /* After the deployments and not before: what a blob is measured against is
     the set that STAYS, which only the weighing above decides. */
  plan.blobs = await planBlobs(ctx, opts, plan.keep, nowMs);
  return plan;
}

/**
 * Deletes what a plan selected: each deployment's registry record, then its
 * objects.
 *
 * THE RECORD GOES FIRST, which is the same order the reaper deletes in — the
 * reference before the referent. A run interrupted between the two leaves
 * objects nothing points at, and the next plan reads a deployment with no
 * record as the oldest thing in the fleet, so it comes back as a
 * candidate. The other order would leave a record naming objects that are gone,
 * which only the coordinator's retention window ever tidies up.
 */
export async function executePrune(ctx: RegistryContext, plan: PrunePlan): Promise<PruneResult> {
  const deleted: string[] = [];

  for (const deployment of plan.delete) {
    /* The pointers are read again before EVERY deletion, not once for the run:
       a rollback can land while an earlier deployment is still being removed,
       and a plan is only as current as its last read. */
    await assertUnnamed(ctx, plan, deployment);
    if (deployment.recordKey !== undefined) {
      await deleteKey(ctx, deployment.recordKey);
      deleted.push(deployment.recordKey);
    }
    for (const key of deployment.keys) {
      await deleteKey(ctx, key);
      deleted.push(key);
    }
  }

  /* The blobs go LAST, and nothing is re-read for them. A blob is not a pointer
     target: no fleet selector can move onto one, and the only thing that could
     make a selected blob live again is a deploy that references it — which the
     age window, not a re-read, is what protects. Going last also means a run
     that dies halfway has deleted deployments that no longer reference them. */
  for (const key of plan.blobs.delete) {
    await deleteKey(ctx, key);
    deleted.push(key);
  }
  return { deleted };
}

/**
 * Which shared asset blobs no deployment that stays has a use for.
 *
 * Reference counted against the KEPT deployments only, since a deleted
 * deployment's references die with it, and gated by the same age window the
 * deployments were weighed against. A blob younger than the window survives
 * whatever references it: a deploy in flight writes its blobs BEFORE the
 * manifest and the pointer that make it visible, so during that window an
 * unreferenced blob and a blob about to be referenced look exactly alike. The
 * window is what tells them apart; lifting it (`olderThanMs: 0`) is an operator
 * saying no deploy is happening.
 */
async function planBlobs(
  ctx: RegistryContext,
  opts: Pick<PlanPruneOptions, "project" | "env" | "olderThanMs">,
  kept: KeptDeployment[],
  nowMs: number,
): Promise<PrunedBlobs> {
  const referenced = new Set<string>();
  for (const deployment of kept) {
    for (const digest of await readAssetDigests(ctx, deployment)) referenced.add(digest);
  }

  const prefix = deployBlobsPrefix(opts.project, opts.env);
  const entries = await ctx.store.listEntries(prefix);
  const doomed: string[] = [];

  for (const entry of entries) {
    const digest = blobDigest(entry.key, prefix);
    if (digest === undefined || referenced.has(digest)) continue;
    if (!isBlobOlderThan(entry, nowMs, opts.olderThanMs)) continue;
    doomed.push(entry.key);
  }
  return { keep: entries.length - doomed.length, delete: doomed };
}

/** Celld's own name for a deployment's asset index, and the only one it serves. */
const ASSET_INDEX_FILE = "assets.json";

/**
 * Every digest one deployment's asset index names, or none at all when the
 * deployment ships no assets.
 *
 * An index that cannot be read or parsed throws `ScafoError("store-nonconforming")`
 * naming its key. A deployment whose references cannot be read is not one to
 * delete blobs beside: reading it as referencing nothing would free exactly the
 * blobs it is holding.
 */
async function readAssetDigests(
  ctx: RegistryContext,
  deployment: StoredDeployment,
): Promise<string[]> {
  const key = `${deployment.prefix}${ASSET_INDEX_FILE}`;
  if (!deployment.keys.includes(key)) return [];

  const index = await readJson<unknown>(ctx, key);
  if (index === null) throw assetIndexProblem(key, "is not there any more");

  const record = index.value as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw assetIndexProblem(key, "is not an object");
  }

  /* Read through the one field the digests live in rather than through
     `schema_version`: an index this cannot read refuses here anyway, and
     pinning a number would refuse a Celld that only added a field. */
  const entries = record.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw assetIndexProblem(key, `has no "entries"`);
  }

  const digests: string[] = [];
  for (const [path, entry] of Object.entries(entries as Record<string, unknown>)) {
    const digest = (entry as { sha256?: unknown } | null)?.sha256;
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      throw assetIndexProblem(key, `names no usable digest for "${path}"`);
    }
    digests.push(digest);
  }
  return digests;
}

function assetIndexProblem(key: string, wrong: string): ScafoError {
  return new ScafoError("store-nonconforming", "Asset index is not an asset index", {
    detail:
      `"${key}" ${wrong}, so it cannot say which shared blobs the deployment needs; scafo ` +
      `will not delete a blob beside a deployment whose references it cannot read`,
  });
}

/** A full asset digest, exactly as Celld writes one: lowercase hexadecimal. */
const DIGEST_RE = /^[a-f\d]{64}$/;

/**
 * The digest a blob key names, or nothing when the key is not one Celld wrote.
 *
 * Celld's layout is `deploy-blobs/assets/sha256/<first two hex>/<digest>`.
 * ANYTHING ELSE UNDER THE PREFIX IS LEFT ALONE: a key this cannot read as a
 * digest is one nothing here can reference-count, and an object of unknown
 * shape is not one to delete on a guess.
 */
function blobDigest(key: string, prefix: string): string | undefined {
  const rest = key.slice(prefix.length).split("/");
  if (rest.length !== 4) return undefined;

  const [assets, algorithm, fanout, digest] = rest;
  if (assets !== "assets" || algorithm !== "sha256") return undefined;
  if (digest === undefined || !DIGEST_RE.test(digest) || fanout !== digest.slice(0, 2)) {
    return undefined;
  }
  return digest;
}

/**
 * Whether a blob is old enough to delete. A window of zero is the gate lifted,
 * as it is for a deployment; a blob whose age the store did not report reads as
 * too young to touch, which is the direction that cannot break what is running.
 */
function isBlobOlderThan(entry: StoredEntry, nowMs: number, olderThanMs: number): boolean {
  if (olderThanMs === 0) return true;

  const at = entry.lastModified?.getTime();
  if (at === undefined || !Number.isFinite(at)) return false;
  return nowMs - at > olderThanMs;
}

/**
 * Throws `ScafoError("cas-conflict")` when a pointer now names the deployment
 * a plan selected for deletion: the plan was made against a fleet that has
 * since chosen it, and deleting what is being served is not a stale decision to
 * carry out but one to make again.
 */
async function assertUnnamed(
  ctx: RegistryContext,
  plan: Pick<PrunePlan, "project" | "env">,
  deployment: StoredDeployment,
): Promise<void> {
  const prefix = deployPrefix(plan.project, plan.env);
  const named = await readPointers(ctx, plan, prefix, await ctx.store.list(prefix));
  if (!named.includes(deployment.version)) return;

  throw new ScafoError("cas-conflict", "Deployment is in use again", {
    detail:
      `a Celld pointer of "${plan.project}/${plan.env}" now names version ` +
      `"${deployment.version}", which the plan had selected for deletion; nothing of it ` +
      `was deleted — plan the prune again`,
  });
}

/**
 * Every version a Celld pointer names: the fleet-wide selector, and each
 * script's own.
 *
 * A pointer that is missing or unreadable is a refusal rather than an empty
 * answer. Reading no pointer would mean nothing is protected, and the first
 * thing an unprotected plan would delete is whatever the environment is
 * serving.
 */
async function readPointers(
  ctx: RegistryContext,
  opts: Pick<PlanPruneOptions, "project" | "env">,
  prefix: string,
  keys: string[],
): Promise<string[]> {
  const fleetKey = deployPointerKey(opts.project, opts.env);
  const fleet = await readJson<unknown>(ctx, fleetKey);
  if (fleet === null) {
    throw new ScafoError("store-nonconforming", "Fleet has no current deployment pointer", {
      detail:
        `"${fleetKey}" does not exist, so nothing says what "${opts.project}/${opts.env}" is ` +
        `serving: deploy the environment before pruning it, or check that the installation's ` +
        `key prefix is the one this fleet was published under`,
    });
  }

  const versions = new Set([asPointer(fleet.value, fleetKey).version]);
  for (const key of keys) {
    const rest = key.slice(prefix.length).split("/");
    if (rest.length !== 2 || rest[1] !== POINTER_FILE) continue;

    const pointer = await readJson<unknown>(ctx, key);
    if (pointer === null) continue;
    versions.add(asPointer(pointer.value, key).version);
  }
  return [...versions].sort();
}

/** Filename of both pointers Celld keeps: the fleet's, and each script's. */
const POINTER_FILE = "current.json";

/** The pointer `value` is, or `ScafoError("store-nonconforming")` naming the key. */
function asPointer(value: unknown, key: string): DeployPointer {
  const record = value as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw pointerProblem(key, "is not an object");
  }

  const version = record.version;
  const prefix = record.prefix;
  const script = record.script_name;
  if (typeof version !== "string" || version === "") throw pointerProblem(key, `has no "version"`);
  if (typeof prefix !== "string" || prefix === "") throw pointerProblem(key, `has no "prefix"`);
  if (typeof script !== "string" || script === "") {
    throw pointerProblem(key, `has no "script_name"`);
  }
  return { version, prefix, script_name: script };
}

function pointerProblem(key: string, wrong: string): ScafoError {
  return new ScafoError("store-nonconforming", "Deployment pointer is not a pointer", {
    detail:
      `"${key}" ${wrong}, so it cannot say which deployment is in use; scafo will not ` +
      `delete anything in a fleet whose selector it cannot read`,
  });
}

/**
 * Every deployment under `prefix`, paired with the record scafo filed for it.
 *
 * Grouped by the first two segments, which is Celld's own layout:
 * `deploy/<script>/<version>/...`. A key with fewer segments is a pointer
 * rather than a deployment, and is skipped here.
 */
async function readDeployments(
  ctx: RegistryContext,
  opts: Pick<PlanPruneOptions, "project" | "env">,
  prefix: string,
  keys: string[],
): Promise<StoredDeployment[]> {
  const found = new Map<string, StoredDeployment>();
  /* Celld's own keyspaces beneath `deploy/`, skipped by the prefix they live
     under rather than by the look of the names inside them: a queue called
     `abcdef0123456789` is still a queue. */
  const protocols = [
    deployImagesPrefix(opts.project, opts.env),
    deployQueuesPrefix(opts.project, opts.env),
  ];

  for (const key of keys) {
    if (protocols.some((one) => key.startsWith(one))) continue;

    const rest = key.slice(prefix.length).split("/");
    if (rest.length < 3) continue;

    const [script, version] = rest;
    if (script === undefined || version === undefined) continue;
    /* THE SHAPE IS THE GUARANTEE that these two segments name a publication at
       all: a name Celld would have accepted for the script, and a version id of
       the width its own `deployment_version` produces. Anything else under the
       prefix belongs to something this cannot read, and is neither weighed nor
       deleted. */
    if (!SCRIPT_NAME_RE.test(script) || !VERSION_RE.test(version)) continue;

    const id = `${script}/${version}`;
    const deployment = found.get(id);
    if (deployment === undefined) {
      found.set(id, { script, version, prefix: `${prefix}${id}/`, keys: [key] });
    } else {
      deployment.keys.push(key);
    }
  }

  for (const deployment of found.values()) {
    /* Every version that got this far is one scafo could have filed a record
       under, so the read needs no guard of its own. A version with no record is
       still a deployment Celld published — one scafo never filed — and stays a
       candidate, weighed as the oldest thing in the fleet. */
    const key = deploymentKey(opts.project, deployment.version);
    const record = await readJson<DeploymentRecord>(ctx, key);
    if (record === null) continue;

    deployment.createdAt = record.value.createdAt;
    deployment.recordKey = key;
  }
  return [...found.values()];
}

/**
 * A script name Celld accepts, and so the only kind of first segment a
 * publication has: one to 63 bytes of lowercase letters, digits and hyphens,
 * beginning and ending on a letter or a digit.
 */
const SCRIPT_NAME_RE = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

/**
 * A version id, as Celld's `deployment_version` writes one: a sha256 in
 * lowercase hexadecimal, truncated to its first sixteen characters in every
 * release scafo has run against. The width is allowed up to the whole digest
 * on purpose: were upstream to stop truncating, an exact match would make
 * prune read no deployment at all and free nothing, without a word — while
 * nothing else under `deploy/<script>/` is ever named in hexadecimal.
 */
const VERSION_RE = /^[a-f\d]{16,64}$/;

/** Newest first; a deployment scafo has no record of sorts last, as the oldest. */
function byNewestFirst(a: StoredDeployment, b: StoredDeployment): number {
  const at = recordedAt(a);
  const bt = recordedAt(b);
  if (at !== bt) return bt - at;
  if (a.script !== b.script) return a.script < b.script ? -1 : 1;
  return a.version < b.version ? -1 : 1;
}

/** When scafo recorded the deployment, or `-Infinity` when it has no usable record. */
function recordedAt(deployment: StoredDeployment): number {
  if (deployment.createdAt === undefined) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(deployment.createdAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * A deployment with no usable record is older than any window, being the oldest
 * there is; and a window of zero is no window at all, which is how an operator
 * says "whatever its age".
 */
function isOlderThan(deployment: StoredDeployment, nowMs: number, olderThanMs: number): boolean {
  if (olderThanMs === 0) return true;

  const at = recordedAt(deployment);
  return Number.isFinite(at) ? nowMs - at > olderThanMs : true;
}
