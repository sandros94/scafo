/*
 * Named locks in the same bucket, for a colocated process that must serialize
 * work across its own restarts and across the nodes of an installation — TLS
 * issuance above all, where two holders would mean two orders for one name.
 *
 * A lock is one record taken with `If-None-Match` and kept alive by refreshing
 * it. Its holder refreshes every {@link TLS_LOCK_REFRESH_MS}, and a record left
 * unrefreshed for {@link TLS_LOCK_STALE_MS} may be taken over, so a holder that
 * crashed blocks the next one for that long rather than forever. ACQUISITION
 * NEVER WAITS: a caller that wants a held lock asks again, every
 * {@link TLS_LOCK_POLL_MS}.
 *
 * The three durations mirror the file-backed storage the TLS automation these
 * locks serve ships with, so an installation keeping its certificates in a
 * bucket waits for the same things, for the same lengths of time, as one keeping
 * them on a disk.
 */

import { ScafoError } from "../error.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, deleteKey, putJson, readJson } from "./cas.ts";
import { nowDate, nowIso, type RegistryContext } from "./context.ts";
import { tlsLockKey } from "./paths.ts";

/** How often a holder restamps a lock it means to keep. */
export const TLS_LOCK_REFRESH_MS: number = 5_000;

/** How long a lock may go unrefreshed before another caller may take it over. */
export const TLS_LOCK_STALE_MS: number = 10_000;

/** How often a caller waiting for a held lock should ask for it again. */
export const TLS_LOCK_POLL_MS: number = 1_000;

/** What a lock record holds; who has it, since when, and as of when. */
export interface TlsLock {
  holder: string;
  acquiredAt: string;
  /** Restamped on every refresh; the field staleness is measured from. */
  refreshedAt: string;
}

/** A held lock together with the ETag that conditions its next write. */
export interface TlsLockHandle {
  name: string;
  lock: TlsLock;
  etag: string;
}

/** True once `refreshedAt` has aged past {@link TLS_LOCK_STALE_MS}. Unparseable times count as stale. */
export function isTlsLockStale(lock: TlsLock, now: Date): boolean {
  const refreshed = Date.parse(lock.refreshedAt);
  if (!Number.isFinite(refreshed)) return true;
  return refreshed + TLS_LOCK_STALE_MS <= now.getTime();
}

/**
 * Takes the lock for `holder`, or throws `ScafoError("cas-conflict")` when
 * somebody else has a live one. IT NEVER WAITS — a caller that wants it polls.
 *
 * A record whose holder stopped refreshing it is taken over rather than waited
 * out: that holder is gone, and a lock nobody is left to release would refuse
 * every later attempt forever. The takeover is conditioned on the very record
 * the staleness was read from, so two callers racing to take one over cannot
 * both win it.
 */
export async function acquireTlsLock(
  ctx: RegistryContext,
  name: string,
  holder: string,
): Promise<TlsLockHandle> {
  const key = tlsLockKey(name);
  const at = nowIso(ctx);
  const lock: TlsLock = { holder, acquiredAt: at, refreshedAt: at };

  try {
    const { etag } = await createJson(ctx, key, lock);
    return { name, lock, etag };
  } catch (error) {
    if (!isCasConflict(error)) throw error;
  }

  const current = await readJson<TlsLock>(ctx, key);
  if (current === null || !isTlsLockStale(current.value, nowDate(ctx))) {
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

/**
 * Keeps the lock alive: same holder, same `acquiredAt`, fresh `refreshedAt`,
 * conditioned on the record this handle names.
 *
 * Throws `ScafoError("lease-lost")` when that record has changed since — the
 * lock belongs to somebody else now, and the caller must stop behaving as though
 * it held one.
 */
export async function refreshTlsLock(
  ctx: RegistryContext,
  handle: TlsLockHandle,
): Promise<TlsLockHandle> {
  const lock: TlsLock = { ...handle.lock, refreshedAt: nowIso(ctx) };

  try {
    const { etag } = await putJson(ctx, tlsLockKey(handle.name), lock, { ifMatch: handle.etag });
    return { name: handle.name, lock, etag };
  } catch (error) {
    if (isCasConflict(error)) throw lost(handle, error);
    throw error;
  }
}

/**
 * Gives the lock up, answering whether this handle still held it. False means
 * the lock had already been taken over, and NOTHING was removed.
 *
 * IT NEVER TAKES A LOCK AWAY FROM WHOEVER HOLDS IT NOW, which is the whole point
 * of reading before removing. CAVEAT: the store has no conditional delete, so
 * the ETag is checked by that read rather than by the removal itself. What
 * closes the window between them is the freshness rule — a lock this caller
 * still holds was restamped within {@link TLS_LOCK_REFRESH_MS}, and nobody may
 * take one over before {@link TLS_LOCK_STALE_MS}.
 */
export async function releaseTlsLock(
  ctx: RegistryContext,
  handle: TlsLockHandle,
): Promise<boolean> {
  const key = tlsLockKey(handle.name);

  const current = await readJson<TlsLock>(ctx, key);
  if (current === null || current.etag !== handle.etag) return false;

  await deleteKey(ctx, key);
  return true;
}

function taken(name: string, lock: TlsLock | null): ScafoError {
  return new ScafoError("cas-conflict", "Lock is held", {
    detail:
      lock === null
        ? `"${name}" was written while it was being taken; ask for it again`
        : `"${name}" is held by "${lock.holder}" and was refreshed at ${lock.refreshedAt}`,
  });
}

function lost(handle: TlsLockHandle, cause: unknown): ScafoError {
  return new ScafoError("lease-lost", "Lock is no longer held", {
    detail: `"${handle.name}", taken by "${handle.lock.holder}" at ${handle.lock.acquiredAt}, was superseded`,
    cause,
  });
}
