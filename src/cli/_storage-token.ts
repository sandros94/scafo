/*
 * Internal: the token guarding this node's storage surface.
 *
 * It lives beside the node's identity, in the state directory, readable by its
 * owner alone, and is generated on the first boot that finds none. Handing it to
 * the colocated process that stores through this node is the operator's step —
 * mount the file, or read it out of the state directory.
 *
 * Unlike the node's identity it is REPLACEABLE: deleting the file mints a new
 * token on the next boot and costs nothing but reconfiguring whoever presents
 * it, because no record anywhere is filed under it.
 */

import { join } from "node:path";
import { ScafoError } from "../core/error.ts";
import { STORAGE_TOKEN_BYTES } from "../agent/storage.ts";
import { toBase64Url } from "../core/utils/base64.ts";
import { readTextFile, writeSecretFile } from "./_utils.ts";

/** Name of the token file within the state directory. */
export const STORAGE_TOKEN_FILE: string = "storage-token";

/**
 * Reads this node's storage token, writing a fresh one on the first boot that
 * has none.
 *
 * The file is read as text and TRIMMED, so a token an operator wrote with a
 * trailing newline is the token the node compares against.
 *
 * Throws `ScafoError("invalid-input")` when the file is there but holds nothing:
 * an empty token would guard the surface with the empty string, and the check
 * would then be one a caller presenting anything at all could pass.
 */
export async function loadOrCreateStorageToken(stateDir: string): Promise<string> {
  const path = join(stateDir, STORAGE_TOKEN_FILE);

  const text = await readTextFile(path);
  if (text !== null) {
    const stored = text.trim();
    if (stored === "") {
      throw new ScafoError("invalid-input", "Storage token file is unusable", {
        detail:
          `"${path}" guards this node's storage surface but holds no token; delete the file ` +
          `to have the node write a new one, then hand that one to whatever stores through it`,
      });
    }
    return stored;
  }

  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(STORAGE_TOKEN_BYTES)));
  await writeSecretFile(stateDir, path, `${token}\n`);
  return token;
}
