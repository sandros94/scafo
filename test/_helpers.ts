/* Shared fixtures: seeded input, manual time, injected store faults, and registry invariants. */

import { expect } from "vitest";
import { ScafoError, type ScafoErrorCode } from "../src/core/error.ts";
import {
  coordinatorKey,
  domainKey,
  domainsPrefix,
  environmentKey,
  listEnvironments,
  listProjects,
  readJson,
  type RegistryContext,
} from "../src/core/registry/index.ts";
import type {
  CoordinatorLease,
  DomainClaim,
  EnvironmentRecord,
} from "../src/core/types/registry.ts";
import type { CasHeaders, CasStore, StoredObject } from "../src/core/types/store.ts";
import { SLUG_MAX_LENGTH } from "../src/core/utils/slug.ts";

/** xorshift32; returns floats in `[0, 1)`. The same seed always replays the same run. */
export function seededRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const SLUG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A valid slug of at most `maxLen` characters: lowercase alphanumeric segments
 * joined by single hyphens, never leading, trailing or doubled.
 */
export function randomSlug(rng: () => number, maxLen: number = 12): string {
  const limit = Math.max(1, Math.min(maxLen, SLUG_MAX_LENGTH));
  const wanted = 1 + Math.floor(rng() * 3);
  const segments: string[] = [];
  let used = 0;

  for (let i = 0; i < wanted; i++) {
    const separator = segments.length === 0 ? 0 : 1;
    const room = limit - used - separator;
    if (room < 1) break;

    const length = 1 + Math.floor(rng() * Math.min(room, 6));
    let segment = "";
    for (let c = 0; c < length; c++) segment += SLUG_CHARS[Math.floor(rng() * SLUG_CHARS.length)];
    segments.push(segment);
    used += separator + segment.length;
  }

  return segments.join("-");
}

/** A {@link RegistryContext} whose clock only moves when the test says so. */
export interface ManualClock {
  ctx: RegistryContext;
  /** Advances the injected clock by `ms`. */
  tick: (ms: number) => void;
  /** The injected clock, in epoch milliseconds. */
  nowMs: () => number;
}

export const CLOCK_START_MS: number = Date.parse("2026-01-01T00:00:00.000Z");

export function ctxWith(store: CasStore, startMs: number = CLOCK_START_MS): ManualClock {
  let current = startMs;
  return {
    ctx: { store, now: (): Date => new Date(current) },
    tick: (ms: number): void => {
      current += ms;
    },
    nowMs: (): number => current,
  };
}

/**
 * Wraps a {@link CasStore} so a test can kill the n-th write or interleave a
 * competing writer. Reads are never faulted, so recovery paths stay observable.
 */
export class FaultStore implements CasStore {
  /** Reads dispatched to the wrapped store; never faulted, only counted. */
  gets: number = 0;
  /** Puts dispatched to the wrapped store, including ones that then failed. */
  puts: number = 0;
  /** Deletes dispatched to the wrapped store. */
  dels: number = 0;
  /** Runs before every put; write through the wrapped store here to race the caller. */
  onBeforePut?: (key: string) => void | Promise<void>;
  /** Runs before every delete; the same seam for a race against a multi-step deletion. */
  onBeforeDel?: (key: string) => void | Promise<void>;

  readonly #inner: CasStore;
  #budget: number | null = null;
  #error: Error | null = null;

  constructor(inner: CasStore) {
    this.#inner = inner;
  }

  /** Lets `n` write ops (put or del) through, then throws `error` on the next one. */
  failAfter(n: number, error?: Error): void {
    this.#budget = n;
    this.#error =
      error ??
      new ScafoError("draining", "Injected fault", {
        detail: `write ${String(n + 1)} was killed`,
      });
  }

  /** Lifts the fault budget; subsequent writes go through again. */
  clearFaults(): void {
    this.#budget = null;
    this.#error = null;
  }

  get(key: string): Promise<StoredObject | null> {
    this.gets++;
    return this.#inner.get(key);
  }

  getBytes(key: string): Promise<Uint8Array | null> {
    this.gets++;
    return this.#inner.getBytes(key);
  }

  async put(key: string, body: string, cas?: CasHeaders): Promise<{ etag: string }> {
    await this.onBeforePut?.(key);
    this.#spend();
    this.puts++;
    return this.#inner.put(key, body, cas);
  }

