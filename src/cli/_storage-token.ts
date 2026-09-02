/* Node-local storage bearer token, minted or supplied in an owner-readable state
   file. It is replaceable and not a registry identity. */

import { join } from "node:path";
import { ScafoError } from "../core/error.ts";
import { STORAGE_TOKEN_BYTES } from "../daemon/storage.ts";
import { toBase64Url } from "../core/utils/base64.ts";
import { readTextFile, writeSecretFile } from "./_utils.ts";

/** Name of the token file within the state directory. */
export const STORAGE_TOKEN_FILE: string = "storage-token";

/** Reads or mints storage token. Trims file input and refuses an empty token. */
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

/** Writes a supplied token with secret permissions; identical existing files are
    left unchanged for read-only mounts. */
export async function writeStorageToken(stateDir: string, token: string): Promise<void> {
  const path = join(stateDir, STORAGE_TOKEN_FILE);

  const text = await readTextFile(path);
  if (text?.trim() === token) return;

  await writeSecretFile(stateDir, path, `${token}\n`);
}

/**
 * What the boot says about this token, said once because the operator has to act
 * on it.
 *
 * WHICH HANDOFF IT IS DEPENDS ON WHERE THE TOKEN CAME FROM, and telling an
 * operator the wrong one sends them to configure something they already have. A
 * MINTED token exists nowhere but the file this node just wrote, so the file is
 * the distribution channel and mounting it read-only into the process that
 * terminates TLS is the instruction. A SUPPLIED one arrived through the
 * operator's own configuration — their environment, their secret manager, their
 * systemd credential — and that is already the channel; the file is written all
 * the same, so that a consumer reading a path keeps working, and saying so is
 * all this line owes them.
 *
 * `supplied` is how many tokens `storage.token` named, and `0` means the node
 * minted its own. More than one is a rotation in progress, which gets a second
 * line: this node admits them all, so the move is the operator's to make and to
 * finish.
 */
export function storageTokenNotice(opts: { path: string; supplied: number }): string[] {
  if (opts.supplied === 0) {
    return [
      `scafo: storage token at ${opts.path}; mount it read-only into the process that ` +
        `terminates TLS`,
    ];
  }

  if (opts.supplied === 1) {
    return [
      `scafo: storage token supplied by "storage.token"; ${opts.path} holds it, for whatever ` +
        `reads the file rather than the setting`,
    ];
  }

  return [
    `scafo: storage token supplied by "storage.token", which names ${String(opts.supplied)}; ` +
      `${opts.path} holds the primary, for whatever reads the file rather than the setting`,
    `scafo: this node admits every one of them; move what stores through it onto the primary, ` +
      `then contract the setting to that token alone and restart`,
  ];
}
