/*
 * Operator-driven cleanup of the deployments Celld has published for one
 * environment.
 *
 * UNSTABLE. Celld keeps every publication it has ever written and deletes none
 * of them (denoland/celld#181); until it grows a lifecycle of its own, the only
 * thing that can free that space is an operator saying so. This module is that
 * operator's hands, and it follows upstream the moment upstream has an answer.
 *
 * Two things make it safe to delete inside a fleet scafo does not own. The
 * first is that CELLD'S OWN POINTERS decide what survives: a publication any
 * pointer names is never a candidate, and a fleet whose fleet-wide pointer
 * cannot be read is refused outright rather than guessed at. The second is that
 * the shared asset blobs are out of scope entirely — they are content
 * addressed, so a blob the current publication needs is the same object an old
 * publication referenced, and nothing here can tell those two apart.
 */

import { ScafoError } from "../error.ts";
import type { BuildRecord } from "../types/registry.ts";
import { deleteKey, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { buildKey, deployPointerKey, deployPrefix, ID_RE } from "./paths.ts";

/** One deployment Celld published, as the bucket still holds it. */
export interface Publication {
  /** Celld script name: the first segment under the environment's `deploy/`. */
  script: string;
  /** Celld version id, which is also the id scafo files its build record under. */
  version: string;
  /** Prefix its objects live under, including the trailing separator. */
  prefix: string;
  /** Every key beneath {@link Publication.prefix}, lexicographically sorted. */
  keys: string[];
  /** When scafo recorded the build of this version, when it recorded one. */
  createdAt?: string;
  /** Key of that build record, when there is one to delete alongside the objects. */
  buildKey?: string;
}

/** Why a publication survived the plan it was weighed in. */
export type PruneKeepReason =
  /** A Celld pointer names it; it is what the environment serves, or could serve. */
  | "current"
  /** Among the newest the plan was told to keep. */
  | "within-keep"
  /** Younger than the age the plan was told to delete past. */
  | "within-age";

export interface KeptPublication extends Publication {
  reason: PruneKeepReason;
}

export interface PrunePlan {
  project: string;
  env: string;
  /** Versions a Celld pointer names, sorted; none of these is ever deleted. */
  current: string[];
  /** Everything that stays, newest first, each with why it stays. */
  keep: KeptPublication[];
  /** Everything that goes, in the same newest-first order. */
  delete: Publication[];
}

export interface PlanPruneOptions {
  project: string;
  env: string;
  /** How many of the newest publications survive regardless of their age. */
  keep: number;
  /** Without it age plays no part, and every candidate past `keep` is selected. */
  olderThanMs?: number;
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
 * Weighs one environment's publications against its own pointers, the count to
 * keep, and the optional age window. Reads only; {@link executePrune} deletes.
 */
export async function planPrune(ctx: RegistryContext, opts: PlanPruneOptions): Promise<PrunePlan> {
  const prefix = deployPrefix(opts.project, opts.env);
  const keys = await ctx.store.list(prefix);

  const current = await readPointers(ctx, opts, prefix, keys);
  const ordered = (await readPublications(ctx, opts.project, prefix, keys)).sort(byNewestFirst);

  const plan: PrunePlan = { project: opts.project, env: opts.env, current, keep: [], delete: [] };
  const named = new Set(current);
  const nowMs = opts.now.getTime();

  for (const [index, publication] of ordered.entries()) {
    if (named.has(publication.version)) {
      plan.keep.push({ ...publication, reason: "current" });
    } else if (index < opts.keep) {
      plan.keep.push({ ...publication, reason: "within-keep" });
    } else if (
      opts.olderThanMs !== undefined &&
      !isOlderThan(publication, nowMs, opts.olderThanMs)
    ) {
      plan.keep.push({ ...publication, reason: "within-age" });
    } else {
      plan.delete.push(publication);
    }
  }
  return plan;
}

/**
 * Deletes what a plan selected: each publication's build record, then its
 * objects.
 *
 * THE RECORD GOES FIRST, which is the same order the reaper deletes in — the
 * reference before the referent. A run interrupted between the two leaves
 * objects nothing points at, and the next plan reads a publication with no
 * build record as the oldest thing in the fleet, so it comes back as a
 * candidate. The other order would leave a record naming objects that are gone,
 * which only the coordinator's retention window ever tidies up.
 */
export async function executePrune(ctx: RegistryContext, plan: PrunePlan): Promise<PruneResult> {
  const deleted: string[] = [];

  for (const publication of plan.delete) {
    /* The pointers are read again before EVERY deletion, not once for the run:
       a rollback can land while an earlier publication is still being removed,
       and a plan is only as current as its last read. */
    await assertUnnamed(ctx, plan, publication);
    if (publication.buildKey !== undefined) {
      await deleteKey(ctx, publication.buildKey);
      deleted.push(publication.buildKey);
    }
    for (const key of publication.keys) {
      await deleteKey(ctx, key);
      deleted.push(key);
    }
  }
  return { deleted };
}

/**
 * Throws `ScafoError("cas-conflict")` when a pointer now names the publication
 * a plan selected for deletion: the plan was made against a fleet that has
 * since chosen it, and deleting what is being served is not a stale decision to
 * carry out but one to make again.
 */
async function assertUnnamed(
  ctx: RegistryContext,
  plan: Pick<PrunePlan, "project" | "env">,
  publication: Publication,
): Promise<void> {
  const prefix = deployPrefix(plan.project, plan.env);
  const named = await readPointers(ctx, plan, prefix, await ctx.store.list(prefix));
  if (!named.includes(publication.version)) return;

  throw new ScafoError("cas-conflict", "Publication is in use again", {
    detail:
      `a Celld pointer of "${plan.project}/${plan.env}" now names version ` +
      `"${publication.version}", which the plan had selected for deletion; nothing of it ` +
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
      `"${key}" ${wrong}, so it cannot say which publication is in use; scafo will not ` +
      `delete anything in a fleet whose selector it cannot read`,
  });
}

/**
 * Every publication under `prefix`, paired with the build record scafo filed
 * for it.
 *
 * Grouped by the first two segments, which is Celld's own layout:
 * `deploy/<script>/<version>/...`. A key with fewer segments is a pointer
 * rather than a publication, and is skipped here.
 */
async function readPublications(
  ctx: RegistryContext,
  project: string,
  prefix: string,
  keys: string[],
): Promise<Publication[]> {
  const found = new Map<string, Publication>();

  for (const key of keys) {
    const rest = key.slice(prefix.length).split("/");
    if (rest.length < 3) continue;

    const [script, version] = rest;
    if (script === "" || version === "") continue;

    const id = `${script}/${version}`;
    const publication = found.get(id);
    if (publication === undefined) {
      found.set(id, { script, version, prefix: `${prefix}${id}/`, keys: [key] });
    } else {
      publication.keys.push(key);
    }
  }

  for (const publication of found.values()) {
    /* Only an id the registry could have filed a build under is worth a read;
       Celld's version ids are content digests, but nothing here guarantees that
       every directory under `deploy/` was written by a version of it that
       agreed. */
    if (!ID_RE.test(publication.version)) continue;

    const key = buildKey(project, publication.version);
    const record = await readJson<BuildRecord>(ctx, key);
    if (record === null) continue;

    publication.createdAt = record.value.createdAt;
    publication.buildKey = key;
  }
  return [...found.values()];
}

/** Newest first; a publication scafo has no record of sorts last, as the oldest. */
function byNewestFirst(a: Publication, b: Publication): number {
  const at = recordedAt(a);
  const bt = recordedAt(b);
  if (at !== bt) return bt - at;
  if (a.script !== b.script) return a.script < b.script ? -1 : 1;
  return a.version < b.version ? -1 : 1;
}

/** When scafo recorded the build, or `-Infinity` when it has no usable record. */
function recordedAt(publication: Publication): number {
  if (publication.createdAt === undefined) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(publication.createdAt);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/** A publication with no usable record is older than any window, being the oldest there is. */
function isOlderThan(publication: Publication, nowMs: number, olderThanMs: number): boolean {
  const at = recordedAt(publication);
  return Number.isFinite(at) ? nowMs - at > olderThanMs : true;
}
