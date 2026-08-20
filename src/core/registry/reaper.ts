/* Garbage collection: what is safe to delete, and the lease-gated deletion itself. */

import { ScafoError } from "../error.ts";
import type {
  BuildRecord,
  DomainClaim,
  EnvironmentRecord,
  PlacementRecord,
} from "../types/registry.ts";
import { formatDuration } from "./_shared.ts";
import { deleteKey, readJson, requireJson } from "./cas.ts";
import { nowDate, type RegistryContext } from "./context.ts";
import { listBuilds } from "./builds.ts";
import { releaseDomain } from "./domains.ts";
import { listEnvironments } from "./environments.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { buildKey, domainKey, environmentKey, fleetPrefix, placementKey } from "./paths.ts";
import { listProjects } from "./projects.ts";
import {
  assertDeletable,
  DEFAULT_RETIREMENT_GRACE_MS,
  type RetirementOptions,
  retirementState,
} from "./retirement.ts";

/** Where last-request timestamps come from; the registry itself does not track them. */
export interface ActivitySource {
  lastActiveAt(project: string, env: string): Promise<Date | null>;
}

export interface ReapOptions extends RetirementOptions {
  activity?: ActivitySource;
  /** Without `maxAgeMs` no build is ever a candidate. */
  buildRetention?: { maxAgeMs?: number };
}

export interface ReapPlan {
  environments: Array<{ project: string; env: string; reason: string }>;
  builds: Array<{ project: string; id: string; reason: string }>;
}

export interface ReapResult {
  /** Store keys actually deleted. */
  deleted: string[];
  /** Targets left alone, keyed by their record's store key. */
  skipped: Array<{ target: string; reason: string }>;
}

/** What {@link deleteEnvironment} is allowed to act on; see {@link assertDeletable}. */
export interface DeleteEnvironmentOptions extends RetirementOptions {
  /**
   * Deletes the environment whatever state it is in, skipping BOTH the ephemeral
   * and the retirement-grace requirement. The escape hatch for an operator who
   * has already made the decision the two steps exist to slow down — a preview
   * fleet gone wrong, an environment created by a typo — and the one path that
   * discards a long-lived environment in a single call.
   */
  force?: boolean;
}

/**
 * Lists what is currently reapable. The plan is advisory: {@link executeReap}
 * re-checks every item against fresh state before deleting anything.
 *
 * An environment qualifies two ways. It is RETIRED and its grace has run out —
 * whether or not it is ephemeral, because retirement is an explicit order to
 * decommission and the grace is the whole of the wait it asked for. Or it is
 * ephemeral, has an `idleTtlS`, and has been idle for longer. A non-ephemeral
 * environment nobody retired is never a candidate. A build qualifies only when
 * no environment of its project references it — through an alias, the alias's
 * previous build, or any split leg — and it is older than the configured
 * retention.
 */
export async function planReap(ctx: RegistryContext, opts?: ReapOptions): Promise<ReapPlan> {
  const plan: ReapPlan = { environments: [], builds: [] };
  const now = nowDate(ctx).getTime();
  const maxAgeMs = opts?.buildRetention?.maxAgeMs;

  for (const project of await listProjects(ctx)) {
    const environments = await readEnvironments(ctx, project);

    for (const environment of environments) {
      const reason = await reapReason(ctx, project, environment, now, opts);
      if (reason !== null) plan.environments.push({ project, env: environment.name, reason });
    }

    if (maxAgeMs === undefined) continue;
    const referenced = referencedBuilds(environments);

    for (const id of await listBuilds(ctx, project)) {
      if (referenced.has(id)) continue;

      const build = await readJson<BuildRecord>(ctx, buildKey(project, id));
      if (build === null) continue;

      const age = now - Date.parse(build.value.createdAt);
      if (!Number.isFinite(age) || age < maxAgeMs) continue;
      plan.builds.push({
        project,
        id,
        reason: `unreferenced and ${String(Math.floor(age / 1000))}s old`,
      });
    }
  }

  return plan;
}

/**
 * Carries out a plan under the coordinator lease. The lease is re-verified
 * before every item and a lost lease aborts the whole run — deletes cannot be
 * conditional, so the lease is the only thing keeping two reapers apart.
 *
 * Each item is re-read and re-checked first; anything that changed since
 * planning is skipped. Deletions go references-before-referents so a crash
 * mid-run never leaves a pointer to something gone.
 *
 * Pass the same `opts` used for planning so the re-check sees the same activity
 * source; without it, idleness falls back to the record's own timestamps.
 */