  async del(key: string): Promise<void> {
    await this.onBeforeDel?.(key);
    this.#spend();
    this.dels++;
    await this.#inner.del(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }

  #spend(): void {
    if (this.#budget === null) return;
    if (this.#budget <= 0) throw this.#error ?? new Error("Injected fault");
    this.#budget--;
  }
}

/**
 * Wraps a {@link CasStore} to observe how its reads run — how many were in
 * flight at once, and in what order they started — and to hold one key's read
 * back or fail it outright. Writes and listings pass straight through.
 *
 * A delay is what makes an ordering assertion mean anything: reads that answer
 * in the order they were asked cannot tell a result assembled by input order
 * from one assembled by completion order.
 */
export class ObservingStore implements CasStore {
  /** Most reads in flight at one moment, since the last {@link ObservingStore.reset}. */
  peakReads: number = 0;
  /** Keys read since then, in the order the reads started. */
  reads: string[] = [];
  /** Milliseconds a key's read waits before it answers. */
  readonly delays: Map<string, number> = new Map();
  /** What a key's read throws instead of answering. */
  readonly faults: Map<string, Error> = new Map();

  readonly #inner: CasStore;
  #active = 0;

  constructor(inner: CasStore) {
    this.#inner = inner;
  }

  /** Forgets what has been read so far; the delays and faults stay. */
  reset(): void {
    this.peakReads = 0;
    this.reads = [];
  }

  async get(key: string): Promise<StoredObject | null> {
    this.reads.push(key);
    this.#active++;
    this.peakReads = Math.max(this.peakReads, this.#active);

    try {
      const ms = this.delays.get(key);
      if (ms !== undefined) await new Promise((resolve) => setTimeout(resolve, ms));

      const fault = this.faults.get(key);
      if (fault !== undefined) throw fault;
      return await this.#inner.get(key);
    } finally {
      this.#active--;
    }
  }

  /* Not instrumented: the delays and faults above are about the registry's own
     reads, and nothing observed here reads an object as bytes. */
  getBytes(key: string): Promise<Uint8Array | null> {
    return this.#inner.getBytes(key);
  }

  put(key: string, body: string, cas?: CasHeaders): Promise<{ etag: string }> {
    return this.#inner.put(key, body, cas);
  }

  del(key: string): Promise<void> {
    return this.#inner.del(key);
  }

  list(prefix: string): Promise<string[]> {
    return this.#inner.list(prefix);
  }
}

export interface InvariantOptions {
  /**
   * Tolerates a claim whose environment record is gone. `executeReap` deletes the
   * environment before its claims, so a killed run leaves the claim behind.
   */
  allowOrphanClaims?: boolean;
}

/**
 * Reads the whole registry and asserts it is referentially safe: pointers only
 * ever name records that exist. A claim without the environment listing it is
 * legal (claim-first crash state); a listing without a claim is not.
 */
export async function invariants(store: CasStore, opts?: InvariantOptions): Promise<void> {
  const ctx: RegistryContext = { store };

  for (const project of await listProjects(ctx)) {
    for (const name of await listEnvironments(ctx, project)) {
      const found = await readJson<EnvironmentRecord>(ctx, environmentKey(project, name));
      if (found === null) continue;
      const environment = found.value;

      for (const host of environment.domains) {
        const claim = await readJson<DomainClaim>(ctx, domainKey(host));
        expect(claim, `${project}/${name} lists "${host}" without a claim`).not.toBeNull();
        expect({ project: claim?.value.project, environment: claim?.value.environment }).toEqual({
          project,
          environment: name,
        });
      }
    }
  }

  for (const key of await store.list(domainsPrefix())) {
    const claim = await readJson<DomainClaim>(ctx, key);
    if (claim === null || opts?.allowOrphanClaims === true) continue;

    const environment = await readJson<EnvironmentRecord>(
      ctx,
      environmentKey(claim.value.project, claim.value.environment),
    );
    expect(environment, `claim "${key}" points at a missing environment`).not.toBeNull();
  }

  const lease = await readJson<CoordinatorLease>(ctx, coordinatorKey());
  if (lease !== null) expect(lease.value.fence).toBeGreaterThanOrEqual(1);
}

/**
 * Runs `fn` and returns the {@link ScafoError} it threw. Synchronous throws count
 * as rejections, which `MemoryCasStore.put` relies on.
 */
export async function rejectionOf(fn: () => Promise<unknown>): Promise<ScafoError> {
  const run = async (): Promise<unknown> => fn();
  const caught: unknown = await run().then(
    (): unknown => null,
    (error: unknown): unknown => error,
  );

  expect(caught, "expected the call to reject").toBeInstanceOf(ScafoError);
  return caught as ScafoError;
}

/** Asserts `fn` rejects with `code`, and hands the error back for further checks. */
export async function rejectsWith(
  fn: () => Promise<unknown>,
  code: ScafoErrorCode,
): Promise<ScafoError> {
  const error = await rejectionOf(fn);
  expect(error.code).toBe(code);
  return error;
}
