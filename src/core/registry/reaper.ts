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
import { buildKey, domainsPrefix, environmentKey, fleetPrefix, placementKey } from "./paths.ts";
import { listProjects } from "./projects.ts";
import {
  assertDeletable,
  DEFAULT_RETIREMENT_GRACE_MS,
  type RetirementOptions,
  retirementState,
} from "./retirement.ts";

export interface ReapOptions extends RetirementOptions {
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
 * An environment qualifies only when it is retired and its grace has run out,
 * whether or not it is ephemeral. A build qualifies only when it is older than
 * the configured retention. Build records are deployment history, not runtime
 * pointers.
 */
export async function planReap(ctx: RegistryContext, opts?: ReapOptions): Promise<ReapPlan> {
  const plan: ReapPlan = { environments: [], builds: [] };
  const now = nowDate(ctx).getTime();
  const maxAgeMs = opts?.buildRetention?.maxAgeMs;

  for (const project of await listProjects(ctx)) {
    const environments = await readEnvironments(ctx, project);

    for (const environment of environments) {
      const reason = reapReason(environment, now, opts);
      if (reason !== null) plan.environments.push({ project, env: environment.name, reason });
    }

    if (maxAgeMs === undefined) continue;
    for (const id of await listBuilds(ctx, project)) {
      const build = await readJson<BuildRecord>(ctx, buildKey(project, id));
      if (build === null) continue;

      const age = now - Date.parse(build.value.createdAt);
      if (!Number.isFinite(age) || age < maxAgeMs) continue;
      plan.builds.push({
        project,
        id,
        reason: `${String(Math.floor(age / 1000))}s old`,
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
    const reason = reapReason(found.value, now, opts);
    if (reason === null) {
      result.skipped.push({
        target: key,
        reason: "environment is no longer retired past its grace",
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

    const age = nowDate(ctx).getTime() - Date.parse(found.value.createdAt);
    if (maxAgeMs !== undefined && age < maxAgeMs) {
      result.skipped.push({ target: key, reason: "build is within the retention window" });
      continue;
    }

    await deleteKey(ctx, key);
    result.deleted.push(key);
  }

  /* TODO: varsets are shared by builds and environments, so reaping them needs
     reference counting across both. They are deliberately left untouched. */
  return result;
}

/**
 * Deletes one environment on an operator's explicit order, under the coordinator
 * lease. This is the reaper's machinery run against a named target instead of a
 * plan, so the deletion order and the fencing are the same. The order to delete
 * is the decision.
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

  /* Scan claims rather than trusting the environment's mirror. `releaseDomain`
     removes the mirror before the claim; if a crash lands between those writes,
     the next run must still find and finish the claim. */
  const claims = domainsPrefix();
  for (const claimKey of await ctx.store.list(claims)) {
    const claim = await readJson<DomainClaim>(ctx, claimKey);
    if (claim === null) continue;
    /* Only claims still naming this environment: one that has moved on belongs
       to whoever took it over, and releasing it would strand them. */
    if (claim.value.project !== project || claim.value.environment !== environment.name) continue;

    await guard();
    await releaseDomain(ctx, claimKey.slice(claims.length, -".json".length));
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

/** Why this environment may be reaped, or null when it may not. */
function reapReason(
  environment: EnvironmentRecord,
  now: number,
  opts?: ReapOptions,
): string | null {
  const retired = retirementState(environment, new Date(now), opts);
  if (retired?.expired === true) {
    return (
      `retired at ${retired.retiredAt}, ${formatDuration(retired.elapsedMs)} ago, ` +
      `past its ${formatDuration(opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS)} grace`
    );
  }
  return null;
}

async function assertLease(ctx: RegistryContext, lease: LeaseHandle): Promise<void> {
  if (!(await verifyLease(ctx, lease))) {
    throw new ScafoError("lease-lost", "Coordinator lease is no longer held", {
      detail: `fence ${String(lease.lease.fence)} held by "${lease.lease.node}" was superseded`,
    });
  }
}