export async function executeReap(
  ctx: RegistryContext,
  plan: ReapPlan,
  lease: LeaseHandle,
  opts?: ReapOptions,
): Promise<ReapResult> {
  const result: ReapResult = { deleted: [], skipped: [] };

  for (const target of plan.environments) {
    await assertLease(ctx, lease);

    const key = environmentKey(target.project, target.env);
    const found = await readJson<EnvironmentRecord>(ctx, key);
    if (found === null) {
      result.skipped.push({ target: key, reason: "environment no longer exists" });
      continue;
    }

    /* Re-checked against fresh state, retirement included: an environment
       unretired between the plan and this step is one an operator has taken back
       into service, and it must survive the run that was already going to
       delete it. */
    const now = nowDate(ctx).getTime();
    const reason = await reapReason(ctx, target.project, found.value, now, opts);
    if (reason === null) {
      result.skipped.push({
        target: key,
        reason: "environment is no longer idle, nor retired past its grace",
      });
      continue;
    }

    result.deleted.push(
      ...(await purgeEnvironment(ctx, target.project, found.value, () => assertLease(ctx, lease))),
    );
  }

  const maxAgeMs = opts?.buildRetention?.maxAgeMs;
  for (const target of plan.builds) {
    await assertLease(ctx, lease);

    const key = buildKey(target.project, target.id);
    const found = await readJson<BuildRecord>(ctx, key);
    if (found === null) {
      result.skipped.push({ target: key, reason: "build no longer exists" });
      continue;
    }

    const referenced = referencedBuilds(await readEnvironments(ctx, target.project));
    if (referenced.has(target.id)) {
      result.skipped.push({ target: key, reason: "build is referenced by an environment" });
      continue;
    }

    const age = nowDate(ctx).getTime() - Date.parse(found.value.createdAt);
    if (maxAgeMs !== undefined && age < maxAgeMs) {
      result.skipped.push({ target: key, reason: "build is within the retention window" });
      continue;
    }

    await deleteKey(ctx, key);
    result.deleted.push(key);
    await deleteKey(ctx, found.value.artifact);
    result.deleted.push(found.value.artifact);
  }

  /* TODO: varsets are shared by builds and environments, so reaping them needs
     reference counting across both. They are deliberately left untouched. */
  return result;
}

/**
 * Deletes one environment on an operator's explicit order, under the coordinator
 * lease. This is the reaper's machinery run against a named target instead of a
 * plan, so the deletion order and the fencing are the same; what it does NOT do
 * is ask whether the environment is idle. The order to delete is the decision,
 * and an environment nothing has called in months is precisely the one an
 * operator deletes by hand.
 *
 * Which environments it will act on is {@link assertDeletable}'s to decide:
 * ephemeral ones, ones retired for longer than the grace, and — bypassing both —
 * ones the caller has explicitly forced. Anything else is refused with
 * `ScafoError("invalid-input")` at status 409, and the refusal names the route
 * that applies rather than only the rule that was broken: a long-lived
 * environment is the one name that outlives every build it ever served, and
 * nothing here can tell a deliberate request from a typo in a path.
 *
 * The lease is verified before every destructive step, so a coordinator that has
 * been superseded mid-run stops rather than racing the node that replaced it —
 * the partial deletion it leaves is the same self-repairing state a crash leaves.
 *
 * Throws `ScafoError("not-found")` when there is no such environment, and
 * `ScafoError("lease-lost")` once the lease is gone.
 */
export async function deleteEnvironment(
  ctx: RegistryContext,
  project: string,
  env: string,
  lease: LeaseHandle,
  opts?: DeleteEnvironmentOptions,
): Promise<{ deleted: string[] }> {
  const found = await requireJson<EnvironmentRecord>(ctx, environmentKey(project, env));
  assertDeletable(ctx, project, found.value, opts);

  const deleted = await purgeEnvironment(ctx, project, found.value, () => assertLease(ctx, lease));
  return { deleted };
}

/**
 * Deletes one environment's records in the only safe order: the domain claims
 * that name it, then its fleet state, then its placement decision, then the
 * environment record itself. `guard` runs before every destructive step and
 * aborts the rest by throwing.
 *
 * A run cut short — by a crash or by a lost lease — therefore leaves the
 * environment record in place, so the next pass finds it again and the deletion
 * self-repairs. Deleting the record first would orphan its claims forever:
 * nothing iterates an environment that no longer exists.
 */
