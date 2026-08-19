/* The runtime bits of the CLI: file reads, the package version, failure output. */

import { readFile } from "node:fs/promises";
import { isScaloError } from "../core/error.ts";

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
