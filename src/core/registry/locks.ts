/* Bucket-backed named locks: conditional creation, periodic refresh, stale
   takeover. Every call is non-blocking; a caller that wants to wait polls. */

import { ScafoError } from "../error.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, deleteKey, putJson, readJson } from "./cas.ts";
import { nowDate, nowIso, type RegistryContext } from "./context.ts";

/** How often a holder restamps a lock it means to keep. */
export const LOCK_REFRESH_MS: number = 5_000;

/** How long a lock may go unrefreshed before another caller may take it over. */
export const LOCK_STALE_MS: number = 10_000;

/** How often a caller waiting for a held lock asks for it again. */
export const LOCK_POLL_MS: number = 1_000;

/** One family of named locks: where its records live, and how long it waits. */
export interface LockSpace {
  /** Bucket key one name's record lives at; it validates the name. */
  keyOf: (name: string) => string;
  refreshMs: number;
  staleMs: number;
  /** How often a caller of this space should ask again for a name it wants. */
  pollMs: number;
}

/** What a lock record holds; who has it, since when, and as of when. */
export interface NamedLock {
  holder: string;
  acquiredAt: string;
  /** Restamped on every refresh; the field staleness is measured from. */
  refreshedAt: string;
}

/** A held lock together with the ETag that conditions its next write. */
export interface LockHandle {
  name: string;
  lock: NamedLock;
  etag: string;
}

/** True once `refreshedAt` has aged past `staleMs`. Unparseable times count as stale. */
export function isLockStale(lock: NamedLock, now: Date, staleMs: number): boolean {
  const refreshed = Date.parse(lock.refreshedAt);
  if (!Number.isFinite(refreshed)) return true;
  return refreshed + staleMs <= now.getTime();
}

/** Takes a lock or throws cas-conflict. Stale takeover is conditional on the
 * record read, so competing takeovers cannot both win. */
export async function acquireLock(
  ctx: RegistryContext,
  space: LockSpace,
  name: string,
  holder: string,
): Promise<LockHandle> {
  const key = space.keyOf(name);
  const at = nowIso(ctx);
  const lock: NamedLock = { holder, acquiredAt: at, refreshedAt: at };

  try {
    const { etag } = await createJson(ctx, key, lock);
    return { name, lock, etag };
  } catch (error) {
    if (!isCasConflict(error)) throw error;
  }

  const current = await readJson<NamedLock>(ctx, key);
  if (current === null || !isLockStale(current.value, nowDate(ctx), space.staleMs)) {
    throw taken(name, current?.value ?? null);
  }

  try {
    const { etag } = await putJson(ctx, key, lock, { ifMatch: current.etag });
    return { name, lock, etag };
  } catch (error) {
    if (isCasConflict(error)) throw taken(name, current.value);
    throw error;
  }
}

/** Refreshes a held lock. Any failed conditional write is lease-lost. */
export async function refreshLock(
  ctx: RegistryContext,
  space: LockSpace,
  handle: LockHandle,
): Promise<LockHandle> {
  const lock: NamedLock = { ...handle.lock, refreshedAt: nowIso(ctx) };

  try {
    const { etag } = await putJson(ctx, space.keyOf(handle.name), lock, { ifMatch: handle.etag });
    return { name: handle.name, lock, etag };
  } catch (error) {
    /* Neither conflict nor transport failure proves the refresh landed. */
    throw lost(handle, error);
  }
}

/** Releases only the handle's current record. The store lacks conditional delete,
 * so refresh/stale intervals protect the read-delete window. */
export async function releaseLock(
  ctx: RegistryContext,
  space: LockSpace,
  handle: LockHandle,
): Promise<boolean> {
  const key = space.keyOf(handle.name);

  const current = await readJson<NamedLock>(ctx, key);
  if (current === null || current.etag !== handle.etag) return false;

  await deleteKey(ctx, key);
  return true;
}

/**
 * A holder id for one process: the node it runs on, plus enough entropy to tell
 * two daemons sharing a node id apart in a record that outlived one of them.
 */
export function lockHolder(nodeId: string): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(4))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `${nodeId}-${hex}`;
}

function taken(name: string, lock: NamedLock | null): ScafoError {
  return new ScafoError("cas-conflict", "Lock is held", {
    detail:
      lock === null
        ? `"${name}" was written while it was being taken; ask for it again`
        : `"${name}" is held by "${lock.holder}" and was refreshed at ${lock.refreshedAt}`,
  });
}

function lost(handle: LockHandle, cause: unknown): ScafoError {
  return new ScafoError("lease-lost", "Lock is no longer held", {
    detail: `"${handle.name}", taken by "${handle.lock.holder}" at ${handle.lock.acquiredAt}, was superseded`,
    cause,
  });
}
