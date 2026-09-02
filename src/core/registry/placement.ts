/* Placement intent and coordinator decisions. Missing placement is pending;
   production readers start nothing until one exists. */

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

/** Placement write result. `stale` preserves a higher-fence coordinator decision;
    `cas-conflict` requires a re-read. */
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
  /** Read concurrency or shared gate. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number | ConcurrencyGate;
}

/** Placement decisions keyed by environment. Reads are bounded and retain listing order. */
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

/** Writes a coordinator-fenced placement with CAS. Callers do not use empty
    nodes to turn a fleet-wide outage into a no-service decision. */
export async function writePlacement(
  ctx: RegistryContext,
  project: string,
  env: string,
  nodes: string[],
  lease: LeaseHandle,
): Promise<PlacementWrite> {
  const key = placementKey(project, env);
  const current = await readJson<PlacementRecord>(ctx, key);
  /* Canonical ordering prevents equivalent decisions from churning. */
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
