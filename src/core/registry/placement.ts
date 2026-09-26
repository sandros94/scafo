/* Placement intent and coordinator decisions. Missing placement is pending;
   production readers start nothing until one exists. */

import { ScafoError } from "../error.ts";
import type {
  ApplicationRecord,
  NodeSelector,
  PlacementRecord,
  ReplicaCount,
} from "../types/registry.ts";
import { assertReplicas } from "../placement/replicas.ts";
import { assertSelector } from "../placement/selector.ts";
import { type ConcurrencyGate, DEFAULT_CONCURRENCY, mapConcurrent } from "../utils/concurrency.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { updateApplication } from "./applications.ts";
import { createJson, deleteKey, putJson, readJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { type LeaseHandle, verifyLease } from "./lease.ts";
import { placementKey, placementPrefix } from "./paths.ts";

/** Placement write result. `stale` preserves a higher-fence coordinator decision;
    `cas-conflict` requires a re-read. */
export type PlacementOutcome = "written" | "unchanged" | "cas-conflict" | "stale";

export interface PlacementWrite {
  outcome: PlacementOutcome;
  /** The record as it stands afterwards; null only when there is none to report. */
  record: PlacementRecord | null;
}

/** The placement of one application, or null when none has been decided. */
export async function readPlacement(
  ctx: RegistryContext,
  application: string,
): Promise<PlacementRecord | null> {
  const found = await readJson<PlacementRecord>(ctx, placementKey(application));
  return found?.value ?? null;
}

export interface ListPlacementsOptions {
  /** Read concurrency or shared gate. Defaults to {@link DEFAULT_CONCURRENCY}. */
  concurrency?: number | ConcurrencyGate;
}

/** Placement decisions keyed by application. Reads are bounded and retain listing order. */
export async function listPlacements(
  ctx: RegistryContext,
  opts?: ListPlacementsOptions,
): Promise<Map<string, PlacementRecord>> {
  const prefix = placementPrefix();
  const names = namesFromKeys(await ctx.store.list(prefix), prefix);

  const found = await mapConcurrent(names, opts?.concurrency ?? DEFAULT_CONCURRENCY, async (name) =>
    readJson<PlacementRecord>(ctx, `${prefix}${name}.json`),
  );

  const placements = new Map<string, PlacementRecord>();
  for (const [index, name] of names.entries()) {
    const record = found[index];
    if (record !== null) placements.set(name, record.value);
  }
  return placements;
}

/** Writes a coordinator-fenced placement with CAS. Callers do not use empty
    nodes to turn a fleet-wide outage into a no-service decision. */
export async function writePlacement(
  ctx: RegistryContext,
  application: string,
  nodes: string[],
  lease: LeaseHandle,
): Promise<PlacementWrite> {
  const key = placementKey(application);
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
 * Removes the placement of an application that is gone.
 *
 * Lease-gated for the reason every delete in this registry is: S3 has no
 * conditional delete, so the lease is the only thing keeping two deleters apart.
 * Answers the key it removed, or null when there was nothing to remove.
 */
export async function deletePlacement(
  ctx: RegistryContext,
  application: string,
  lease: LeaseHandle,
): Promise<string | null> {
  const key = placementKey(application);
  if ((await readJson<PlacementRecord>(ctx, key)) === null) return null;

  if (!(await verifyLease(ctx, lease))) {
    throw new ScafoError("lease-lost", "Coordinator lease is no longer held", {
      detail: `refusing to remove the placement of "${application}"`,
    });
  }
  await deleteKey(ctx, key);
  return key;
}

/**
 * Sets how many nodes serve an application. `"all"` or a whole number of at
 * least 1; anything else is `ScafoError("invalid-input")`.
 *
 * Takes effect on the coordinator's next assignment pass rather than here: this
 * states the intent, and which nodes it lands on stays the coordinator's to
 * decide.
 */
export async function setReplicas(
  ctx: RegistryContext,
  application: string,
  replicas: ReplicaCount,
): Promise<ApplicationRecord> {
  assertReplicas(replicas);

  return updateApplication(ctx, application, (current) => ({ ...current, replicas }));
}

/**
 * States which nodes may serve an application, by the labels they must carry.
 * Passing null clears the constraint, putting every live node back in scope.
 *
 * Validated before anything is written, so a mistyped label never becomes a
 * constraint no node satisfies. Takes effect on the coordinator's next
 * assignment pass, for the same reason {@link setReplicas} does: this states the
 * intent, and which nodes it lands on stays the coordinator's to decide.
 */
export async function setNodeSelector(
  ctx: RegistryContext,
  application: string,
  selector: NodeSelector | null,
): Promise<ApplicationRecord> {
  if (selector !== null) assertSelector(selector);

  return updateApplication(ctx, application, (current) => {
    /* Cleared by REMOVING the field rather than by storing an empty one: the
       selector's presence is semantic, and a stored empty one would read as a
       constraint that happens to match everything. */
    const { nodeSelector: _cleared, ...rest } = current;
    return selector === null ? rest : { ...rest, nodeSelector: { ...selector } };
  });
}
