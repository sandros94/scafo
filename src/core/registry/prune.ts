/*
 * Operator-driven cleanup of the deployments Celld has published for one
 * application.
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
 * than being read as a deployment that references nothing. The saved container
 * images are collected the same way, against the image references a kept
 * deployment's manifest names.
 *
 * Both of those read formats Celld owns and changes between releases, so the
 * whole module is PINNED: it plans nothing — a dry run included — unless the
 * installation answers on a release `_celld-contract.ts` names and every
 * manifest it lists carries markers that module knows.
 */

import { ScafoError } from "../error.ts";
import type { DeploymentRecord } from "../types/registry.ts";
import type { StoredEntry } from "../types/store.ts";
import {
  ASSET_INDEX_SCHEMA_VERSION,
  DEPLOYMENT_FEATURES,
  LEGACY_MANIFEST_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSIONS,
  verifiedReleaseList,
} from "./_celld-contract.ts";
import { assertVerifiedCelldRelease } from "./_celld-gate.ts";
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

/** The command an operator types, as every refusal and warning of it says. */
export const PRUNE_COMMAND: string = "scafo deployment prune";

/** One deployment Celld published, as the bucket still holds it. */
export interface StoredDeployment {
  /** Celld script name: the first segment under the application's `deploy/`. */
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
  /**
   * Its `manifest.json`, read ONCE by the format gate and kept for the life of
   * the plan; absent for a version directory with none, which is a deploy in
   * flight.
   */
  manifest?: Record<string, unknown>;
}

/** Why a deployment survived the plan it was weighed in. */
export type PruneKeepReason =
  /** A Celld pointer names it; it is what the application serves, or could serve. */
  | "current"
  /** Among the newest the plan was told to keep. */
  | "within-keep"
  /** Younger than the age the plan was told to delete past. */
  | "within-age";

export interface KeptDeployment extends StoredDeployment {
  reason: PruneKeepReason;
}

export interface PrunePlan {
  application: string;
  /** Versions a Celld pointer names, sorted; none of these is ever deleted. */
  current: string[];
  /** Everything that stays, newest first, each with why it stays. */
  keep: KeptDeployment[];
  /** Everything that goes, in the same newest-first order. */
  delete: StoredDeployment[];
  /** The shared asset blobs the same weighing selected: how many stay, and which keys go. */
  blobs: PrunedBlobs;
  /** The shared container images the same weighing selected, read the same way. */
  images: PrunedImages;
}

/** What becomes of the content-addressed asset blobs an application shares. */
export interface PrunedBlobs {
  /** How many objects under `deploy-blobs/` the plan leaves where they are. */
  keep: number;
  /** Keys of the blobs no deployment that stays references, and old enough to go. */
  delete: string[];
}

/** What becomes of the content-addressed container images an application shares. */
export interface PrunedImages {
  /** How many objects under `deploy/images/` the plan leaves where they are. */
  keep: number;
  /** Keys of the images no deployment that stays references, and old enough to go. */
  delete: string[];
}

