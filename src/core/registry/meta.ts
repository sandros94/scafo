/* Bootstrap: prove the store really does conditional writes, then seal the meta record. */

import { ScafoError } from "../error.ts";
import type { RegistryMeta } from "../types/registry.ts";
import type { CasStore } from "../types/store.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, readJson, requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { metaKey, probeKey } from "./paths.ts";

/**
 * Six-step conformance probe against a throwaway key: create-if-absent, the
 * duplicate create it must reject, a matched update, the stale update it must
 * reject, a read-back of the last write, and a ranged read of it. Anything else
 * throws `ScafoError("store-nonconforming")` naming the step that failed — a
 * store that silently drops preconditions would corrupt the registry.
 *
 * THE RANGED READ IS THE LAST STEP AND IT IS NOT ABOUT THE REGISTRY. celld
 * requires `Range` of its bucket and stops a runtime whose store answers the
 * whole object instead, so a bucket that ignores the header kills a process per
 * environment at reconcile, long after the operator was told the fleet was
 * healthy. Asking here means it fails once, at `scafo sail`,
 * with the store named as the thing that is wrong.
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
      throw nonconforming(1, "create with If-None-Match:* was rejected", error);
    }

    let duplicateRejected = false;
    try {
      await store.put(key, second, { ifNoneMatch: "*" });
    } catch (error) {
      if (!isCasConflict(error)) {
        throw nonconforming(2, "duplicate create failed with the wrong error", error);
      }
      duplicateRejected = true;
    }
    if (!duplicateRejected) throw nonconforming(2, "duplicate create was accepted");

    let updated: { etag: string };
    try {
      updated = await store.put(key, third, { ifMatch: created.etag });
    } catch (error) {
      throw nonconforming(3, "update with a matching If-Match was rejected", error);
    }

    let staleRejected = false;
    try {
      await store.put(key, second, { ifMatch: created.etag });
    } catch (error) {
      if (!isCasConflict(error)) {
        throw nonconforming(4, "stale If-Match failed with the wrong error", error);
      }
      staleRejected = true;
    }
    if (!staleRejected) throw nonconforming(4, "stale If-Match was accepted");

    const readBack = await store.get(key);
    if (readBack === null || readBack.body !== third || readBack.etag !== updated.etag) {
      throw nonconforming(5, "read-back does not match the last write");
    }

    /* The middle of the body rather than its head: a store that ignores the
       header and answers the whole object gets caught by the first byte, and
       one that answers from the wrong offset by the rest. */
    const wanted = new TextEncoder().encode(third).subarray(2, 7);
    let ranged: Uint8Array | null;
    try {
      ranged = await store.getBytes(key, { range: { start: 2, end: 6 } });
    } catch (error) {
      /* The driver already recognized the whole object coming back. */
      if (error instanceof ScafoError && error.code === "store-nonconforming") {
        throw nonconforming(6, "ranged read was not honoured", error);
      }
      throw nonconforming(6, "ranged read failed", error);
    }
    if (ranged === null) throw nonconforming(6, "ranged read found no object");
    if (ranged.length !== wanted.length || ranged.some((byte, at) => byte !== wanted[at])) {
      throw nonconforming(6, "ranged read returned the wrong bytes");
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
      throw new ScafoError("store-nonconforming", "Registry meta has an unknown version", {
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

/*
 * The message says what the store cannot do, and that follows from the step:
 * 1-5 exercise the conditional write the registry is built on, 6 the ranged
 * read a cell runtime needs. An operator reads the message to know which store
 * setting to go and look at.
 */
function nonconforming(step: number, what: string, cause?: unknown): ScafoError {
  const requirement = step === 6 ? "ranged reads" : "conditional writes";
  return new ScafoError("store-nonconforming", `Store does not honour ${requirement}`, {
    detail: `Conformance probe failed at step ${String(step)} (${what})`,
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
