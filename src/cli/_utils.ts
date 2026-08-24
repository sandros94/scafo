/* The runtime bits of the CLI: file reads, the package version, failure output. */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandDef } from "citty";
import { isScafoError } from "../core/error.ts";

/** Directory a node run by root keeps its state in. */
export const SYSTEM_STATE_DIR: string = "/var/lib/scafo";

/** Mode a file holding key material is written with: nothing but its owner may read one. */
export const SECRET_FILE_MODE: number = 0o600;

/** Mode a state directory scafo created itself is given. */
export const STATE_DIR_MODE: number = 0o700;

/**
 * Writes key material into a state directory, creating the directory when it is
 * not there, so that neither can be read by anyone but their owner.
 *
 * The mode is applied twice on purpose. `writeFile`'s own only applies to a file
 * this call created, and a private key that briefly existed readable by everyone
 * is a private key that has to be assumed read; the directory is narrowed only
 * when this call created it, because an operator who pointed scafo at a
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
 * {@link SYSTEM_STATE_DIR} for root, `$XDG_STATE_HOME/scafo` for a user who has
 * one, and `~/.local/state/scafo` otherwise.
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
  if (xdg !== undefined && xdg !== "" && isAbsolute(xdg)) return join(xdg, "scafo");
  return join(homedir(), ".local", "state", "scafo");
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

/** An old command name kept alive, and what it is now called. */
export interface DeprecatedAlias {
  /** The old name, as it is still typed. */
  name: string;
  /** The command line to run instead, exactly as an operator would type it. */
  replacedBy: string;
  /** What it delegates to. Flags, subcommands and behaviour are taken wholesale. */
  command: CommandDef;
  /** Where the notice goes. Defaults to stderr. */
  warn?: (line: string) => void;
}

/**
 * An old command name, kept working and kept out of the way.
 *
 * HIDDEN, WORKING, AND NOISY EXACTLY ONCE. Hidden because help is what the
 * surface IS, and an old name listed there teaches it to somebody who has never
 * typed it; working because a rename is not a reason to break a script that is
 * already deployed; noisy once because the person running it has to learn the
 * new name before the old one goes.
 *
 * Delegation is a spread rather than a wrapper: the alias cannot drift from what
 * it aliases, because it IS what it aliases, with a different `meta` and one
 * line said first.
 *
 * These live only until the surface goes public, and are then deleted.
 */
export function deprecatedAlias(spec: DeprecatedAlias): CommandDef {
  const say =
    spec.warn ??
    ((line: string): void => {
      console.warn(line);
    });

  return {
    ...spec.command,
    meta: {
      name: spec.name,
      description: `Deprecated: renamed to "${spec.replacedBy}"`,
      hidden: true,
    },
    setup: async (context): Promise<void> => {
      say(
        `scafo: "${spec.name}" has been renamed to "${spec.replacedBy}" and goes away at ` +
          `launch; it still works, but run "${spec.replacedBy}" from now on`,
      );
      await spec.command.setup?.(context);
    },
  };
}

/**
 * Prints a failure the way the API would answer it — problem title, detail and
 * type — and marks the process as failed.
 *
 * A FAILURE SCAFO NEVER WRAPPED IS PRINTED IN THE SAME SHAPE, never as a raw
 * stack. An `EACCES` on a state directory, a refused connection, a full disk:
 * these are ordinary ways for a command to end, and a Node stack trace in front
 * of one tells an operator that scafo crashed rather than that a directory is
 * not writable. So it becomes one line saying what was raised and what that says
 * it was caused by — the message is where the useful specifics of a runtime
 * failure are (`EACCES: permission denied, open '<path>'` names the syscall and
 * the path), and the frames above it name only scafo's own call stack, which is
 * the one thing the operator cannot act on.
 */
export function reportFailure(error: unknown): void {
  if (isScafoError(error)) {
    const problem = error.toProblem();
    const detail = problem.detail === undefined ? "" : `: ${problem.detail}`;
    console.error(`scafo: ${problem.title}${detail} [${problem.type}]`);
  } else {
    console.error(`scafo: unexpected failure: ${describeUnexpected(error)}`);
  }
  process.exitCode = 1;
}

/** Causes followed past the error itself; deep enough for a wrapped fetch failure. */
const MAX_CAUSE_DEPTH = 4;

/**
 * One line for a failure scafo never wrapped: what it says, then what each of
 * its causes says.
 *
 * The chain is what carries the reason in the common case — `fetch` reports
 * `TypeError: fetch failed` and puts the refused connection in its `cause`, so a
 * renderer that stopped at the top would print nothing an operator could act on.
 */
function describeUnexpected(error: unknown): string {
  const said: string[] = [];

  let current: unknown = error;
  while (current !== undefined && current !== null && said.length <= MAX_CAUSE_DEPTH) {
    said.push(oneError(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return said.join(", caused by ");
}

/**
 * One error as a line. The class name is kept only when it says something — a
 * `TypeError` is worth naming, and the bare `Error` every `fs` failure carries
 * is not.
 */
function oneError(value: unknown): string {
  if (!(value instanceof Error)) return String(value);
  return value.name === "Error" || value.name === ""
    ? value.message
    : `${value.name}: ${value.message}`;
}
