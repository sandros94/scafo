/* Parses dotenv input, seals varsets, and describes names without exposing
   secret values. */

import { ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { getEnvironment, setEnvironmentVarset } from "../core/registry/environments.ts";
import {
  describeVarset,
  getVarsetEnvelope,
  openVarset,
  putVarset,
  sealVarset,
  type VarsetDescription,
} from "../core/registry/varsets.ts";
import type { PlainVarset } from "../core/types/registry.ts";

/** What a variable name may look like: the shell's own rule, so a process can read it. */
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The dotenv dialect, as `scafo varset set --help` states it. */
export const DOTENV_SYNTAX: string =
  "one KEY=VALUE per line; blank lines and lines starting with # are skipped; " +
  "the value is everything after the first = with surrounding spaces trimmed, " +
  "quotes and all — there is no unquoting, so write the value you mean";

export interface SetVarsetOptions {
  project: string;
  env: string;
  /** The variables, already parsed. */
  plain: PlainVarset;
  /** Key the envelope is sealed with. */
  key: CryptoKey;
}

export interface SetVarsetResult {
  /** Id the sealed envelope is stored under, and what the environment now points at. */
  id: string;
}

/** Seals the variables, stores them and points the environment at them. */
export async function setVarset(
  registry: RegistryContext,
  opts: SetVarsetOptions,
): Promise<SetVarsetResult> {
  const sealed = await sealVarset(opts.plain, opts.key);
  await putVarset(registry, opts.project, sealed);

  await setEnvironmentVarset(registry, opts.project, opts.env, sealed.id);
  return { id: sealed.id };
}

export interface ShowVarsetOptions {
  project: string;
  env: string;
  key: CryptoKey;
}

export interface ShownVarset {
  /** Id of the envelope the environment points at. */
  id: string;
  described: Record<string, VarsetDescription>;
}

/**
 * Opens the varset an environment points at and describes it.
 *
 * Throws `ScafoError("not-found")` when the environment has no varset at all.
 */
export async function showVarset(
  registry: RegistryContext,
  opts: ShowVarsetOptions,
): Promise<ShownVarset> {
  const environment = await getEnvironment(registry, opts.project, opts.env);
  const id = environment.varset;
  if (id === undefined) {
    throw new ScafoError("not-found", "Environment has no varset", {
      detail: `"${opts.project}/${opts.env}" points at no variable set`,
    });
  }

  const envelope = await getVarsetEnvelope(registry, opts.project, id);
  return { id, described: describeVarset(await openVarset(envelope, opts.key)) };
}

/** Renders varset names only; secret values are never reconstructed. */
export function formatVarset(described: Record<string, VarsetDescription>): string {
  const names = Object.keys(described).sort();
  return names
    .map((name) => {
      const entry = described[name];
      return entry?.secret === false ? `${name}=${entry.value ?? ""}` : `${name} (secret)`;
    })
    .join("\n");
}

/** Builds a varset; variables are secret unless explicitly public. */
export function toPlainVarset(
  vars: Record<string, string>,
  publicNames: readonly string[] = [],
): PlainVarset {
  const shown = new Set(publicNames);
  const unknown = [...shown].filter((name) => !(name in vars));
  if (unknown.length > 0) {
    throw new ScafoError("invalid-input", "Unknown variable marked public", {
      detail: `${unknown.map((name) => `"${name}"`).join(", ")} is not in the file being sealed`,
    });
  }

  const plain: PlainVarset = {};
  for (const [name, value] of Object.entries(vars)) {
    plain[name] = { value, secret: !shown.has(name) };
  }
  return plain;
}

/** Parses dotenv syntax, refusing malformed names and duplicates by line. */
export function parseDotenv(text: string, source: string): Record<string, string> {
  const vars: Record<string, string> = {};

  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const at = `${source}:${String(index + 1)}`;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      throw invalidLine(at, `"${trimmed}" is not KEY=VALUE`);
    }

    const name = trimmed.slice(0, separator).trim();
    if (!VAR_NAME_RE.test(name)) {
      throw invalidLine(
        at,
        `"${name}" is not a usable variable name: letters, digits and underscores, ` +
          `not starting with a digit (an "export " prefix is not stripped)`,
      );
    }
    if (name in vars) {
      throw invalidLine(
        at,
        `"${name}" is set twice, and which one wins is not for scafo to decide`,
      );
    }

    vars[name] = trimmed.slice(separator + 1).trim();
  }
  return vars;
}

function invalidLine(at: string, why: string): ScafoError {
  return new ScafoError("invalid-input", "Invalid variable file", {
    detail: `${at}: ${why}; ${DOTENV_SYNTAX}`,
  });
}
