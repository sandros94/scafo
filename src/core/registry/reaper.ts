/* Garbage collection: what is safe to delete, and the lease-gated deletion itself. */

import { ScafoError } from "../error.ts";
import type {
  DeploymentRecord,
  DeployRecord,
  DomainClaim,
  EnvironmentRecord,
  PlacementRecord,
} from "../types/registry.ts";
import { formatDuration } from "./_shared.ts";
import { deleteKey, readJson, requireJson } from "./cas.ts";
import { nowDate, type RegistryContext } from "./context.ts";
import { listDeployments } from "./deployments.ts";
import {
  DEPLOY_RECORD_RETENTION_MS,
  isDeployTerminal,
  listDeployRecords,
  updateDeployRecord,
} from "./deploys.ts";
import { releaseDomain } from "./domains.ts";
import { listEnvironments } from "./environments.ts";
import { type KeepAlive, type LeaseHandle, verifyLease } from "./lease.ts";
import { isNodeAnswering, listNodeRecords, NODE_LIVENESS_WINDOW_MS } from "./nodes.ts";
import {
  deploymentKey,
  deployKey,
  domainsPrefix,
  environmentKey,
  fleetPrefix,
  placementKey,
} from "./paths.ts";
import { listProjects } from "./projects.ts";
import {
  assertDeletable,
  DEFAULT_RETIREMENT_GRACE_MS,
  type RetirementOptions,
  retirementState,
} from "./retirement.ts";

export interface ReapOptions extends RetirementOptions {
  /** Without `maxAgeMs` no deployment is ever a candidate. */
  deploymentRetention?: { maxAgeMs?: number };
  /** Called before each item, so a long reap keeps the lease it runs under. */
  keepAlive?: KeepAlive;
}

export interface ReapPlan {
  environments: Array<{ project: string; env: string; reason: string }>;
  /** Unreferenced deployment records, by the version each is filed under. */
  deployments: Array<{ project: string; version: string; reason: string }>;
  /**
   * Deploys still on their way whose accepting node stopped answering. Nobody
   * else will ever finish them: the state lived in that daemon, and a poll would
   * otherwise report a deploy as uploading forever.
   */
  staleDeploys: Array<{ project: string; id: string; reason: string }>;
  /** Finished deploys past {@link DEPLOY_RECORD_RETENTION_MS}. */
  deploys: Array<{ project: string; id: string; reason: string }>;
}

export interface ReapResult {
  /** Store keys actually deleted. */
  deleted: string[];
  /** Store keys of the deploys marked failed because their node went. */
  failed: string[];
  /** Targets left alone, keyed by their record's store key. */
  skipped: Array<{ target: string; reason: string }>;
}

/** What {@link deleteEnvironment} is allowed to act on; see {@link assertDeletable}. */
export interface DeleteEnvironmentOptions extends RetirementOptions {
  /** Bypasses the retirement-grace deletion requirement. */
  force?: boolean;
}

/** Plans reapable items. Execution rechecks fresh state before deletion. */
export async function planReap(ctx: RegistryContext, opts?: ReapOptions): Promise<ReapPlan> {
  const plan: ReapPlan = { environments: [], deployments: [], staleDeploys: [], deploys: [] };
  const now = nowDate(ctx).getTime();
  const maxAgeMs = opts?.deploymentRetention?.maxAgeMs;
  /* Read once, and only if a deploy has gone quiet long enough to be worth
     asking about: every one of them is then judged against the same fleet,
     whoever beat while the walk was going on. */
  let fleet: ReadonlySet<string> | null = null;
  const answering = async (): Promise<ReadonlySet<string>> =>
    (fleet ??= await answeringNodes(ctx, new Date(now)));

  for (const project of await listProjects(ctx)) {
    const environments = await readEnvironments(ctx, project);

    for (const environment of environments) {
      const reason = reapReason(environment, now, opts);
      if (reason !== null) plan.environments.push({ project, env: environment.name, reason });
    }

    for (const record of await listDeployRecords(ctx, project)) {
      if (isDeployTerminal(record.state)) {
        const age = now - Date.parse(record.updatedAt);
        if (!Number.isFinite(age) || age < DEPLOY_RECORD_RETENTION_MS) continue;
        plan.deploys.push({
          project,
          id: record.id,
          reason: `${String(Math.floor(age / 1000))}s old`,
        });
        continue;
      }
      if (!idleTooLong(record, now) || (await answering()).has(record.node)) continue;
      plan.staleDeploys.push({ project, id: record.id, reason: abandonedReason(record) });
    }

    if (maxAgeMs === undefined) continue;
    for (const version of await listDeployments(ctx, project)) {
      const deployment = await readJson<DeploymentRecord>(ctx, deploymentKey(project, version));
      if (deployment === null) continue;

      const age = now - Date.parse(deployment.value.createdAt);
      if (!Number.isFinite(age) || age < maxAgeMs) continue;
      plan.deployments.push({
        project,
        version,
        reason: `${String(Math.floor(age / 1000))}s old`,
      });
    }
  }

  return plan;
}

/** Executes a plan under a rechecked coordinator lease. Re-reads items and
    deletes references before referents for crash recovery. */