async function purgeEnvironment(
  ctx: RegistryContext,
  project: string,
  environment: EnvironmentRecord,
  guard: () => Promise<void>,
): Promise<string[]> {
  const deleted: string[] = [];

  for (const host of environment.domains) {
    const claimKey = domainKey(host);
    const claim = await readJson<DomainClaim>(ctx, claimKey);
    if (claim === null) continue;
    /* Only claims still naming this environment: one that has moved on belongs
       to whoever took it over, and releasing it would strand them. */
    if (claim.value.project !== project || claim.value.environment !== environment.name) continue;

    await guard();
    await releaseDomain(ctx, host);
    deleted.push(claimKey);
  }

  for (const fleetKey of await ctx.store.list(`${fleetPrefix(project, environment.name)}/`)) {
    await guard();
    await deleteKey(ctx, fleetKey);
    deleted.push(fleetKey);
  }

  /* Before the record, because it points AT the record: a placement left behind
     names an environment that is gone, and the only thing that would ever have
     cleaned it up is the coordinator noticing the same absence a tick later. */
  const placement = placementKey(project, environment.name);
  if ((await readJson<PlacementRecord>(ctx, placement)) !== null) {
    await guard();
    await deleteKey(ctx, placement);
    deleted.push(placement);
  }

  const key = environmentKey(project, environment.name);
  await guard();
  await deleteKey(ctx, key);
  deleted.push(key);
  return deleted;
}

async function readEnvironments(
  ctx: RegistryContext,
  project: string,
): Promise<EnvironmentRecord[]> {
  const environments: EnvironmentRecord[] = [];
  for (const name of await listEnvironments(ctx, project)) {
    const found = await readJson<EnvironmentRecord>(ctx, environmentKey(project, name));
    if (found !== null) environments.push(found.value);
  }
  return environments;
}

function referencedBuilds(environments: EnvironmentRecord[]): Set<string> {
  const referenced = new Set<string>();
  for (const environment of environments) {
    if (environment.alias !== null) {
      referenced.add(environment.alias.build);
      if (environment.alias.previous !== undefined) referenced.add(environment.alias.previous);
    }
    for (const entry of environment.split ?? []) referenced.add(entry.build);
  }
  return referenced;
}

/**
 * Why this environment may be reaped, or null when it may not. Retirement is
 * asked first because it is an explicit order and idleness is an inference: an
 * environment that is both retired and idle is being decommissioned, and the
 * reason recorded against its deletion should say so.
 */
async function reapReason(
  ctx: RegistryContext,
  project: string,
  environment: EnvironmentRecord,
  now: number,
  opts?: ReapOptions,
): Promise<string | null> {
  const retired = retirementState(environment, new Date(now), opts);
  if (retired?.expired === true) {
    return (
      `retired at ${retired.retiredAt}, ${formatDuration(retired.elapsedMs)} ago, ` +
      `past its ${formatDuration(opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS)} grace`
    );
  }
  /* Retired but still within the grace: an operator may yet take it back, so
     nothing reaps it — not even when it is also an idle ephemeral one, because
     retiring an environment must never make it disappear SOONER. */
  if (retired !== null) return null;

  return idleReason(ctx, project, environment, now, opts?.activity);
}

async function idleReason(
  ctx: RegistryContext,
  project: string,
  environment: EnvironmentRecord,
  now: number,
  activity?: ActivitySource,
): Promise<string | null> {
  const ttlS = environment.idleTtlS;
  if (!environment.ephemeral || ttlS === undefined) return null;

  const lastActive =
    activity === undefined ? null : await activity.lastActiveAt(project, environment.name);
  const since =
    lastActive === null
      ? Date.parse(environment.alias?.flippedAt ?? environment.createdAt)
      : lastActive.getTime();
  if (!Number.isFinite(since)) return null;

  const idleMs = now - since;
  if (idleMs < ttlS * 1000) return null;
  return `ephemeral and idle for ${String(Math.floor(idleMs / 1000))}s (idleTtlS ${String(ttlS)})`;
}

async function assertLease(ctx: RegistryContext, lease: LeaseHandle): Promise<void> {
  if (!(await verifyLease(ctx, lease))) {
    throw new ScafoError("lease-lost", "Coordinator lease is no longer held", {
      detail: `fence ${String(lease.lease.fence)} held by "${lease.lease.node}" was superseded`,
    });
  }
}
