/* Garbage collection: what is safe to delete, and the lease-gated deletion itself. */

import { ScafoError } from "../error.ts";
import {
  type ConcurrencyGate,
  createConcurrencyGate,
  DEFAULT_CONCURRENCY,
  mapConcurrent,
} from "../utils/concurrency.ts";
import type {
  ApplicationRecord,
  DeploymentRecord,
  DeployRecord,
  DomainClaim,
  NodeRecord,
  PlacementRecord,
} from "../types/registry.ts";
import { formatDuration } from "./_shared.ts";
import { listApplicationRecords } from "./applications.ts";
import { deleteKey, readJson, requireJson } from "./cas.ts";
import { nowDate, type RegistryContext } from "./context.ts";
import {
  abandonedDeploy,
  DEPLOY_RECORD_RETENTION_MS,
  isDeployIdle,
  isDeployTerminal,
  updateDeployRecord,
} from "./deploys.ts";
import { releaseDomain } from "./domains.ts";
import { type KeepAlive, type LeaseHandle, verifyLease } from "./lease.ts";
import { isNodeAnswering, listNodeRecords } from "./nodes.ts";
import {
  applicationKey,
  deploymentsRootPrefix,
  deploysRootPrefix,
  parseDeployKey,
  parseDeploymentKey,
  deploymentKey,
  deploymentsPrefix,
  deploysPrefix,
  deployKey,
  domainsPrefix,
  fleetPrefix,
  placementKey,
  trustKey,
} from "./paths.ts";
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
  /**
   * The applications as the caller has already read them — a coordinator hands
   * over its view's snapshot — so a sweep costs one listing and nothing else.
   * Absent, they are read here.
   */
  applications?: readonly ApplicationRecord[];
  /** The fleet as the caller has already read it; absent, it is read here. */
  nodes?: readonly NodeRecord[];
  /**
   * Records this reaper has already read, kept across passes. A TERMINAL deploy
   * never changes, so it is read once and then judged from what is held; see
   * {@link createReapCache}.
   */
  cache?: ReapCache;
  /** Record reads in flight at once. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number;
}

/**
 * Deploy records a reaper has read, filed under the ETag it read them at.
 *
 * KEPT FOR THE LIFE OF THE COORDINATOR, because of what a deploy record is: once
 * it reaches `deployed` or `failed` it never moves again, and the only question
 * left about it is how old it is — which the record itself answers. A sweep over
 * an installation with a week of history therefore lists the records and reads
 * none of them at all.
 *
 * Entries the listing no longer carries are dropped, so the cache is never
 * larger than the history it describes.
 */
export interface ReapCache {
  /** Deploy records, by store key: the ETag they were read at, and the record. */
  records: Map<string, { etag: string; value: DeployRecord }>;
  /** Deployment records, the same way; immutable once written, so read once. */
  deployments: Map<string, { etag: string; value: DeploymentRecord }>;
}

/** A cache one coordinator keeps for as long as it holds the lease. */
export function createReapCache(): ReapCache {
  return { records: new Map(), deployments: new Map() };
}

export interface ReapPlan {
  applications: Array<{ application: string; reason: string }>;
  /** Unreferenced deployment records, by the version each is filed under. */
  deployments: Array<{ application: string; version: string; reason: string }>;
  /**
   * Deploys still on their way whose accepting node stopped answering. Nobody
   * else will ever finish them: the state lived in that daemon, and a poll would
   * otherwise report a deploy as uploading forever.
   */
  staleDeploys: Array<{ application: string; id: string; reason: string }>;
  /** Finished deploys past {@link DEPLOY_RECORD_RETENTION_MS}. */
  deploys: Array<{ application: string; id: string; reason: string }>;
}

export interface ReapResult {
  /** Store keys actually deleted. */
  deleted: string[];
  /** Store keys of the deploys marked failed because their node went. */
  failed: string[];
  /** Targets left alone, keyed by their record's store key. */
  skipped: Array<{ target: string; reason: string }>;
}

