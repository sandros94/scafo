/*
 * Named locks in the bucket: the mechanics every family of them shares.
 *
 * A lock is one record taken with `If-None-Match` and kept alive by refreshing
 * it. Its holder restamps every {@link LOCK_REFRESH_MS}, and a record left
 * unrefreshed for {@link LOCK_STALE_MS} may be taken over, so a holder that
 * crashed blocks the next one for that long rather than forever.
 * {@link acquireLock} NEVER WAITS: a caller that wants a held lock asks again,
 * every {@link LOCK_POLL_MS}, which is what {@link withLock} does for it.
 *
 * A family is a {@link LockSpace} — where its records live, and the three
 * durations it waits on. There are two: `tls-lock.ts`, whose names come from the
 * colocated ingress storing its issuance state through this node, and
 * `pointer-lock.ts`, which is the fleet's own.
 */

import { ScafoError } from "../error.ts";
import { startBudget } from "../utils/budget.ts";
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

/** What one call to {@link withLock} asks for. */
export interface LockRequest {
  space: LockSpace;
  name: string;
  /** Who is asking; recorded, so a lock nobody released still names its holder. */
  holder: string;
  /**
   * Longest the caller waits to take it before giving up with
   * `ScafoError("cas-conflict")`. Zero tries exactly once.
   */
  timeoutMs: number;
  /** Cancels acquisition and held work under a caller-owned deadline. */
  signal?: AbortSignal;
}

