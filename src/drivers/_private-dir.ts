/* Directories a driver keeps on a node, readable by nobody but their owner. */

import { chmod, mkdir } from "node:fs/promises";

/** Mode a directory scafo creates for its own state is given. */
export const PRIVATE_DIR_MODE: number = 0o700;

/** Mode a file scafo writes inside one of those directories is given. */
export const PRIVATE_FILE_MODE: number = 0o600;

/**
 * Creates `path` and every missing directory above it, private to its owner.
 *
 * The mode is given to `mkdir` because that is where it applies: a directory
 * only briefly world-readable is one that has to be assumed read. `mkdir`
 * narrows that mode by the umask and applies it ONLY to the directories it
 * creates, so two things follow. `0o700` carries no group or other bit a umask
 * could take, which is what makes every level this creates already private
 * whatever the umask is; and a path that was ALREADY on disk keeps whatever mode
 * it had, which is what the `chmod` on the leaf is for.
 *
 * Only the leaf, because the levels above it may be the operator's: a state
 * directory a package manager, a systemd unit or a bind mount put there is not
 * this node's to narrow.
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(path, PRIVATE_DIR_MODE);
}
