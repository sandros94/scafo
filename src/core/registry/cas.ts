/* JSON documents over the conditional-write store: read, create, update, delete. */

import { safeJsonParse } from "unsecure/sanitize";
import { ScafoError } from "../error.ts";
import type { CasHeaders } from "../types/store.ts";
import { type RetryOptions, withRetry } from "../utils/backoff.ts";
import { isCasConflict } from "./_shared.ts";
import type { RegistryContext } from "./context.ts";

/** A parsed document plus the ETag needed to condition the next write on it. */
export interface Versioned<T> {
  value: T;
  etag: string;
}

/** Retry controls for a read-modify-write, plus authority to keep mutating. */
export interface UpdateJsonOptions extends RetryOptions {
  /** Stops before another read or conditional write once the caller loses authority. */
  signal?: AbortSignal;
}

/** Reads and parses `key`, or null when it does not exist. */
export async function readJson<T>(ctx: RegistryContext, key: string): Promise<Versioned<T> | null> {
  const object = await ctx.store.get(key);
  if (object === null) return null;

  let value: T;
  try {
    /* A stored document is text from the bucket, and every record here is keyed
       by data: it is read without the keys an object answers for on its own. */
    value = safeJsonParse<T>(object.body);
  } catch (error) {
    throw new ScafoError("store-nonconforming", "Stored object is not valid JSON", {
      detail: `"${key}" could not be parsed`,
      cause: error,
    });
  }
  return { value, etag: object.etag };
}

/** Like {@link readJson}, but throws `ScafoError("not-found")` when absent. */
export async function requireJson<T>(ctx: RegistryContext, key: string): Promise<Versioned<T>> {
  const found = await readJson<T>(ctx, key);
  if (found === null) {
    throw new ScafoError("not-found", "Object not found", { detail: `"${key}" does not exist` });
  }
  return found;
}

/** Writes `value` under `key` with the given precondition, if any. */
export async function putJson<T>(
  ctx: RegistryContext,
  key: string,
  value: T,
  cas?: CasHeaders,
): Promise<{ etag: string }> {
  return ctx.store.put(key, serialize(value), cas);
}

/** Creates `key`; throws `ScafoError("cas-conflict")` when it already exists. */
export async function createJson<T>(
  ctx: RegistryContext,
  key: string,
  value: T,
): Promise<{ etag: string }> {
  return putJson(ctx, key, value, { ifNoneMatch: "*" });
}

/**
 * Read → mutate → conditional write. A losing write is retried from a fresh read
 * (bounded, jittered — see {@link RetryOptions}), so `mutate` may run more than
 * once and must stay free of side effects. Throws `not-found` when `key` is absent.
 */
export async function updateJson<T>(
  ctx: RegistryContext,
  key: string,
  mutate: (current: T) => T | Promise<T>,
  opts?: UpdateJsonOptions,
): Promise<Versioned<T>> {
  const { signal, isRetryable, ...retry } = opts ?? {};
  return withRetry(
    async () => {
      throwIfAborted(signal);
      const current = await requireJson<T>(ctx, key);
      throwIfAborted(signal);
      const next = await mutate(current.value);
      throwIfAborted(signal);
      const { etag } = await putJson(ctx, key, next, { ifMatch: current.etag });
      return { value: next, etag };
    },
    {
      ...retry,
      isRetryable: (error): boolean => {
        throwIfAborted(signal);
        return isRetryable?.(error) ?? isCasConflict(error);
      },
    },
  );
}

/**
 * Deletes `key`, tolerating absence.
 *
 * CAVEAT: S3 has no conditional delete, so this write cannot be fenced by an
 * ETag. Callers gate deletes behind the coordinator lease instead.
 */
export async function deleteKey(ctx: RegistryContext, key: string): Promise<void> {
  await ctx.store.del(key);
}

function serialize(value: unknown): string {
  return JSON.stringify(value, undefined, 2);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason;
}
