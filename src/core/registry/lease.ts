/* The coordinator lease: a fenced, CAS-guarded lock held by exactly one node. */

import { ScaloError } from "../error.ts";
import type { CoordinatorLease } from "../types/registry.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, putJson, readJson } from "./cas.ts";
import { nowDate, nowIso, type RegistryContext } from "./context.ts";
import { coordinatorKey } from "./paths.ts";

/** A held lease together with the ETag that fences its next write. */
export interface LeaseHandle {
  lease: CoordinatorLease;
  etag: string;
}

export const DEFAULT_LEASE_TTL_MS: number = 15_000;

/** True once `acquiredAt + ttlMs` has passed. Unparseable timestamps count as expired. */
export function isLeaseExpired(lease: CoordinatorLease, now: Date): boolean {
  const acquired = Date.parse(lease.acquiredAt);
  if (!Number.isFinite(acquired)) return true;
  return acquired + lease.ttlMs <= now.getTime();
}

/**
 * Takes the lease when it is free, expired, or already this node's. Returns null
 * when another node holds a live one, or when the race for it was lost — either
 * way the caller is not the coordinator and must not act as one.
 *
 * `fence` increments on every acquisition, so a stale holder is always outranked.
 */
export async function acquireLease(
  ctx: RegistryContext,
  nodeId: string,
  opts?: { ttlMs?: number },
): Promise<LeaseHandle | null> {
  const key = coordinatorKey();
  const ttlMs = opts?.ttlMs ?? DEFAULT_LEASE_TTL_MS;

  try {
    const current = await readJson<CoordinatorLease>(ctx, key);
    if (current === null) {
      const lease: CoordinatorLease = {
        v: 1,
        node: nodeId,
        acquiredAt: nowIso(ctx),
        ttlMs,
        fence: 1,
      };
      const { etag } = await createJson(ctx, key, lease);
      return { lease, etag };
    }

    const held = current.value;
    if (held.node !== nodeId && !isLeaseExpired(held, nowDate(ctx))) return null;

    const lease: CoordinatorLease = {
      v: 1,
      node: nodeId,
      acquiredAt: nowIso(ctx),
      ttlMs,
      fence: held.fence + 1,
    };
    const { etag } = await putJson(ctx, key, lease, { ifMatch: current.etag });
    return { lease, etag };
  } catch (error) {
    if (isCasConflict(error)) return null;
    throw error;
  }
}

/**
 * Extends the lease in place: same fence, fresh `acquiredAt`. Throws
 * `ScaloError("lease-lost")` when someone else has written the lease since.
 */
export async function renewLease(ctx: RegistryContext, handle: LeaseHandle): Promise<LeaseHandle> {
  const lease: CoordinatorLease = { ...handle.lease, acquiredAt: nowIso(ctx) };

  try {
    const { etag } = await putJson(ctx, coordinatorKey(), lease, { ifMatch: handle.etag });
    return { lease, etag };
  } catch (error) {
    if (isCasConflict(error)) throw leaseLost(handle, error);
    throw error;
  }
}

/**
 * Marks the lease expired (`ttlMs: 0`) so the next node can take it immediately.
 * A conflict means the lease was already taken over — nothing left to release.
 */
export async function releaseLease(ctx: RegistryContext, handle: LeaseHandle): Promise<void> {
  const lease: CoordinatorLease = { ...handle.lease, ttlMs: 0 };

  try {
    await putJson(ctx, coordinatorKey(), lease, { ifMatch: handle.etag });
  } catch (error) {
    if (!isCasConflict(error)) throw error;
  }
}

/** True while `handle` is still the lease's current version. */
export async function verifyLease(ctx: RegistryContext, handle: LeaseHandle): Promise<boolean> {
  const current = await readJson<CoordinatorLease>(ctx, coordinatorKey());
  return current !== null && current.etag === handle.etag;
}

function leaseLost(handle: LeaseHandle, cause: unknown): ScaloError {
  return new ScaloError("lease-lost", "Coordinator lease is no longer held", {
    detail: `fence ${handle.lease.fence} held by "${handle.lease.node}" was superseded`,
    cause,
  });
}
