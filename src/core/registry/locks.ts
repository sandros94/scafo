/* Bucket-backed named locks: conditional creation, periodic refresh, stale
   takeover. Every call is non-blocking; a caller that wants to wait polls. */

import { ScafoError } from "../error.ts";
import { isCasConflict } from "./_shared.ts";
import { randomHex } from "../utils/random.ts";
import { createJson, deleteKey, putJson, readJson, type Versioned } from "./cas.ts";
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
  /**
   * Drawn once at acquisition and kept across refreshes. Holder and moment
   * cannot tell two acquisitions apart when the same holder takes the same name
   * twice within one clock tick; this can.
   */
  token: string;
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
  const lock: NamedLock = { holder, acquiredAt: at, refreshedAt: at, token: randomHex(8) };

  try {
    const { etag } = await createJson(ctx, key, lock);
    return { name, lock, etag };
  } catch (error) {
    if (!isCasConflict(error)) throw error;
  }

  /* A refusal may be the repeat of a write that landed unanswered: the store
     driver repeats a write the store did not answer, and the repeat is refused
     by its own precondition. The record says which it was. */
  const current = await readJson<NamedLock>(ctx, key);
  if (current !== null && isSameWrite(current.value, lock)) {
    return { name, lock, etag: current.etag };
  }
  if (current === null || !isLockStale(current.value, nowDate(ctx), space.staleMs)) {
    throw taken(name, current?.value ?? null);
  }

  try {
    const { etag } = await putJson(ctx, key, lock, { ifMatch: current.etag });
    return { name, lock, etag };
  } catch (error) {
    if (!isCasConflict(error)) throw error;
    const after = await readJson<NamedLock>(ctx, key);
    if (after !== null && isSameWrite(after.value, lock)) {
      return { name, lock, etag: after.etag };
    }
    throw taken(name, after?.value ?? current.value);
  }
}

/** Whether a stored record is the very one this call stamped: same tenancy, same token. */
function isSameWrite(stored: NamedLock, written: NamedLock): boolean {
  return (
    stored.holder === written.holder &&
    stored.acquiredAt === written.acquiredAt &&
    stored.token === written.token
  );
}

/**
 * Refreshes a held lock. A failed conditional write is lease-lost unless the
 * record itself says otherwise: the store driver repeats a write the store
 * failed to answer, and a repeat of one that had silently landed is refused by
 * its own precondition, so a refusal alone would fence a holder that never lost
 * anything. Nothing else proves a refresh landed, so a transport failure, and a
 * record this handle can no longer be read out of, both still cost the lock.
 */
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
    if (isCasConflict(error)) {
      const held = await stillHeld(ctx, space, handle);
      if (held !== null) return held;
    }
    throw lost(handle, error);
  }
}

/**
 * The record as it stands while it is still this handle's — the same holder,
 * taken at the same moment — or null when it is anyone else's, unreadable, or
 * gone.
 *
 * Holder and acquisition time together name one tenancy. The holder alone would
 * not: a lock taken over, given up and taken again carries the same id, and a
 * refusal in that window is a real loss. The ETag cannot answer the question at
 * all, since a refresh that landed without being acknowledged left one this
 * caller was never told.
 */
async function stillHeld(
  ctx: RegistryContext,
  space: LockSpace,
  handle: LockHandle,
): Promise<LockHandle | null> {
  let current: Versioned<NamedLock> | null;
  try {
    current = await readJson<NamedLock>(ctx, space.keyOf(handle.name));
  } catch {
    /* Nothing was proven either way, and an unproven hold is one to give up. */
    return null;
  }
  if (current === null) return null;

  const lock = current.value;
  if (
    lock.holder !== handle.lock.holder ||
    lock.acquiredAt !== handle.lock.acquiredAt ||
    lock.token !== handle.lock.token
  ) {
    return null;
  }
  return { name: handle.name, lock, etag: current.etag };
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
  const hex = randomHex(4);
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
