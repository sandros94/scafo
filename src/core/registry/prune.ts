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
 * the shared asset blobs are out of scope entirely — they are content
 * addressed, so a blob the current deployment needs is the same object an old
 * deployment referenced, and nothing here can tell those two apart.
 */

import { ScafoError } from "../error.ts";
import type { DeploymentRecord } from "../types/registry.ts";
import { deleteKey, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { deploymentKey, deployPointerKey, deployPrefix, ID_RE } from "./paths.ts";

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
  const ordered = (await readDeployments(ctx, opts.project, prefix, keys)).sort(byNewestFirst);

  const plan: PrunePlan = { project: opts.project, env: opts.env, current, keep: [], delete: [] };
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
  return { deleted };
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
  project: string,
  prefix: string,
  keys: string[],
): Promise<StoredDeployment[]> {
  const found = new Map<string, StoredDeployment>();

  for (const key of keys) {
    const rest = key.slice(prefix.length).split("/");
    if (rest.length < 3) continue;

    const [script, version] = rest;
    if (script === "" || version === "") continue;

    const id = `${script}/${version}`;
    const deployment = found.get(id);
    if (deployment === undefined) {
      found.set(id, { script, version, prefix: `${prefix}${id}/`, keys: [key] });
    } else {
      deployment.keys.push(key);
    }
  }

  for (const deployment of found.values()) {
    /* Only an id the registry could have filed a deployment under is worth a
       read; Celld's version ids are content digests, but nothing here guarantees
       that every directory under `deploy/` was written by a version of it that
       agreed. */
    if (!ID_RE.test(deployment.version)) continue;

    const key = deploymentKey(project, deployment.version);
    const record = await readJson<DeploymentRecord>(ctx, key);
    if (record === null) continue;

    deployment.createdAt = record.value.createdAt;
    deployment.recordKey = key;
  }
  return [...found.values()];
}

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
