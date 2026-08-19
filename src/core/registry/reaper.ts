/* Garbage collection: what is safe to delete, and the lease-gated deletion itself. */

import { ScaloError } from "../error.ts";
import type { BuildRecord, DomainClaim, EnvironmentRecord } from "../types/registry.ts";
import { deleteKey, readJson, requireJson } from "./cas.ts";
import { nowDate, type RegistryContext } from "./context.ts";
import { listBuilds } from "./builds.ts";
import { releaseDomain } from "./domains.ts";
import { listEnvironments } from "./environments.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { buildKey, domainKey, environmentKey, fleetPrefix } from "./paths.ts";
import { listProjects } from "./projects.ts";

/** Where last-request timestamps come from; the registry itself does not track them. */
export interface ActivitySource {
  lastActiveAt(project: string, env: string): Promise<Date | null>;
}

export interface ReapOptions {
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

/**
 * Lists what is currently reapable. The plan is advisory: {@link executeReap}
 * re-checks every item against fresh state before deleting anything.
 *
 * An environment qualifies only when it is ephemeral, has an `idleTtlS`, and has
 * been idle for longer. Non-ephemeral environments are never candidates. A build
 * qualifies only when no environment of its project references it — through an
 * alias, the alias's previous build, or any split leg — and it is older than the
 * configured retention.
 */
export async function planReap(ctx: RegistryContext, opts?: ReapOptions): Promise<ReapPlan> {
  const plan: ReapPlan = { environments: [], builds: [] };
  const now = nowDate(ctx).getTime();
  const maxAgeMs = opts?.buildRetention?.maxAgeMs;

  for (const project of await listProjects(ctx)) {
    const environments = await readEnvironments(ctx, project);

    for (const environment of environments) {
      const reason = await idleReason(ctx, project, environment, now, opts?.activity);
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

    const now = nowDate(ctx).getTime();
    const reason = await idleReason(ctx, target.project, found.value, now, opts?.activity);
    if (reason === null) {
      result.skipped.push({ target: key, reason: "environment is no longer idle" });
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
 * Refuses a non-ephemeral environment with `ScaloError("invalid-input")` at
 * status 409: a long-lived environment is the one name that outlives every build
 * it ever served, and nothing here can tell a deliberate request from a typo in
 * a path. Marking it ephemeral first is a separate, auditable act.
 *
 * The lease is verified before every destructive step, so a coordinator that has
 * been superseded mid-run stops rather than racing the node that replaced it —
 * the partial deletion it leaves is the same self-repairing state a crash leaves.
 *
 * Throws `ScaloError("not-found")` when there is no such environment, and
 * `ScaloError("lease-lost")` once the lease is gone.
 */
export async function deleteEnvironment(
  ctx: RegistryContext,
  project: string,
  env: string,
  lease: LeaseHandle,
): Promise<{ deleted: string[] }> {
  const found = await requireJson<EnvironmentRecord>(ctx, environmentKey(project, env));

  if (!found.value.ephemeral) {
    throw new ScaloError("invalid-input", "Environment is not ephemeral", {
      status: 409,
      detail:
        `"${project}/${env}" is not ephemeral, and deleting an environment through this call ` +
        `requires it to be: a non-ephemeral environment is deleted only after it has been ` +
        `marked ephemeral, so the decision to discard it is made once and on its own`,
    });
  }

  const deleted = await purgeEnvironment(ctx, project, found.value, () => assertLease(ctx, lease));
  return { deleted };
}

/**
 * Deletes one environment's records in the only safe order: the domain claims
 * that name it, then its fleet state, then the environment record itself.
 * `guard` runs before every destructive step and aborts the rest by throwing.
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
    throw new ScaloError("lease-lost", "Coordinator lease is no longer held", {
      detail: `fence ${String(lease.lease.fence)} held by "${lease.lease.node}" was superseded`,
    });
  }
}