export interface PlanPruneOptions {
  application: string;
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

/**
 * What Celld's pointers hold; scafo reads these three fields and writes none.
 * `script_name` is upstream's own `Option`: the fleet-wide pointer carries it
 * and a named pointer written by an older Celld may not.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L450-L460 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L450-L460 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L450-L460 (v0.6.0)
 */
interface DeployPointer {
  version: string;
  prefix: string;
  script_name?: string;
}

/**
 * Weighs one application's deployments against its own pointers, the count to
 * keep, and the age window. BOTH GATES ARE WEIGHED: what goes is past the count
 * AND older than the window. Reads only; {@link executePrune} deletes.
 *
 * Refuses with `ScafoError("capability-missing")` before it reads the
 * application at all when the installation is not answering on a Celld release
 * this build was verified against, and again when any deployment it lists
 * carries a format marker `_celld-contract.ts` does not name.
 */
export async function planPrune(ctx: RegistryContext, opts: PlanPruneOptions): Promise<PrunePlan> {
  await assertVerifiedCelldRelease(ctx, { now: opts.now, command: PRUNE_COMMAND });

  const prefix = deployPrefix(opts.application);
  const keys = await ctx.store.list(prefix);

  const current = await readPointers(ctx, opts, prefix, keys);
  const ordered = (await readDeployments(ctx, opts, prefix, keys)).sort(byNewestFirst);

  const plan: PrunePlan = {
    application: opts.application,
    current,
    keep: [],
    delete: [],
    blobs: { keep: 0, delete: [] },
    images: { keep: 0, delete: [] },
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

  /* After the deployments and not before: what a blob or an image is measured
     against is the set that STAYS, which only the weighing above decides. */
  plan.blobs = await planBlobs(ctx, opts, plan.keep, nowMs);
  plan.images = await planImages(ctx, opts, plan.keep, nowMs);
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

  /* And the images after the blobs, for the same reason and in the same way:
     nothing re-read, and last of everything, so a run that stops halfway has
     already deleted every deployment that was still naming one. */
  for (const key of plan.images.delete) {
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
  opts: Pick<PlanPruneOptions, "application" | "olderThanMs">,
  kept: KeptDeployment[],
  nowMs: number,
): Promise<PrunedBlobs> {
  const referenced = new Set<string>();
  for (const deployment of kept) {
    for (const digest of await readAssetDigests(ctx, deployment)) referenced.add(digest);
  }

  const prefix = deployBlobsPrefix(opts.application);
  const entries = await ctx.store.listEntries(prefix);
  const doomed: string[] = [];

  for (const entry of entries) {
    const digest = blobDigest(entry.key, prefix);
    if (digest === undefined || referenced.has(digest)) continue;
    if (!isEntryOlderThan(entry, nowMs, opts.olderThanMs)) continue;
    doomed.push(entry.key);
  }
  return { keep: entries.length - doomed.length, delete: doomed };
}

/**
 * Which saved container images no deployment that stays has a use for.
 *
 * The blobs' rule, applied to the other thing deployments share: reference
 * counted against the KEPT deployments, gated by the same age window, and for
 * the same reason — a deploy saves its images before the manifest that names
 * them exists, so during that window an image nobody wants and an image about
 * to be wanted look exactly alike.
 */
async function planImages(
  ctx: RegistryContext,
  opts: Pick<PlanPruneOptions, "application" | "olderThanMs">,
  kept: KeptDeployment[],
  nowMs: number,
): Promise<PrunedImages> {
  const referenced = new Set<string>();
  for (const deployment of kept) {
    for (const key of imageKeysOf(deployment)) referenced.add(key);
  }

  const prefix = deployImagesPrefix(opts.application);
  const entries = await ctx.store.listEntries(prefix);
  const doomed: string[] = [];

  for (const entry of entries) {
    const key = imageContentKey(entry.key, prefix);
    if (key === undefined || referenced.has(key)) continue;
    if (!isEntryOlderThan(entry, nowMs, opts.olderThanMs)) continue;
    doomed.push(entry.key);
  }
  return { keep: entries.length - doomed.length, delete: doomed };
}

/**
 * Celld's own name for a deployment's asset index, and the only one it serves.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L811-L818 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L878-L885 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L878-L885 (v0.6.0)
 */
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

  const schema = record.schema_version;
  if (schema !== ASSET_INDEX_SCHEMA_VERSION) {
    throw contractProblem(
      `"${key}" is asset index schema version ${JSON.stringify(schema)}, and this build reads ` +
        String(ASSET_INDEX_SCHEMA_VERSION),
    );
  }

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

/**
 * The content key of every image one deployment runs: one per container class,
 * and the fence image that rides with any deployment that has a class at all.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L40-L50 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L40-L50 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L40-L50 (v0.6.0)
 *
 * Read out of the manifest the format gate already read and verified, never out
 * of the bucket again, and only for a deployment that stays: a reference that
 * is not one Celld writes throws `ScafoError("store-nonconforming")` naming the
 * manifest's key, for the reason the asset index does — a deployment whose
 * references cannot be read is not one to delete images beside. A deployment
 * with no container, or with no manifest yet, names none.
 */
function imageKeysOf(deployment: StoredDeployment): string[] {
  const manifest = deployment.manifest;
  if (manifest === undefined) return [];

  const key = `${deployment.prefix}${MANIFEST_FILE}`;
  const keys: string[] = [];
  const fence = manifest.fence_image;
  if (fence !== undefined && fence !== null) {
    const content = imageReferenceKey(fence);
    if (content === undefined) throw manifestProblem(key, `names no usable "fence_image"`);
    keys.push(content);
  }

  const containers = manifest.containers;
  if (containers === undefined || containers === null) return keys;
  if (!Array.isArray(containers)) throw manifestProblem(key, `has a "containers" that is no list`);

  for (const [index, container] of containers.entries()) {
    const content = imageReferenceKey((container as { image?: unknown } | null)?.image);
    if (content === undefined) {
      throw manifestProblem(key, `names no usable image for container ${String(index)}`);
    }
    keys.push(content);
  }
  return keys;
}

function manifestProblem(key: string, wrong: string): ScafoError {
  return new ScafoError("store-nonconforming", "Deployment manifest is not a manifest", {
    detail:
      `"${key}" ${wrong}, so it cannot say which saved container images the deployment needs; ` +
      `scafo will not delete an image beside a deployment whose references it cannot read`,
  });
}

/**
 * The prefix of every image reference Celld writes into a manifest; the rest of
 * the reference is the content key its tar is filed under.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/container.rs#L60-L73 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/container.rs#L60-L73 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/container.rs#L60-L73 (v0.6.0)
 */
const IMAGE_REFERENCE_PREFIX = "celld-image:";

/**
 * The content key an image reference names, or nothing when the reference is
 * not one Celld writes: its prefix, then a sha256 in lowercase hexadecimal.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L742 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L809 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L809 (v0.6.0)
 * REFUSED RATHER THAN READ LOOSELY: a reference this cannot map onto a tar
 * would count as naming nothing, and free exactly the image it runs.
 */
function imageReferenceKey(reference: unknown): string | undefined {
  if (typeof reference !== "string" || !reference.startsWith(IMAGE_REFERENCE_PREFIX)) {
    return undefined;
  }
  const content = reference.slice(IMAGE_REFERENCE_PREFIX.length);
  return DIGEST_RE.test(content) ? content : undefined;
}

/**
 * The content key an image key names, or nothing when the key is not one Celld
 * wrote.
 *
 * Celld's layout is `deploy/images/<content key>.tar`, flat.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/container.rs#L67-L73 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/container.rs#L67-L73 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/container.rs#L67-L73 (v0.6.0)
 * ANYTHING ELSE UNDER THE PREFIX IS LEFT ALONE, as it is under the blobs': an
 * object this cannot read as a content key is one nothing here can
 * reference-count.
 */
function imageContentKey(key: string, prefix: string): string | undefined {
  const rest = key.slice(prefix.length).split("/");
  if (rest.length !== 1) return undefined;

  const name = rest[0];
  if (name === undefined || !name.endsWith(IMAGE_SUFFIX)) return undefined;

  const content = name.slice(0, -IMAGE_SUFFIX.length);
  return DIGEST_RE.test(content) ? content : undefined;
}

/** What Celld saves an image as; the rest of the name is its content key. */
const IMAGE_SUFFIX = ".tar";

/**
 * A full asset digest or image content key, exactly as Celld writes one:
 * lowercase hexadecimal, the `sha256` of every entry of an asset index, and the
 * hash an image reference is tagged with.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L390-L397 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L390-L397 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L390-L397 (v0.6.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L433-L448 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L433-L448 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L433-L448 (v0.6.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L742 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L809 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L809 (v0.6.0)
 */
const DIGEST_RE = /^[a-f\d]{64}$/;

/**
 * The digest a blob key names, or nothing when the key is not one Celld wrote.
 *
 * Celld's layout is `deploy-blobs/assets/sha256/<first two hex>/<digest>`.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L433-L448 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L433-L448 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L433-L448 (v0.6.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L998-L1008 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L1065-L1075 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L1065-L1075 (v0.6.0)
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
 * Whether a shared object — a blob or a saved image — is old enough to delete.
 * A window of zero is the gate lifted, as it is for a deployment; an object
 * whose age the store did not report reads as too young to touch, which is the
 * direction that cannot break what is running.
 */
function isEntryOlderThan(entry: StoredEntry, nowMs: number, olderThanMs: number): boolean {
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
  plan: Pick<PrunePlan, "application">,
  deployment: StoredDeployment,
): Promise<void> {
  const prefix = deployPrefix(plan.application);
  const named = await readPointers(ctx, plan, prefix, await ctx.store.list(prefix));
  if (!named.includes(deployment.version)) return;

  throw new ScafoError("cas-conflict", "Deployment is in use again", {
    detail:
      `a Celld pointer of "${plan.application}" now names version ` +
      `"${deployment.version}", which the plan had selected for deletion; nothing of it ` +
      `was deleted — plan the prune again`,
  });
}

/**
 * Celld's own name for a deployment's manifest: the last file a deploy writes
 * into a version, and the first thing that says what format wrote it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L819-L824 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L886-L891 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L886-L891 (v0.6.0)
 */
const MANIFEST_FILE = "manifest.json";

/**
 * One deployment's manifest, once it is verified to carry only markers this
 * build knows: a schema version, and the features the deployment requires.
 * Refuses otherwise.
 *
 * READ FOR EVERY DEPLOYMENT THE PLAN LISTS, kept and deleted alike, and ONCE:
 * what it returns is kept with the deployment, and the image references are
 * read out of that. What a kept deployment references is what decides which
 * shared blobs and images survive, so a manifest this cannot read is a plan
 * this cannot make — not a deployment to quietly weigh as referencing nothing.
 *
 * A VERSION DIRECTORY WITH NO MANIFEST IS A DEPLOY IN FLIGHT, not an unknown
 * format: upstream writes the images, the blobs, the modules and `assets.json`
 * before the manifest, and the pointers after it, so a directory can exist without one
 * only while a deploy is happening or after one died. It carries no marker to
 * check, and the age window — the same thing that protects a young blob — is
 * what keeps it. See the write order in `_celld-contract.ts`.
 */
async function readVerifiedManifest(
  ctx: RegistryContext,
  deployment: StoredDeployment,
): Promise<Record<string, unknown> | undefined> {
  const key = `${deployment.prefix}${MANIFEST_FILE}`;
  if (!deployment.keys.includes(key)) return undefined;

  let manifest: unknown;
  try {
    const found = await readJson<unknown>(ctx, key);
    if (found === null) throw new Error("it is not there any more");
    manifest = found.value;
  } catch (error) {
    throw contractProblem(`"${key}" cannot be read as a manifest`, { cause: error });
  }

  const record = manifest as Record<string, unknown> | null;
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw contractProblem(`"${key}" is not an object`);
  }

  const schema = record.schema_version ?? LEGACY_MANIFEST_SCHEMA_VERSION;
  if (typeof schema !== "number" || !MANIFEST_SCHEMA_VERSIONS.includes(schema)) {
    throw contractProblem(
      `"${key}" is manifest schema version ${JSON.stringify(schema)}, and this build reads ` +
        MANIFEST_SCHEMA_VERSIONS.join(", "),
    );
  }

  const required = record.required_features ?? [];
  if (!Array.isArray(required))
    throw contractProblem(`"${key}" has a "required_features" that is not a list`);
  for (const feature of required) {
    if (typeof feature === "string" && DEPLOYMENT_FEATURES.includes(feature)) continue;
    throw contractProblem(
      `"${key}" requires the deployment feature ${JSON.stringify(feature)}, and this build ` +
        `knows ${DEPLOYMENT_FEATURES.join(", ")}`,
    );
  }
  return record;
}

/** The structural refusal: a bucket marker outside what this build was verified on. */
function contractProblem(found: string, opts?: { cause?: unknown }): ScafoError {
  return new ScafoError("capability-missing", "Celld bucket format is not one prune reads", {
    detail:
      `${found}; scafo deployment prune reads Celld's own bucket formats and this build was ` +
      `verified against celld ${verifiedReleaseList()}, so nothing was planned or deleted — a ` +
      `newer scafo, verified against the release that wrote this, is what lifts it`,
    ...(opts?.cause === undefined ? {} : { cause: opts.cause }),
  });
}

/**
 * Every version a Celld pointer names: the fleet-wide selector, and each
 * script's own.
 *
 * A pointer that is missing or unreadable is a refusal rather than an empty
 * answer. Reading no pointer would mean nothing is protected, and the first
 * thing an unprotected plan would delete is whatever the application is
 * serving.
 */
async function readPointers(
  ctx: RegistryContext,
  opts: Pick<PlanPruneOptions, "application">,
  prefix: string,
  keys: string[],
): Promise<string[]> {
  const fleetKey = deployPointerKey(opts.application);
  const fleet = await readJson<unknown>(ctx, fleetKey);
  if (fleet === null) {
    throw new ScafoError("store-nonconforming", "Fleet has no current deployment pointer", {
      detail:
        `"${fleetKey}" does not exist, so nothing says what "${opts.application}" is ` +
        `serving: deploy the application before pruning it, or check that the installation's ` +
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

/**
 * Filename of both pointers Celld keeps: the fleet's, and each script's.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L842-L848 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L909-L915 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L909-L915 (v0.6.0)
 */
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
  /* `script_name` is optional upstream and nothing here reads it, so a named
     pointer an older Celld wrote without one is still a pointer. */
  return {
    version,
    prefix,
    ...(typeof script === "string" && script !== "" ? { script_name: script } : {}),
  };
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
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L575 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L642 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L642 (v0.6.0)
 */
async function readDeployments(
  ctx: RegistryContext,
  opts: Pick<PlanPruneOptions, "application">,
  prefix: string,
  keys: string[],
): Promise<StoredDeployment[]> {
  const found = new Map<string, StoredDeployment>();
  /* Celld's own keyspaces beneath `deploy/`, skipped by the prefix they live
     under rather than by the look of the names inside them: a queue called
     `abcdef0123456789` is still a queue.
       https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/container.rs#L67-L73 (v0.5.0)
       https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/container.rs#L67-L73 (v0.5.1)
       https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/container.rs#L67-L73 (v0.6.0)
       https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L138-L141 (v0.5.0)
       https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L138-L141 (v0.5.1)
       https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L138-L141 (v0.6.0) */
  const protocols = [deployImagesPrefix(opts.application), deployQueuesPrefix(opts.application)];

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
    const manifest = await readVerifiedManifest(ctx, deployment);
    if (manifest !== undefined) deployment.manifest = manifest;
    /* Every version that got this far is one scafo could have filed a record
       under, so the read needs no guard of its own. A version with no record is
       still a deployment Celld published — one scafo never filed — and stays a
       candidate, weighed as the oldest thing in the fleet. */
    const key = deploymentKey(opts.application, deployment.version);
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
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L2055-L2068 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L2253-L2266 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L2253-L2266 (v0.6.0)
 */
const SCRIPT_NAME_RE = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

/**
 * A version id, as Celld's `deployment_version` writes one: a sha256 in
 * lowercase hexadecimal, truncated to its first sixteen characters in every
 * release scafo has run against. The width is allowed up to the whole digest
 * on purpose: were upstream to stop truncating, an exact match would make
 * prune read no deployment at all and free nothing, without a word — while
 * nothing else under `deploy/<script>/` is ever named in hexadecimal.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L467-L500 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/protocol.rs#L467-L500 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/protocol.rs#L467-L500 (v0.6.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L570-L575 (v0.5.0)
 *   https://github.com/denoland/celld/blob/42269c121c989c65c0638ab01f368baf18a5f0df/crates/celld/deploy.rs#L637-L642 (v0.5.1)
 *   https://github.com/denoland/celld/blob/bad4649d01f0db84cdc9093527e72e64ca7a14bf/crates/celld/deploy.rs#L637-L642 (v0.6.0)
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
