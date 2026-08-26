/*
 * Placement, as the registry holds it: what an environment asks for — how many
 * nodes (`setReplicas`) and which nodes it may use at all (`setNodeSelector`) —
 * and which nodes the coordinator gave it (the placement records).
 *
 * A placement record is written by the coordinator alone and read by every node.
 * Its ABSENCE is a meaningful pending state and never an error: production
 * daemons require a decision and start nothing until one exists. Only an
 * explicitly selected legacy rolling-upgrade reader retains the old
 * unconstrained fallback.
 */

import { ScafoError } from "../error.ts";
import type {
  EnvironmentRecord,
  NodeSelector,
  PlacementRecord,
  ReplicaCount,
} from "../types/registry.ts";
import { assertReplicas } from "../placement/replicas.ts";
import { assertSelector } from "../placement/selector.ts";
import { type ConcurrencyGate, DEFAULT_CONCURRENCY, mapConcurrent } from "../utils/concurrency.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, putJson, readJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { environmentKey, placementKey, placementPrefix } from "./paths.ts";

/**
 * What one {@link writePlacement} did. Three of the four outcomes write nothing,
 * and each says something different about why:
 *
 * - `written` — the decision changed and now stands.
 * - `unchanged` — the decision was already this one. Rewriting it would churn
 *   the object, its ETag and every reader's view for no change at all.
 * - `cas-conflict` — another writer got there first. The next pass re-reads.
 * - `stale` — the stored decision carries a HIGHER fence than the lease this
 *   write was made under, so it belongs to a coordinator that superseded this
 *   one. Overwriting it would undo the decision of the node now in charge.
 */
export type PlacementOutcome = "written" | "unchanged" | "cas-conflict" | "stale";

export interface PlacementWrite {
  outcome: PlacementOutcome;
  /** The record as it stands afterwards; null only when there is none to report. */
  record: PlacementRecord | null;
}

/** The placement of one environment, or null when none has been decided. */
export async function readPlacement(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<PlacementRecord | null> {
  const found = await readJson<PlacementRecord>(ctx, placementKey(project, env));
  return found?.value ?? null;
}

export interface ListPlacementsOptions {
  /**
   * How many of the reads run at a time, or a gate shared with whatever else
   * the caller is reading in parallel. Defaults to {@link DEFAULT_CONCURRENCY}.
   */
  concurrency?: number | ConcurrencyGate;
}

/**
 * Every placement decision of one project, keyed by environment name.
 *
 * One listing plus a read per DECIDED environment, rather than a read per
 * environment that exists: the environments nobody has decided about — which is
 * all of them until a coordinator runs — cost nothing here.
 *
 * The reads are independent of each other and run in parallel under a bound. The
 * map is keyed in LISTING order all the same, so what a caller iterates does not
 * depend on which read came back first, and a read that throws surfaces the same
 * failure it would have if they had run one after another.
 */
export async function listPlacements(
  ctx: RegistryContext,
  project: string,
  opts?: ListPlacementsOptions,
): Promise<Map<string, PlacementRecord>> {
  const prefix = placementPrefix(project);
  const names = namesFromKeys(await ctx.store.list(prefix), prefix);

  const found = await mapConcurrent(names, opts?.concurrency ?? DEFAULT_CONCURRENCY, async (env) =>
    readJson<PlacementRecord>(ctx, `${prefix}${env}.json`),
  );

  const placements = new Map<string, PlacementRecord>();
  for (const [index, env] of names.entries()) {
    const record = found[index];
    if (record !== null) placements.set(env, record.value);
  }
  return placements;
}

/**
 * Records which nodes serve `env`, under the coordinator's own fence.
 *
 * Conditional on what was read: a create when nothing was there, an `If-Match`
 * when something was. A losing write is NOT retried — the winner is another
 * coordinator, and the loser re-reads on its next tick rather than arguing.
 *
 * Never called with an empty `nodes` by a caller that simply found no live node:
 * "nobody serves this" is a decision no fleet-wide outage is entitled to make.
 */
export async function writePlacement(
  ctx: RegistryContext,
  project: string,
  env: string,
  nodes: string[],
  lease: LeaseHandle,
): Promise<PlacementWrite> {
  const key = placementKey(project, env);
  const current = await readJson<PlacementRecord>(ctx, key);
  /* Sorted here rather than trusted from the caller: the order carries no
     meaning, and two callers naming the same nodes differently must not read as
     two different decisions and rewrite the record at each other forever. */
  const decided = [...nodes].sort();

  if (current !== null) {
    if (current.value.fence > lease.lease.fence) {
      return { outcome: "stale", record: current.value };
    }
    if (deepEqual(current.value.nodes, decided)) {
      return { outcome: "unchanged", record: current.value };
    }
  }

  const record: PlacementRecord = {
    v: 1,
    nodes: decided,
    decidedAt: nowIso(ctx),
    fence: lease.lease.fence,
  };

  try {
    if (current === null) await createJson(ctx, key, record);
    else await putJson(ctx, key, record, { ifMatch: current.etag });
  } catch (error) {
    if (isCasConflict(error)) return { outcome: "cas-conflict", record: current?.value ?? null };
    throw error;
  }
  return { outcome: "written", record };
}

/**
 * Removes the placement of an environment that is gone.
 *
 * Lease-gated for the reason every delete in this registry is: S3 has no
 * conditional delete, so the lease is the only thing keeping two deleters apart.
 * Answers the key it removed, or null when there was nothing to remove.
 */
export async function deletePlacement(
  ctx: RegistryContext,
  project: string,
  env: string,
  lease: LeaseHandle,
): Promise<string | null> {
  const key = placementKey(project, env);
  if ((await readJson<PlacementRecord>(ctx, key)) === null) return null;

  if (!(await verifyLease(ctx, lease))) {
    throw new ScafoError("lease-lost", "Coordinator lease is no longer held", {
      detail: `refusing to remove the placement of "${project}/${env}"`,
    });
  }
  await deleteKey(ctx, key);
  return key;
}

/**
 * Sets how many nodes serve an environment. `"all"` or a whole number of at
 * least 1; anything else is `ScafoError("invalid-input")`.
 *
 * Takes effect on the coordinator's next assignment pass rather than here: this
 * states the intent, and which nodes it lands on stays the coordinator's to
 * decide.
 */
export async function setReplicas(
  ctx: RegistryContext,
  project: string,
  env: string,
  replicas: ReplicaCount,
): Promise<EnvironmentRecord> {
  assertReplicas(replicas);

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => ({ ...current, replicas }),
  );
  return updated.value;
}

/**
 * States which nodes may serve an environment, by the labels they must carry.
 * Passing null clears the constraint, putting every live node back in scope.
 *
 * Validated before anything is written, so a mistyped label never becomes a
 * constraint no node satisfies. Takes effect on the coordinator's next
 * assignment pass, for the same reason {@link setReplicas} does: this states the
 * intent, and which nodes it lands on stays the coordinator's to decide.
 */
export async function setNodeSelector(
  ctx: RegistryContext,
  project: string,
  env: string,
  selector: NodeSelector | null,
): Promise<EnvironmentRecord> {
  if (selector !== null) assertSelector(selector);

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      /* Cleared by REMOVING the field rather than by storing an empty one: the
         selector's presence is semantic, including for the explicit legacy
         fallback, which never runs selector-bearing work without a decision. */
      const { nodeSelector: _cleared, ...rest } = current;
      return selector === null ? rest : { ...rest, nodeSelector: { ...selector } };
    },
  );
  return updated.value;
}
