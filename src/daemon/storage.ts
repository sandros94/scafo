/* Node-local `/v1/storage` authentication and renewable locks. Failed refreshes
   drop local ownership; stale locks are recoverable after restart. */

import type { H3Event } from "h3";
import { isScafoError, ScafoError } from "../core/error.ts";
import { lockHolder } from "../core/registry/locks.ts";
import {
  acquireTlsLock,
  refreshTlsLock,
  releaseTlsLock,
  TLS_LOCK_REFRESH_MS,
  type TlsLockHandle,
} from "../core/registry/tls-lock.ts";
import { timingSafeEqualText } from "../core/utils/secret.ts";
import type { DaemonContext } from "./app.ts";
import { bearerToken } from "./middleware.ts";

/** Header a caller states the protocol version it speaks in. */
export const STORAGE_VERSION_HEADER: string = "x-scafo-storage-version";

/** The only version this node serves; an absent header means this one. */
export const STORAGE_VERSION: string = "1";

/** Bytes of entropy behind the token guarding the surface. */
export const STORAGE_TOKEN_BYTES: number = 32;

/** What the storage routes are served from, and what keeps their locks alive. */
export interface StorageService {
  /**
   * Refuses a request presenting the wrong token, or none, or stating a protocol
   * version this node does not serve. Throws; it answers nothing itself.
   */
  admit(event: H3Event): void;
  /** Takes the named lock for this process. Throws `cas-conflict` when it is held. */
  lock(name: string): Promise<void>;
  /** Gives the named lock up. Never throws over one this process has already lost. */
  unlock(name: string): Promise<void>;
  /** Names this process holds right now. */
  held(): string[];
  /** Begins refreshing what this process holds. */
  start(): void;
  /** Stops refreshing. Anything still held goes stale and is taken over. */
  stop(): void;
  /** One refresh of everything held, awaited. Never throws. */
  refresh(): Promise<void>;
}

export interface StorageServiceOptions {
  /**
   * Every token this node admits, primary first and never empty. One value on a
   * node that minted its own, which is the ordinary case; several only while an
   * operator rotates a set they supplied, and the first of those is the one in
   * the node's state directory. A service given none admits nobody.
   */
  tokens: string[];
  /** Time between refreshes. Defaults to {@link TLS_LOCK_REFRESH_MS}. */
  intervalMs?: number;
  /** Where a lost lock is reported. Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Builds the storage service for this node. Nothing is refreshed until
 * {@link StorageService.start} is called, or {@link StorageService.refresh} is
 * awaited.
 *
 * A REFRESH THAT DOES NOT LAND DROPS THE LOCK, whatever went wrong. A refused
 * conditional write and an unreachable bucket are indistinguishable from here,
 * and the safe reading of both is the same one: go on holding a lock this
 * process may no longer have and two callers are inside it at once, which is the
 * single outcome a lock exists to prevent.
 */
export function createStorageService(
  daemon: DaemonContext,
  opts: StorageServiceOptions,
): StorageService {
  const intervalMs = opts.intervalMs ?? TLS_LOCK_REFRESH_MS;
  const log = opts.log ?? ((message: string): void => console.error(message));
  /* Process-unique, and it names the node so that a record outliving its holder
     still says where that holder was: two daemons sharing one node id would
     otherwise be indistinguishable in it. */
  const holder = lockHolder(daemon.nodeId);

  const holding = new Map<string, TlsLockHandle>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  async function refresh(): Promise<void> {
    /* Refreshes must not overlap: a slow bucket would otherwise queue up writes
       conditioned on ETags a later one has already replaced. */
    if (inFlight) return;
    inFlight = true;

    try {
      /* The map may be written while this runs: dropping the entry the loop is
         standing on is defined, and one a `lock()` adds mid-pass is simply
         restamped a moment after it was taken. */
      for (const [name, handle] of holding) {
        try {
          holding.set(name, await refreshTlsLock(daemon.registry, handle));
        } catch (error) {
          holding.delete(name);
          log(`scafo: lock "${name}" was lost (${describe(error)})`);
        }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    refresh,

    admit(event: H3Event): void {
      /* Shaped like every other authentication failure — no message, no detail,
         the reason only in `cause`, where it reaches the logs and not the
         client — so a caller cannot tell a wrong token from a missing one. */
      if (!admits(opts.tokens, bearerToken(event))) {
        throw new ScafoError("auth-invalid", "Authentication failed", {
          cause: new Error("the presented token is not one of this node's storage tokens"),
        });
      }

      const stated = event.req.headers.get(STORAGE_VERSION_HEADER)?.trim();
      if (stated !== undefined && stated !== "" && stated !== STORAGE_VERSION) {
        throw new ScafoError("invalid-input", "Unsupported storage protocol version", {
          detail:
            `this node serves version ${STORAGE_VERSION} of the storage protocol, ` +
            `and the request stated "${stated}"`,
        });
      }
    },

    async lock(name: string): Promise<void> {
      holding.set(name, await acquireTlsLock(daemon.registry, name, holder));
    },

    async unlock(name: string): Promise<void> {
      const handle = holding.get(name);
      holding.delete(name);

      /*
       * Never taken here, or lost while it was. Nothing is removed, because what
       * is at that key now belongs to whoever holds it. Unlocking is IDEMPOTENT
       * by contract — a caller unlocking twice, or unlocking after this daemon
       * restarted, is not a failure and is answered as a success.
       */
      if (handle === undefined) {
        log(`scafo: lock "${name}" was released without being held here`);
        return;
      }
      if (!(await releaseTlsLock(daemon.registry, handle))) {
        log(`scafo: lock "${name}" had already been taken over when it was released`);
      }
    },

    held(): string[] {
      return [...holding.keys()].sort();
    },

    start(): void {
      if (timer !== null) return;

      timer = setInterval(() => void refresh(), intervalMs);
      /* The loop must never be the reason the process stays alive. */
      const handle = timer as { unref?: () => void };
      handle.unref?.();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

/**
 * Whether what a caller presented is one of this node's tokens.
 *
 * EVERY TOKEN IS COMPARED, however early one of them matches: returning at the
 * first hit would take a length of time that depends on WHICH token was
 * presented, which is the one thing a constant-time compare exists not to say.
 * The comparison itself is the left operand throughout, so nothing short-circuits
 * it away.
 */
function admits(tokens: string[], presented: string): boolean {
  let matched = false;
  for (const token of tokens) matched = timingSafeEqualText(presented, token) || matched;
  return matched;
}

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