export async function executeReap(
  ctx: RegistryContext,
  plan: ReapPlan,
  initial: LeaseHandle,
  opts: ReapOptions,
): Promise<ReapResult> {
  const result: ReapResult = { deleted: [], failed: [], skipped: [] };
  /* The handle each deletion is verified against, refreshed as the reap goes on. */
  let lease = initial;
  const keepAlive = opts.keepAlive;

  for (const target of plan.environments) {
    if (keepAlive !== undefined) lease = await keepAlive();
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

  const maxAgeMs = opts.deploymentRetention?.maxAgeMs;
  for (const target of plan.deployments) {
    if (keepAlive !== undefined) lease = await keepAlive();
    await assertLease(ctx, lease);

    const key = deploymentKey(target.project, target.version);
    const found = await readJson<DeploymentRecord>(ctx, key);
    if (found === null) {
      result.skipped.push({ target: key, reason: "deployment no longer exists" });
      continue;
    }

    const age = nowDate(ctx).getTime() - Date.parse(found.value.createdAt);
    if (maxAgeMs !== undefined && age < maxAgeMs) {
      result.skipped.push({ target: key, reason: "deployment is within the retention window" });
      continue;
    }

    await deleteKey(ctx, key);
    result.deleted.push(key);
  }

  const answering =
    plan.staleDeploys.length === 0 ? new Set<string>() : await answeringNodes(ctx, nowDate(ctx));
  for (const target of plan.staleDeploys) {
    if (keepAlive !== undefined) lease = await keepAlive();
    await assertLease(ctx, lease);

    const key = deployKey(target.project, target.id);
    const found = await readJson<DeployRecord>(ctx, key);
    if (found === null) {
      result.skipped.push({ target: key, reason: "deploy no longer exists" });
      continue;
    }

    /* Re-checked against fresh state, the fleet included: a deploy that finished
       between the plan and this step is one that HAPPENED, and a node heard from
       again is one still carrying its deploy. */
    const record = found.value;
    if (isDeployTerminal(record.state)) {
      result.skipped.push({ target: key, reason: "deploy has already finished" });
      continue;
    }
    if (!idleTooLong(record, nowDate(ctx).getTime()) || answering.has(record.node)) {
      result.skipped.push({ target: key, reason: `node "${record.node}" is answering again` });
      continue;
    }

    /* `deploy-timeout` because that is what happened to it: the deploy went
       quiet for longer than a node may, and it is given up on rather than
       refused — nothing about the caller, its input or the fleet's capabilities
       was ever wrong. */
    await updateDeployRecord(ctx, target.project, target.id, {
      state: "failed",
      code: "deploy-timeout",
      detail: abandonedReason(record),
    });
    result.failed.push(key);
  }

  for (const target of plan.deploys) {
    if (keepAlive !== undefined) lease = await keepAlive();
    await assertLease(ctx, lease);

    const key = deployKey(target.project, target.id);
    const found = await readJson<DeployRecord>(ctx, key);
    if (found === null) {
      result.skipped.push({ target: key, reason: "deploy no longer exists" });
      continue;
    }

    const record = found.value;
    const age = nowDate(ctx).getTime() - Date.parse(record.updatedAt);
    if (!isDeployTerminal(record.state) || age < DEPLOY_RECORD_RETENTION_MS) {
      result.skipped.push({ target: key, reason: "deploy is within the retention window" });
      continue;
    }

    await deleteKey(ctx, key);
    result.deleted.push(key);
  }

  return result;
}

/** Deletes an explicit environment under coordinator fencing and
    {@link assertDeletable}; lease loss stops remaining destructive steps. */
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

/** Deletes claims, fleet state, placement, then the environment. `guard` runs
    before each step so interruption leaves an iterable recovery state. */
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

  /* Deploy records are filed per PROJECT, so only the ones naming this
     environment go; the project's other environments keep theirs. */
  for (const record of await listDeployRecords(ctx, project)) {
    if (record.environment !== environment.name) continue;

    const key = deployKey(project, record.id);
    await guard();
    await deleteKey(ctx, key);
    deleted.push(key);
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

/**
 * Ids of the nodes this installation has heard from inside
 * {@link NODE_LIVENESS_WINDOW_MS}. A node with no record at all is not in it:
 * nothing says when it was last seen, and a deploy it took is one nobody is
 * carrying out.
 */
async function answeringNodes(ctx: RegistryContext, now: Date): Promise<ReadonlySet<string>> {
  const answering = new Set<string>();
  for (const record of await listNodeRecords(ctx)) {
    if (isNodeAnswering(record, now)) answering.add(record.id);
  }
  return answering;
}

/**
 * Whether a deploy still on its way has not moved for a whole liveness window.
 *
 * THE FIRST HALF of abandonment, and the cheap one. A deploy that wrote a moment
 * ago is being carried out whatever the fleet says about its node's heartbeat,
 * so nothing asks about the fleet until this is true.
 */
function idleTooLong(record: DeployRecord, now: number): boolean {
  const idleMs = now - Date.parse(record.updatedAt);
  return Number.isFinite(idleMs) && idleMs >= NODE_LIVENESS_WINDOW_MS;
}

/** What an abandoned deploy is told it died of, and what the plan says about it. */
function abandonedReason(record: DeployRecord): string {
  return `node "${record.node}" stopped answering while this deploy was ${record.state}`;
}

async function assertLease(ctx: RegistryContext, lease: LeaseHandle): Promise<void> {
  if (!(await verifyLease(ctx, lease))) {
    throw new ScafoError("lease-lost", "Coordinator lease is no longer held", {
      detail: `fence ${String(lease.lease.fence)} held by "${lease.lease.node}" was superseded`,
    });
  }
}
