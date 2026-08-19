/* JSON documents over the conditional-write store: read, create, update, delete. */

import { ScaloError } from "../error.ts";
import type { CasHeaders } from "../types/store.ts";
import { type RetryOptions, withRetry } from "../utils/backoff.ts";
import type { RegistryContext } from "./context.ts";

/** A parsed document plus the ETag needed to condition the next write on it. */
export interface Versioned<T> {
  value: T;
  etag: string;
}

/** Reads and parses `key`, or null when it does not exist. */
export async function readJson<T>(ctx: RegistryContext, key: string): Promise<Versioned<T> | null> {
  const object = await ctx.store.get(key);
  if (object === null) return null;

  let value: T;
  try {
    value = JSON.parse(object.body) as T;
  } catch (error) {
    throw new ScaloError("store-nonconforming", "Stored object is not valid JSON", {
      detail: `"${key}" could not be parsed`,
      cause: error,
    });
  }
  return { value, etag: object.etag };
}

/** Like {@link readJson}, but throws `ScaloError("not-found")` when absent. */
export async function requireJson<T>(ctx: RegistryContext, key: string): Promise<Versioned<T>> {
  const found = await readJson<T>(ctx, key);
  if (found === null) {
    throw new ScaloError("not-found", "Object not found", { detail: `"${key}" does not exist` });
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

/** Creates `key`; throws `ScaloError("cas-conflict")` when it already exists. */
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
  opts?: RetryOptions,
): Promise<Versioned<T>> {
  return withRetry(async () => {
    const current = await requireJson<T>(ctx, key);
    const next = await mutate(current.value);
    const { etag } = await putJson(ctx, key, next, { ifMatch: current.etag });
    return { value: next, etag };
  }, opts);
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