/** What {@link deleteApplication} is allowed to act on; see {@link assertDeletable}. */
export interface DeleteApplicationOptions extends RetirementOptions {
  /** Bypasses the retirement-grace deletion requirement. */
  force?: boolean;
}

/**
 * Plans reapable items. Execution rechecks fresh state before deletion.
 *
 * ONE LISTING OF THE WHOLE DEPLOY HISTORY, not one per application, and a read
 * only of the records whose ETag has moved since this reaper last saw them. A
 * sweep of an installation where nothing has expired therefore costs its listing
 * pages and no reads at all from the second pass onward — which is what makes it
 * safe to run over a history of tens of thousands of records.
 */
export async function planReap(ctx: RegistryContext, opts?: ReapOptions): Promise<ReapPlan> {
  const plan: ReapPlan = { applications: [], deployments: [], staleDeploys: [], deploys: [] };
  const now = nowDate(ctx).getTime();
  const maxAgeMs = opts?.deploymentRetention?.maxAgeMs;
  const gate = createConcurrencyGate(opts?.concurrency ?? DEFAULT_CONCURRENCY);
  /* Read once, and only if a deploy has gone quiet long enough to be worth
     asking about: every one of them is then judged against the same fleet,
     whoever beat while the walk was going on. */
  let fleet: ReadonlySet<string> | null = null;
  const answering = async (): Promise<ReadonlySet<string>> =>
    (fleet ??= answeringOf(opts?.nodes ?? (await listNodeRecords(ctx)), new Date(now)));

  const applications =
    opts?.applications ?? (await listApplicationRecords(ctx, { concurrency: gate }));
  for (const record of applications) {
    const reason = reapReason(record, now, opts);
    if (reason !== null) plan.applications.push({ application: record.name, reason });
  }

  for (const deploy of await readDeployHistory(ctx, gate, opts?.cache)) {
    const application = deploy.application;
    if (isDeployTerminal(deploy.state)) {
      const age = now - Date.parse(deploy.updatedAt);
      if (!Number.isFinite(age) || age < DEPLOY_RECORD_RETENTION_MS) continue;
      plan.deploys.push({
        application,
        id: deploy.id,
        reason: `${String(Math.floor(age / 1000))}s old`,
      });
      continue;
    }
    if (!isDeployIdle(deploy, new Date(now)) || (await answering()).has(deploy.node)) continue;
    plan.staleDeploys.push({ application, id: deploy.id, reason: abandonedReason(deploy) });
  }

  if (maxAgeMs === undefined) return plan;
  /* Only applications this installation still has: a deployment record filed
     under a name nothing answers for is one `purgeApplication` takes. */
  const named = new Set(applications.map((record) => record.name));
  for (const [key, version, deployment] of await readDeploymentHistory(ctx, gate, opts?.cache)) {
    const parsed = parseDeploymentKey(key);
    if (parsed === null || !named.has(parsed.application)) continue;

    const age = now - Date.parse(deployment.createdAt);
    if (!Number.isFinite(age) || age < maxAgeMs) continue;
    plan.deployments.push({
      application: parsed.application,
      version,
      reason: `${String(Math.floor(age / 1000))}s old`,
    });
  }

  return plan;
}

/**
 * Every deployment record of the installation, read the way the deploy history
 * is: one listing, and a read only where the ETag moved.
 *
 * A deployment record is IMMUTABLE once written — it names the version Celld
 * assigned and the moment it was created, and nothing ever rewrites it — so a
 * sweep past the first reads none of them at all.
 */
async function readDeploymentHistory(
  ctx: RegistryContext,
  gate: ConcurrencyGate,
  cache: ReapCache | undefined,
): Promise<Array<[string, string, DeploymentRecord]>> {
  const entries = await ctx.store.listEntries(deploymentsRootPrefix());
  const held = cache?.deployments;
  const wanted = entries.filter((entry) => parseDeploymentKey(entry.key) !== null);

  if (held !== undefined) {
    const listed = new Set(wanted.map((entry) => entry.key));
    for (const key of held.keys()) {
      if (!listed.has(key)) held.delete(key);
    }
  }

  const read = await mapConcurrent(wanted, gate, async (entry) => {
    const cached = held?.get(entry.key);
    if (cached?.etag === entry.etag) return cached.value;

    const found = await readJson<DeploymentRecord>(ctx, entry.key);
    if (found === null) return null;
    held?.set(entry.key, { etag: entry.etag, value: found.value });
    return found.value;
  });

  const history: Array<[string, string, DeploymentRecord]> = [];
  for (const [index, entry] of wanted.entries()) {
    const record = read[index];
    if (record === null || record === undefined) continue;
    history.push([
      entry.key,
      (parseDeploymentKey(entry.key) as { version: string }).version,
      record,
    ]);
  }
  return history;
}

