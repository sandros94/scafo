/* The runtime bits of the CLI: file reads, the package version, failure output. */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isScaloError } from "../core/error.ts";

/** Directory a node run by root keeps its state in. */
export const SYSTEM_STATE_DIR: string = "/var/lib/scalo";

/** Mode a file holding key material is written with: nothing but its owner may read one. */
export const SECRET_FILE_MODE: number = 0o600;

/** Mode a state directory scalo created itself is given. */
export const STATE_DIR_MODE: number = 0o700;

/**
 * Writes key material into a state directory, creating the directory when it is
 * not there, so that neither can be read by anyone but their owner.
 *
 * The mode is applied twice on purpose. `writeFile`'s own only applies to a file
 * this call created, and a private key that briefly existed readable by everyone
 * is a private key that has to be assumed read; the directory is narrowed only
 * when this call created it, because an operator who pointed scalo at a
 * directory of their own chose its mode themselves.
 */
export async function writeSecretFile(
  stateDir: string,
  path: string,
  contents: string,
): Promise<void> {
  const created = await mkdir(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  if (created !== undefined) await chmod(created, STATE_DIR_MODE);

  await writeFile(path, contents, { encoding: "utf8", mode: SECRET_FILE_MODE });
  await chmod(path, SECRET_FILE_MODE);
}

/** Reads a file as text, or null when it does not exist. */
export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Where a node keeps its state when the configuration names no directory:
 * {@link SYSTEM_STATE_DIR} for root, `$XDG_STATE_HOME/scalo` for a user who has
 * one, and `~/.local/state/scalo` otherwise.
 *
 * Always an absolute path, and never derived from the working directory — a node
 * is launched from wherever the operator happened to be standing, and an
 * identity written there would be a different identity on the next boot. A
 * relative `XDG_STATE_HOME` is ignored for the same reason.
 */
export function resolveDefaultStateDir(
  env: Record<string, string | undefined> = process.env,
): string {
  if (process.getuid?.() === 0) return SYSTEM_STATE_DIR;

  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return join(xdg, "scalo");
  return join(homedir(), ".local", "state", "scalo");
}

/**
 * Version of the installed package, read from the manifest that ships beside the
 * built CLI. Falls back to `"unknown"`: a missing manifest is not worth refusing
 * to start a node over.
 */
export async function readPackageVersion(): Promise<string> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const version = (manifest as { version?: unknown }).version;
    if (typeof version === "string") return version;
  } catch {
    /* Falls through to the placeholder below. */
  }
  return "unknown";
}

/**
 * Prints a failure the way the API would answer it — problem title, detail and
 * type — and marks the process as failed. Errors from elsewhere are printed
 * whole, stack included, because nothing else knows what they mean.
 */
export function reportFailure(error: unknown): void {
  if (isScaloError(error)) {
    const problem = error.toProblem();
    const detail = problem.detail === undefined ? "" : `: ${problem.detail}`;
    console.error(`scalo: ${problem.title}${detail} [${problem.type}]`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