/** True once `refreshedAt` has aged past `staleMs`. Unparseable times count as stale. */
export function isLockStale(lock: NamedLock, now: Date, staleMs: number): boolean {
  const refreshed = Date.parse(lock.refreshedAt);
  if (!Number.isFinite(refreshed)) return true;
  return refreshed + staleMs <= now.getTime();
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

/**
 * Keeps the lock alive: same holder, same `acquiredAt`, fresh `refreshedAt`,
 * conditioned on the record this handle names.
 *
 * Throws `ScafoError("lease-lost")` when that record has changed since — the
 * lock belongs to somebody else now, and the caller must stop behaving as though
 * it held one.
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
    /* A refused conditional write and a store this holder cannot reach are
       indistinguishable here: neither proves the refresh landed. */
    throw lost(handle, error);
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
 * still holds was restamped within `refreshMs`, and nobody may take one over
 * before `staleMs`.
 */
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
 * Runs `fn` holding the named lock, and gives it back whatever happens.
 *
 * Three things it does that a bare {@link acquireLock} does not, and all three
 * are load-bearing for a critical section that outlives one bucket write:
 *
 * - IT WAITS, polling every `pollMs` up to `timeoutMs`, and gives up with
 *   `ScafoError("cas-conflict")` rather than hanging. A caller that cannot have
 *   the lock must find out and decide, not block forever.
 * - IT REFRESHES while `fn` runs. Work worth serializing routinely takes longer
 *   than `staleMs` — bundling and uploading an artifact takes minutes — and an
 *   unrefreshed lock is taken over mid-section, which is the one outcome a lock
 *   exists to prevent.
 * - IT ABORTS `fn` when a refresh does not land, with
 *   `ScafoError("lease-lost")`, and waits for `fn` to clean up. A refused
 *   conditional write and an unreachable bucket are indistinguishable from here
 *   and the safe reading of both is the same: this caller is no longer alone
 *   inside the section. The callback owns cancellation of whatever it launched;
 *   this boundary owns waiting for that cleanup before it reports the loss.
 *
 * A release the bucket refuses is left to go stale, which is the same path a
 * crashed holder takes: it costs the next caller `staleMs` and nothing else.
 */
export async function withLock<T>(
  ctx: RegistryContext,
  request: LockRequest,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { space } = request;
  let handle = await take(ctx, request);

  if (request.signal?.aborted === true) {
    await releaseLock(ctx, space, handle).catch(() => {});
    throw abortReason(request.signal);
  }

  const ending = new AbortController();
  const work = new AbortController();
  /* Rejects the moment a restamp does not land; nothing else ever settles it. */
  const lost = Promise.withResolvers<never>();
  /* Always observed below, but never before `fn` has had its turn to fail. */
  lost.promise.catch(() => {});
  let lockLost = false;
  let lostError: unknown;
  let externallyAborted = false;
  let externalError: unknown;
  const external = Promise.withResolvers<never>();
  external.promise.catch(() => {});
  const abortExternal = (): void => {
    if (externallyAborted) return;
    externallyAborted = true;
    externalError = abortReason(request.signal as AbortSignal);
    work.abort(externalError);
    external.reject(externalError);
  };
  request.signal?.addEventListener("abort", abortExternal, { once: true });
  if (isAborted(request.signal)) abortExternal();

  const keepAlive = (async (): Promise<void> => {
    for (;;) {
      await sleep(space.refreshMs, ending.signal);
      if (ending.signal.aborted) return;

      try {
        handle = await refreshLock(ctx, space, handle);
      } catch (error) {
        lockLost = true;
        lostError = error;
        work.abort(error);
        lost.reject(error);
        return;
      }
    }
  })();

  let running: Promise<T> | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    running = fn(work.signal);
    running.catch(() => {});

    try {
      outcome = { ok: true, value: await Promise.race([running, lost.promise, external.promise]) };
    } catch (error) {
      outcome = { ok: false, error };
    }
  } finally {
    ending.abort();
    request.signal?.removeEventListener("abort", abortExternal);
    await keepAlive;
    /* A refresh may have failed while a completed callback was ending the
       keepalive. Either way, stale work is joined before lease loss escapes. */
    if ((lockLost || externallyAborted) && running !== undefined) await running.catch(() => {});
    if (!lockLost) await releaseLock(ctx, space, handle).catch(() => {});
  }

  /* The refresh failure is the authority loss that decides this section. A
     callback cleanup failure stays observed above but cannot replace it. */
  if (lockLost) throw lostError;
  if (externallyAborted) throw externalError;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
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

/** Takes the lock, asking again every `pollMs` until `timeoutMs` has run out. */
async function take(ctx: RegistryContext, request: LockRequest): Promise<LockHandle> {
  const { space, name, holder, timeoutMs } = request;
  /*
   * TWO CLOCKS, ON PURPOSE, AND THE LINE BETWEEN THEM IS HERE. This budget is a
   * DURATION — how long this caller goes on asking — so it is measured on the
   * monotonic one, like the sleeps it is spent on; a wall clock that steps
   * forward would otherwise spend it without any time having passed and give up
   * on a lock this caller was still entitled to wait for. Everything the RECORD
   * carries stays on `ctx`'s wall clock: `acquiredAt`, `refreshedAt` and the
   * staleness read off them are INSTANTS another node compares against its own,
   * and only a shared clock makes that comparison mean anything.
   */
  const remaining = startBudget(timeoutMs);
  let refusal: unknown = null;

  for (;;) {
    if (request.signal?.aborted === true) throw abortReason(request.signal);
    try {
      const handle = await acquireLock(ctx, space, name, holder);
      if (!isAborted(request.signal)) return handle;
      await releaseLock(ctx, space, handle).catch(() => {});
      throw abortReason(request.signal as AbortSignal);
    } catch (error) {
      if (!isCasConflict(error)) throw error;
      refusal = error;
    }

    const left = remaining();
    if (left <= 0) break;
    await sleep(Math.min(space.pollMs, left), request.signal);
  }

  throw new ScafoError("cas-conflict", "Lock could not be taken", {
    detail:
      `"${name}" was held by somebody else for the whole ${String(timeoutMs)}ms ` +
      `"${holder}" waited for it`,
    cause: refusal,
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new ScafoError("invalid-input", "Lock wait was cancelled");
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** A delay that can be cut short, so nothing is left pending once a section ends. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }

    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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
