/*
 * Internal: the token guarding this node's storage surface.
 *
 * It lives beside the node's identity, in the state directory, readable by its
 * owner alone, and is generated on the first boot that finds none — or written
 * from what the operator supplied, when they chose the token themselves. Handing
 * it to the colocated process that stores through this node is the operator's
 * step — mount the file, or read it out of the state directory.
 *
 * Unlike the node's identity it is REPLACEABLE: deleting the file mints a new
 * token on the next boot and costs nothing but reconfiguring whoever presents
 * it, because no record anywhere is filed under it.
 */

import { join } from "node:path";
import { ScafoError } from "../core/error.ts";
import { STORAGE_TOKEN_BYTES } from "../daemon/storage.ts";
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

/**
 * Puts the token an operator supplied where every consumer that reads the file
 * looks for it, at the permissions a minted one gets.
 *
 * The file is the handoff and nothing else: a node admits what its configuration
 * lists, so this is what keeps a mounted file, a systemd credential and a `cat`
 * of the state directory all telling the truth about the token in use. Rotating
 * moves it, because the value written is whichever token the operator put first.
 *
 * A file that already holds this token is LEFT ALONE, down to its timestamp —
 * the boot that changed nothing must not be the boot that fails on a file
 * somebody mounted read-only.
 */
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
