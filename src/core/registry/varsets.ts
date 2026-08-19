/* Varsets: AES-256-GCM sealed configuration, stored as content-addressed envelopes. */

import { ScaloError } from "../error.ts";
import type { PlainVarset, VarsetEnvelope } from "../types/registry.ts";
import { fromBase64Url, toBase64Url } from "../utils/base64.ts";
import { sha256Hex } from "../utils/hash.ts";
import { stableStringify } from "../utils/json.ts";
import { deepEqual, isCasConflict } from "./_shared.ts";
import { createJson, requireJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { varsetKey } from "./paths.ts";

/** What a caller may learn about a varset without holding the key. */
export interface VarsetDescription {
  secret: boolean;
  /** Present only for non-secret entries. */
  value?: string;
}

/** Adopts a raw 32-byte AES-256 key (or passes an existing `CryptoKey` through). */
export async function importVarsetKey(raw: Uint8Array | CryptoKey): Promise<CryptoKey> {
  if (!(raw instanceof Uint8Array)) return raw;

  if (raw.byteLength !== 32) {
    throw new ScaloError("invalid-varset", "Invalid varset key", {
      detail: `AES-256-GCM needs a 32-byte key, got ${String(raw.byteLength)}`,
    });
  }
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seals a varset and derives its id from the stored bytes.
 *
 * CAVEAT: the IV is random, so sealing identical plaintext twice yields two
 * different ids. Ids address the stored envelope, not its logical contents.
 */
export async function sealVarset(
  plain: PlainVarset,
  key: CryptoKey,
): Promise<{ id: string; envelope: VarsetEnvelope }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(stableStringify(plain));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  const envelope: VarsetEnvelope = {
    v: 1,
    alg: "A256GCM",
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ciphertext)),
  };
  return { id: await sha256Hex(stableStringify(envelope)), envelope };
}

/** Opens a sealed varset. A wrong key, tampered bytes or unknown format all throw `invalid-varset`. */
export async function openVarset(envelope: VarsetEnvelope, key: CryptoKey): Promise<PlainVarset> {
  const { v, alg } = envelope as { v: number; alg: string };
  if (v !== 1 || alg !== "A256GCM") {
    throw new ScaloError("invalid-varset", "Unsupported varset envelope", {
      detail: `expected v 1 and alg "A256GCM", got v ${String(v)} and alg "${alg}"`,
    });
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
      key,
      fromBase64Url(envelope.ct),
    );
  } catch (error) {
    throw new ScaloError("invalid-varset", "Varset could not be decrypted", {
      detail: "wrong key, or the envelope has been altered",
      cause: error,
    });
  }

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as PlainVarset;
  } catch (error) {
    throw new ScaloError("invalid-varset", "Varset plaintext is not valid JSON", { cause: error });
  }
}

/**
 * Stores a sealed varset. Storing the same id twice is idempotent when the bytes
 * match; different bytes under the same id mean a broken id and throw `immutable`.
 */
export async function putVarset(
  ctx: RegistryContext,
  project: string,
  sealed: { id: string; envelope: VarsetEnvelope },
): Promise<void> {
  const key = varsetKey(project, sealed.id);

  try {
    await createJson(ctx, key, sealed.envelope);
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<VarsetEnvelope>(ctx, key);
    if (deepEqual(existing.value, sealed.envelope)) return;
    throw new ScaloError("immutable", "Varset already exists", {
      detail: `"${sealed.id}" in project "${project}" holds different bytes`,
      cause: error,
    });
  }
}

export async function getVarsetEnvelope(
  ctx: RegistryContext,
  project: string,
  id: string,
): Promise<VarsetEnvelope> {
  const found = await requireJson<VarsetEnvelope>(ctx, varsetKey(project, id));
  return found.value;
}

/**
 * Lists what is in a varset without leaking it: secret values are omitted
 * outright rather than masked, so nothing about their length or shape leaks.
 */
export function describeVarset(plain: PlainVarset): Record<string, VarsetDescription> {
  const described: Record<string, VarsetDescription> = {};
  for (const [name, entry] of Object.entries(plain)) {
    described[name] = entry.secret ? { secret: true } : { secret: false, value: entry.value };
  }
  return described;
}
