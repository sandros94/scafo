/*
 * Internal: the variable file `scafo varset set` reads, and every line the
 * varset commands put on the terminal.
 *
 * A varset is carried by deploys, not by running processes, so each line that
 * reports a change also says when the change lands: at the next deploy of the
 * environments that point at it.
 */

import { ScafoError } from "../core/error.ts";
import { isVarsetVarName, type VarsetUse } from "../core/registry/varsets.ts";
import { ENV_NAME_RULE } from "../core/utils/env.ts";

/** The dotenv dialect, as `scafo varset set --help` states it. */
export const DOTENV_SYNTAX: string =
  "one KEY=VALUE per line; blank lines and lines starting with # are skipped; " +
  "the value is everything after the first = with surrounding spaces trimmed, " +
  "quotes and all — there is no unquoting, so write the value you mean";

/** One varset as the commands report it: what it holds, and who carries it. */
export interface VarsetSummary {
  project: string;
  name: string;
  /** How many variables it holds. */
  variables: number;
  /** Environments of the project that point at it, sorted. */
  environments: VarsetUse[];
}

/** How a write reads on the terminal, naming when the next deploy carries it. */
export function describeVarsetWrite(summary: VarsetSummary): string {
  const held = `scafo: varset "${summary.name}" of "${summary.project}" holds ${countOf(summary.variables)}`;
  if (summary.environments.length === 0) return `${held}; no environment points at it yet`;

  return `${held}; used by ${carriers(summary)} — takes effect at their next deploy`;
}

/** One `scafo varset list` line for a record this build cannot read. */
export function describeUnreadableVarset(name: string): string {
  return (
    `${name}: unreadable, written by an earlier build; recreate it with "scafo varset set" ` +
    `and delete it once no environment points at it`
  );
}

/** One `scafo varset list` line: the name, what it holds, and who carries it. */
export function describeVarsetUse(summary: VarsetSummary): string {
  const used = summary.environments.length === 0 ? "no environment" : carriers(summary);
  return `${summary.name}: ${countOf(summary.variables)}, used by ${used}`;
}

/**
 * The environments that carry a varset, each saying whether its last deploy
 * carried what the varset holds now.
 *
 * An environment that has never deployed reads as pending too: it and one whose
 * deploy predates the current variables are the same thing to whoever is looking
 * — what is running is not this — and the same next deploy settles both.
 */
function carriers(summary: VarsetSummary): string {
  return summary.environments
    .map((use) => `${use.env} (${use.carried === "current" ? "deployed" : "pending deploy"})`)
    .join(", ");
}

/**
 * The variables of a varset, one per line and sorted by name. Values are printed
 * only when `reveal` asks for them: this output is read over shoulders, pasted
 * into issues and captured by CI logs, and the names alone answer what is set.
 */
export function formatVarsetVars(
  vars: Record<string, string>,
  opts?: { reveal?: boolean },
): string {
  const reveal = opts?.reveal === true;
  return Object.keys(vars)
    .sort()
    .map((name) => (reveal ? `${name}=${vars[name] ?? ""}` : name))
    .join("\n");
}

/** How pointing an environment at a varset, or at none, reads on the terminal. */
export function describeEnvironmentVarset(
  target: { project: string; env: string },
  name: string | null,
): string {
  const carries = name === null ? "carries no varset" : `carries varset "${name}"`;
  return (
    `scafo: "${target.project}/${target.env}" ${carries}; it takes effect at the ` +
    `environment's next deploy`
  );
}

/** The two ways `scafo env varset` can be told what to do. */
export interface VarsetFlags {
  /** Name of the varset, or undefined when `--name` was not given. */
  name: string | undefined;
  /** Whether `--none` was given. */
  none: boolean;
}

/**
 * The varset an invocation states: the name of `--name`, or null for `--none`.
 *
 * Exactly one of them, and `ScafoError("invalid-input")` otherwise. They are
 * opposite intentions, so a command carrying BOTH says nothing about which was
 * meant; and NEITHER is refused rather than read as "none", because an
 * accidental `scafo env varset` that dropped a varset would change what the
 * environment's next deploy carries.
 */
export function readVarsetFlags(flags: VarsetFlags): string | null {
  if (flags.name !== undefined && flags.none) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail: `--name "${flags.name}" and --none ask for opposite things; pass one of them`,
    });
  }
  if (flags.none) return null;
  if (flags.name !== undefined) return flags.name;

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail:
      `pass --name <varset> to say which variables the environment's deploys carry, ` +
      `or --none to stop it carrying any`,
  });
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
    if (!isVarsetVarName(name)) {
      throw invalidLine(
        at,
        `"${name}" is not a usable variable name: ${ENV_NAME_RULE} ` +
          `(an "export " prefix is not stripped)`,
      );
    }
    /* An own-property check: a plain object answers `in` for the names it
       inherits, which would report a first `constructor=` line as a repeat. */
    if (Object.hasOwn(vars, name)) {
      throw invalidLine(
        at,
        `"${name}" is set twice, and which one wins is not for scafo to decide`,
      );
    }

    vars[name] = trimmed.slice(separator + 1).trim();
  }
  return vars;
}

function countOf(variables: number): string {
  return `${String(variables)} variable${variables === 1 ? "" : "s"}`;
}

function invalidLine(at: string, why: string): ScafoError {
  return new ScafoError("invalid-input", "Invalid variable file", {
    detail: `${at}: ${why}; ${DOTENV_SYNTAX}`,
  });
}
