/* The coordinator lease: a fenced, CAS-guarded lock held by exactly one node. */

import { ScafoError } from "../error.ts";
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

/**
 * What long lease-gated work calls at its safe points — between two
 * applications, before a deletion — to keep the lease from expiring under it.
 * Answers the handle to fence and verify with from then on: the same one when
 * no renewal was due, a renewed one otherwise. Throws `ScafoError("lease-lost")`
 * when the renewal fails, at which point the work must stop writing.
 */
export type KeepAlive = () => Promise<LeaseHandle>;

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
  /* What this call wrote, kept so a refusal can be checked against the record. */
  let written: CoordinatorLease | undefined;

  try {
    const current = await readJson<CoordinatorLease>(ctx, key);
    if (current === null) {
      written = { v: 1, node: nodeId, acquiredAt: nowIso(ctx), ttlMs, fence: 1 };
      const { etag } = await createJson(ctx, key, written);
      return { lease: written, etag };
    }

    const held = current.value;
    if (held.node !== nodeId && !isLeaseExpired(held, nowDate(ctx))) return null;

    written = { v: 1, node: nodeId, acquiredAt: nowIso(ctx), ttlMs, fence: held.fence + 1 };
    const { etag } = await putJson(ctx, key, written, { ifMatch: current.etag });
    return { lease: written, etag };
  } catch (error) {
    if (!isCasConflict(error)) throw error;
    if (written === undefined) return null;

    /* A refusal may be the repeat of a write that landed unanswered: the store
       driver repeats a write the store did not answer, and the repeat is refused
       by its own precondition. Node, fence and moment together name the write. */
    const after = await readJson<CoordinatorLease>(ctx, key);
    if (after === null) return null;
    const stored = after.value;
    const ours =
      stored.node === written.node &&
      stored.fence === written.fence &&
      stored.acquiredAt === written.acquiredAt;
    return ours ? { lease: stored, etag: after.etag } : null;
  }
}

/**
 * Extends the lease in place: same fence, fresh `acquiredAt`. Throws
 * `ScafoError("lease-lost")` when someone else has written the lease since.
 *
 * A refused write is not on its own proof of that. The store driver repeats a
 * write the store failed to answer, and a repeat of one that had silently landed
 * is refused by its own precondition — so the record, not the answer to the
 * write, is what says whether this node is still the coordinator.
 */
export async function renewLease(ctx: RegistryContext, handle: LeaseHandle): Promise<LeaseHandle> {
  const lease: CoordinatorLease = { ...handle.lease, acquiredAt: nowIso(ctx) };

  try {
    const { etag } = await putJson(ctx, coordinatorKey(), lease, { ifMatch: handle.etag });
    return { lease, etag };
  } catch (error) {
    if (!isCasConflict(error)) throw error;
    const held = await stillHeld(ctx, handle);
    if (held === null) throw leaseLost(handle, error);
    return held;
  }
}

/**
 * The lease as it stands when it is still this handle's — the same node at the
 * same fence — or null when anyone else has written it.
 *
 * Node and fence together name one tenancy: every acquisition raises the fence,
 * so no other holder, and no later run of this one, can ever write the pair this
 * handle carries. The ETag cannot answer the question: a renewal that landed
 * without being acknowledged left an ETag this caller was never told.
 */
async function stillHeld(ctx: RegistryContext, handle: LeaseHandle): Promise<LeaseHandle | null> {
  const current = await readJson<CoordinatorLease>(ctx, coordinatorKey());
  if (current === null) return null;

  const lease = current.value;
  if (lease.node !== handle.lease.node || lease.fence !== handle.lease.fence) return null;
  return { lease, etag: current.etag };
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

function leaseLost(handle: LeaseHandle, cause: unknown): ScafoError {
  return new ScafoError("lease-lost", "Coordinator lease is no longer held", {
    detail: `fence ${handle.lease.fence} held by "${handle.lease.node}" was superseded`,
    cause,
  });
}
