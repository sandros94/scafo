/* Bootstrap: prove the store really does conditional writes, then seal the meta record. */

import { ScaloError } from "../error.ts";
import type { RegistryMeta } from "../types/registry.ts";
import type { CasStore } from "../types/store.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, readJson, requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { metaKey, probeKey } from "./paths.ts";

/**
 * Five-step conformance probe against a throwaway key: create-if-absent, the
 * duplicate create it must reject, a matched update, the stale update it must
 * reject, and a read-back of the last write. Anything else throws
 * `ScaloError("store-nonconforming")` naming the step that failed — a store that
 * silently drops preconditions would corrupt the registry.
 */
export async function probeStore(store: CasStore): Promise<void> {
  const key = probeKey(randomHex(16));
  const first = JSON.stringify({ probe: 1 });
  const second = JSON.stringify({ probe: 2 });
  const third = JSON.stringify({ probe: 3 });

  try {
    let created: { etag: string };
    try {
      created = await store.put(key, first, { ifNoneMatch: "*" });
    } catch (error) {
      throw nonconforming("1 (create with If-None-Match:* was rejected)", error);
    }

    let duplicateRejected = false;
    try {
      await store.put(key, second, { ifNoneMatch: "*" });
    } catch (error) {
      if (!isCasConflict(error)) {
        throw nonconforming("2 (duplicate create failed with the wrong error)", error);
      }
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw nonconforming("2 (duplicate create was accepted)");

    let updated: { etag: string };
    try {
      updated = await store.put(key, third, { ifMatch: created.etag });
    } catch (error) {
      throw nonconforming("3 (update with a matching If-Match was rejected)", error);
    }

    let staleRejected = false;
    try {
      await store.put(key, second, { ifMatch: created.etag });
    } catch (error) {
      if (!isCasConflict(error)) {
        throw nonconforming("4 (stale If-Match failed with the wrong error)", error);
      }
      staleRejected = true;
    }
    if (!staleRejected) throw nonconforming("4 (stale If-Match was accepted)");

    const readBack = await store.get(key);
    if (readBack === null || readBack.body !== third || readBack.etag !== updated.etag) {
      throw nonconforming("5 (read-back does not match the last write)");
    }
  } finally {
    try {
      await store.del(key);
    } catch {
      /* Best effort: a leftover probe key is inert. */
    }
  }
}

/**
 * Writes the registry meta record, probing the store first unless `skipProbe`.
 * Concurrent initializers converge: whoever loses the create adopts the record
 * that won, as long as it is a version this build understands.
 */
export async function initRegistry(
  ctx: RegistryContext,
  opts: { platformDomains: string[]; skipProbe?: boolean },
): Promise<RegistryMeta> {
  if (opts.skipProbe !== true) await probeStore(ctx.store);

  const key = metaKey();
  const meta: RegistryMeta = {
    v: 1,
    platformDomains: [...opts.platformDomains],
    createdAt: nowIso(ctx),
  };

  try {
    await createJson(ctx, key, meta);
    return meta;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<RegistryMeta>(ctx, key);
    if (existing.value.v !== 1) {
      throw new ScaloError("store-nonconforming", "Registry meta has an unknown version", {
        detail: `"${key}" is version ${String(existing.value.v)}, this build understands 1`,
        cause: error,
      });
    }
    return existing.value;
  }
}

/** The meta record, or null when the registry has not been initialized. */
export async function readMeta(ctx: RegistryContext): Promise<RegistryMeta | null> {
  const found = await readJson<RegistryMeta>(ctx, metaKey());
  return found === null ? null : found.value;
}

function nonconforming(step: string, cause?: unknown): ScaloError {
  return new ScaloError("store-nonconforming", "Store does not honour conditional writes", {
    detail: `Conformance probe failed at step ${step}`,
    cause,
  });
}

function randomHex(bytes: number): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