/**
 * Every deploy record of the installation, in key order, read through `gate` and
 * only where the listing's ETag differs from the cached one.
 *
 * A key that is no deploy record of ours — nested, misnamed, or filed under an
 * application it does not claim — is skipped rather than read: see
 * {@link parseDeployKey}.
 */
async function readDeployHistory(
  ctx: RegistryContext,
  gate: ConcurrencyGate,
  cache: ReapCache | undefined,
): Promise<DeployRecord[]> {
  const entries = await ctx.store.listEntries(deploysRootPrefix());
  const wanted: Array<{ key: string; etag: string }> = [];
  const held = cache?.records;

  for (const entry of entries) {
    if (parseDeployKey(entry.key) === null) continue;
    wanted.push({ key: entry.key, etag: entry.etag });
  }

  /* Dropped BEFORE the reads, so a cache never outgrows the history it
     describes: a record the sweep deleted last time is gone from the listing. */
  if (held !== undefined) {
    const listed = new Set(wanted.map((entry) => entry.key));
    for (const key of held.keys()) {
      if (!listed.has(key)) held.delete(key);
    }
  }

  /* The gate bounds these from the outside and each task holds its slot for the
     one read it makes; a task that awaited the same gate from inside would
     deadlock as soon as every slot was taken. */
  const read = await mapConcurrent(wanted, gate, async (entry) => {
    const cached = held?.get(entry.key);
    if (cached?.etag === entry.etag) return cached.value;

    const found = await readJson<DeployRecord>(ctx, entry.key);
    if (found === null) return null;
    held?.set(entry.key, { etag: entry.etag, value: found.value });
    return found.value;
  });
  return read.filter((record): record is DeployRecord => record !== null);
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

  for (const target of plan.applications) {
    if (keepAlive !== undefined) lease = await keepAlive();
    await assertLease(ctx, lease);

    const key = applicationKey(target.application);
    const found = await readJson<ApplicationRecord>(ctx, key);
    if (found === null) {
      result.skipped.push({ target: key, reason: "application no longer exists" });
      continue;
    }

    /* Re-checked against fresh state, retirement included: an application
       unretired between the plan and this step is one an operator has taken back
       into service, and it must survive the run that was already going to
       delete it. */
    const now = nowDate(ctx).getTime();
    const reason = reapReason(found.value, now, opts);
    if (reason === null) {
      result.skipped.push({
        target: key,
        reason: "application is no longer retired past its grace",
      });
      continue;
    }

    result.deleted.push(
      ...(await purgeApplication(ctx, found.value, () => assertLease(ctx, lease))),
    );
  }

  const maxAgeMs = opts.deploymentRetention?.maxAgeMs;
  for (const target of plan.deployments) {
    if (keepAlive !== undefined) lease = await keepAlive();
    await assertLease(ctx, lease);

    const key = deploymentKey(target.application, target.version);
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

    const key = deployKey(target.application, target.id);
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
    if (!isDeployIdle(record, nowDate(ctx)) || answering.has(record.node)) {
      result.skipped.push({ target: key, reason: `node "${record.node}" is answering again` });
      continue;
    }

    /* The very judgement a poll answers with, so the record a sweep writes and
       the answer a caller already had say the same thing. */
    const failure = abandonedDeploy(record, { now: nowDate(ctx), node: null });
    if (failure === null) {
      result.skipped.push({ target: key, reason: "deploy is no longer abandoned" });
      continue;
    }
    await updateDeployRecord(ctx, target.application, target.id, failure);
    result.failed.push(key);
  }

  for (const target of plan.deploys) {
    if (keepAlive !== undefined) lease = await keepAlive();
    await assertLease(ctx, lease);

    const key = deployKey(target.application, target.id);
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

/** Deletes an explicit application under coordinator fencing and
    {@link assertDeletable}; lease loss stops remaining destructive steps. */
export async function deleteApplication(
  ctx: RegistryContext,
  name: string,
  lease: LeaseHandle,
  opts?: DeleteApplicationOptions,
): Promise<{ deleted: string[] }> {
  const found = await requireJson<ApplicationRecord>(ctx, applicationKey(name));
  assertDeletable(ctx, found.value, opts);

  const deleted = await purgeApplication(ctx, found.value, () => assertLease(ctx, lease));
  return { deleted };
}

/**
 * Deletes everything of an application: its domain claims, its Celld fleet
 * state, its deploy and deployment records, its trust policy, its placement,
 * then the record itself. `guard` runs before each step so interruption leaves
 * an iterable recovery state.
 */
async function purgeApplication(
  ctx: RegistryContext,
  application: ApplicationRecord,
  guard: () => Promise<void>,
): Promise<string[]> {
  const deleted: string[] = [];
  const name = application.name;

  /* Scan claims rather than trusting the application's mirror. `releaseDomain`
     removes the mirror before the claim; if a crash lands between those writes,
     the next run must still find and finish the claim. */
  const claims = domainsPrefix();
  for (const claimKey of await ctx.store.list(claims)) {
    const claim = await readJson<DomainClaim>(ctx, claimKey);
    if (claim === null) continue;
    /* Only claims still naming this application: one that has moved on belongs
       to whoever took it over, and releasing it would strand them. */
    if (claim.value.application !== name) continue;

    await guard();
    await releaseDomain(ctx, claimKey.slice(claims.length, -".json".length));
    deleted.push(claimKey);
  }

  for (const fleetKey of await ctx.store.list(`${fleetPrefix(name)}/`)) {
    await guard();
    await deleteKey(ctx, fleetKey);
    deleted.push(fleetKey);
  }

  for (const prefix of [deploysPrefix(name), deploymentsPrefix(name)]) {
    for (const key of await ctx.store.list(prefix)) {
      await guard();
      await deleteKey(ctx, key);
      deleted.push(key);
    }
  }

  /* The trust policy goes with the application it names; it may outlive nothing,
     or a pre-granted name would keep authorizing deploys into an application
     that was deleted. */
  const trust = trustKey(name);
  if ((await readJson<unknown>(ctx, trust)) !== null) {
    await guard();
    await deleteKey(ctx, trust);
    deleted.push(trust);
  }

  /* Before the record, because it points AT the record: a placement left behind
     names an application that is gone, and the only thing that would ever have
     cleaned it up is the coordinator noticing the same absence a tick later. */
  const placement = placementKey(name);
  if ((await readJson<PlacementRecord>(ctx, placement)) !== null) {
    await guard();
    await deleteKey(ctx, placement);
    deleted.push(placement);
  }

  const key = applicationKey(name);
  await guard();
  await deleteKey(ctx, key);
  deleted.push(key);
  return deleted;
}

/** Why this application may be reaped, or null when it may not. */
function reapReason(
  application: ApplicationRecord,
  now: number,
  opts?: ReapOptions,
): string | null {
  const retired = retirementState(application, new Date(now), opts);
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
 * the node liveness window. A node with no record at all is not in it:
 * nothing says when it was last seen, and a deploy it took is one nobody is
 * carrying out.
 */
async function answeringNodes(ctx: RegistryContext, now: Date): Promise<ReadonlySet<string>> {
  return answeringOf(await listNodeRecords(ctx), now);
}

/** The same answer, over records the caller has already read. */
function answeringOf(nodes: readonly NodeRecord[], now: Date): ReadonlySet<string> {
  const answering = new Set<string>();
  for (const record of nodes) {
    if (isNodeAnswering(record, now)) answering.add(record.id);
  }
  return answering;
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
