/*
 * The named locks a colocated ingress takes through `/v1/storage/locks`, so that
 * TLS issuance is serialized across its own restarts and across the nodes of an
 * installation — two holders would mean two orders for one name.
 *
 * The mechanics are `locks.ts`; this is the keyspace and the three durations.
 * They mirror the file-backed storage the TLS automation these locks serve ships
 * with, so an installation keeping its certificates in a bucket waits for the
 * same things, for the same lengths of time, as one keeping them on a disk.
 *
 * The names are the CALLER's — free-form keys under `_scafo/tls/locks/`, checked
 * only for being addressable — which is why they live apart from the fleet's own
 * fleet-owned locks.
 */

import type { RegistryContext } from "./context.ts";
import {
  acquireLock,
  isLockStale,
  LOCK_POLL_MS,
  LOCK_REFRESH_MS,
  LOCK_STALE_MS,
  type LockHandle,
  type LockSpace,
  type NamedLock,
  refreshLock,
  releaseLock,
} from "./locks.ts";
import { tlsLockKey } from "./paths.ts";

/** How often a holder restamps a lock it means to keep. */
export const TLS_LOCK_REFRESH_MS: number = LOCK_REFRESH_MS;

/** How long a lock may go unrefreshed before another caller may take it over. */
export const TLS_LOCK_STALE_MS: number = LOCK_STALE_MS;

/** How often a caller waiting for a held lock should ask for it again. */
export const TLS_LOCK_POLL_MS: number = LOCK_POLL_MS;

/** Where the locks an ingress takes live, and how long they wait. */
export const TLS_LOCK_SPACE: LockSpace = {
  keyOf: tlsLockKey,
  refreshMs: TLS_LOCK_REFRESH_MS,
  staleMs: TLS_LOCK_STALE_MS,
  pollMs: TLS_LOCK_POLL_MS,
};

/** What a lock record holds; who has it, since when, and as of when. */
export type TlsLock = NamedLock;

/** A held lock together with the ETag that conditions its next write. */
export type TlsLockHandle = LockHandle;

/** True once `refreshedAt` has aged past {@link TLS_LOCK_STALE_MS}. */
export function isTlsLockStale(lock: TlsLock, now: Date): boolean {
  return isLockStale(lock, now, TLS_LOCK_STALE_MS);
}

/**
 * Takes the lock for `holder`, or throws `ScafoError("cas-conflict")` when
 * somebody else has a live one. IT NEVER WAITS — a caller that wants it polls,
 * which is the contract `/v1/storage/locks` is written against.
 */
export function acquireTlsLock(
  ctx: RegistryContext,
  name: string,
  holder: string,
): Promise<TlsLockHandle> {
  return acquireLock(ctx, TLS_LOCK_SPACE, name, holder);
}

/**
 * Keeps the lock alive. Throws `ScafoError("lease-lost")` when the record has
 * changed since — the lock belongs to somebody else now.
 */
export function refreshTlsLock(
  ctx: RegistryContext,
  handle: TlsLockHandle,
): Promise<TlsLockHandle> {
  return refreshLock(ctx, TLS_LOCK_SPACE, handle);
}

/**
 * Gives the lock up, answering whether this handle still held it. False means it
 * had already been taken over, and NOTHING was removed.
 */
export function releaseTlsLock(ctx: RegistryContext, handle: TlsLockHandle): Promise<boolean> {
  return releaseLock(ctx, TLS_LOCK_SPACE, handle);
}
