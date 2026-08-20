/*
 * Internal: the key file that opens an installation's sealed variable sets.
 *
 * One AES-256 key protects every varset of an installation. Operators keep it in
 * a file — dropped there by a secret manager, printed by `openssl rand`, pasted
 * out of a password store — so all three spellings such a file arrives in are
 * accepted, and anything else is refused rather than guessed at.
 */

import { readFile } from "node:fs/promises";
import { ScafoError } from "../core/error.ts";
import { importVarsetKey } from "../core/registry/varsets.ts";
import { fromBase64Url } from "../core/utils/base64.ts";

/** Length of an AES-256 key, in bytes. */
export const VARSET_KEY_BYTES: number = 32;

/** The 64 hex characters a 32-byte key is written as, with nothing else around them. */
const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

/** 32 bytes of base64url: 43 characters, plus the one `=` a padded encoder adds. */
const B64URL_KEY_RE = /^[A-Za-z0-9_-]{43}=?$/;

/** What the three accepted spellings are, for anything that has to name them. */
export const VARSET_KEY_FORMS: string =
  `32 raw bytes, ${String(VARSET_KEY_BYTES * 2)} hex characters, ` +
  `or 43-44 base64url characters (trailing whitespace is ignored)`;

/** Reads a varset key file and imports what it holds. */
export async function readVarsetKeyFile(path: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new ScafoError("invalid-input", "Varset key file could not be read", {
      detail: `"${path}" could not be opened; it must hold ${VARSET_KEY_FORMS}`,
      cause: error,
    });
  }
  return importVarsetKey(decodeVarsetKey(bytes, path));
}

/**
 * The 32 key bytes a key file holds, whichever of the three forms it is in.
 *
 * The text forms are recognized first, because a file of hex or base64url is
 * never 32 bytes long, and a 32-byte raw key is never 43 or 64 characters of
 * either alphabet. `source` names the file in the failure.
 *
 * Throws `ScafoError("invalid-input")` for anything else, including a text
 * encoding of the wrong length — a truncated key must not be padded into a
 * usable one.
 */
export function decodeVarsetKey(bytes: Uint8Array, source: string): Uint8Array {
  const text = new TextDecoder().decode(bytes).trim();

  if (HEX_KEY_RE.test(text)) return fromHex(text);
  if (B64URL_KEY_RE.test(text)) {
    const decoded = fromBase64Url(text.replace(/=$/, ""));
    if (decoded.byteLength === VARSET_KEY_BYTES) return decoded;
  }
  if (bytes.byteLength === VARSET_KEY_BYTES) {
    /*
     * 32 bytes of nothing but hex digits is `openssl rand -hex 16`: half a key,
     * written out. Taking those characters as key material would work — and
     * would quietly protect an installation with 16 bytes of entropy — so it is
     * refused instead. No other 32-byte file is second-guessed.
     */
    if (/^[0-9a-fA-F]{32}$/.test(text)) {
      throw notAKey(
        source,
        `it holds 32 hex characters, which is a 16-byte key; AES-256 needs ${String(VARSET_KEY_BYTES * 2)}`,
      );
    }
    return bytes;
  }

  throw notAKey(source, `it holds ${String(bytes.byteLength)} bytes`);
}

function notAKey(source: string, why: string): ScafoError {
  return new ScafoError("invalid-input", "Varset key file is not a key", {
    detail: `"${source}" is none of the accepted forms: ${why}, and a key is ${VARSET_KEY_FORMS}`,
  });
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
