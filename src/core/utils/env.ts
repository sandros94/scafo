/* Process environment validation and `NAME=value` list parsing. */

import { ScafoError } from "../error.ts";

/**
 * Letters, digits and underscores, never beginning on a digit — what every
 * runtime and every shell agrees a variable may be named.
 *
 * Case is kept exactly as written, because the processes reading these are
 * case-sensitive: `Path` and `PATH` are two variables, and normalizing either
 * into the other would hand a process a name it never asked for.
 */
export const ENV_NAME_RE: RegExp = /^[A-Za-z_][A-Za-z\d_]*$/;

export function isEnvName(s: string): boolean {
  return ENV_NAME_RE.test(s);
}

/**
 * Names an object answers for whether or not anything was stored under them.
 * They are valid variable names for a process, but a record keyed by data cannot
 * carry one: writing it either changes the object itself or is shadowed by what
 * JavaScript already put there, and reading it back answers with that instead.
 */
export const RESERVED_ENV_NAMES: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * The whole rule a variable name has to meet, worded for a refusal. Said once
 * so every surface that carries variables — a varset, the runtime policy an
 * operator hands a node — refuses the same names in the same words.
 */
export const ENV_NAME_RULE: string =
  "letters, digits and underscores, never beginning on a digit, and never " +
  RESERVED_ENV_NAMES.map((reserved) => `"${reserved}"`).join(", ");

/**
 * Throws `ScafoError("invalid-input")` naming `what` unless `s` is a variable
 * name a process could read back out of a record keyed by data.
 *
 * `what` is how the value is described to whoever typed it, so a refusal says
 * which half of a pair was the problem.
 */
export function assertEnvName(s: unknown, what: string = "variable name"): void {
  if (typeof s === "string" && isEnvName(s) && !RESERVED_ENV_NAMES.includes(s)) return;

  throw new ScafoError("invalid-input", "Invalid environment variable", {
    detail: `${describe(s)} is not a usable ${what}: ${ENV_NAME_RULE}`,
  });
}

/**
 * Throws `ScafoError("invalid-input")` unless `value` is an object of variable
 * names to string values. `field` names the setting in the refusal.
 *
 * A value is free text and only has to BE text: a number or a boolean written
 * in a config file is refused rather than stringified, because a process reads
 * `true` and `"true"` as the same thing while the file's author clearly did not.
 * An empty object passes — whether handing over no variable at all is meaningful
 * is the caller's question.
 */
export function assertEnvVars(
  value: unknown,
  field: string,
): asserts value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScafoError("invalid-input", "Invalid environment variables", {
      detail: `${field} must be an object of variable names and values, such as {"CELLD_OTEL": "1"}`,
    });
  }

  for (const [name, entry] of Object.entries(value)) {
    assertEnvName(name, `${field} variable name`);
    if (typeof entry !== "string") {
      throw new ScafoError("invalid-input", "Invalid environment variables", {
        detail: `${field} value for "${name}" must be a string, got ${describe(entry)}`,
      });
    }
  }
}

/**
 * Reads variables written as text — a command-line flag, an environment
 * variable — into the record a process is handed: `"NAME=value,NAME2=value2"`.
 *
 * A VALUE MAY NOT CONTAIN A COMMA in this form: the separator wins, and a value
 * that needs one belongs in a config file, which carries the same record as an
 * object and has no such limit. Everything after the FIRST `=` is the value, so
 * `NAME=a=b` is `a=b`, and surrounding spacing is dropped on both halves.
 *
 * Blank entries are skipped, so a trailing comma costs nothing. A DUPLICATE NAME
 * is refused rather than resolved, as it is for labels: both "the first wins" and
 * "the last wins" are defensible, which is why neither is guessed at on the
 * operator's behalf. Text that names nothing at all is refused too — it was
 * written for a reason, and the reason was not "no variables".
 */
export function parseEnvVars(text: string, field: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const entry of text.split(",")) {
    const pair = entry.trim();
    if (pair === "") continue;

    const at = pair.indexOf("=");
    if (at < 1) {
      throw new ScafoError("invalid-input", "Invalid environment variables", {
        detail: `${field} entry "${pair}" must be written as "NAME=value"`,
      });
    }

    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    assertEnvName(name, `${field} variable name`);

    if (name in vars) {
      throw new ScafoError("invalid-input", "Invalid environment variables", {
        detail: `${field} names "${name}" twice, as "${vars[name]}" and as "${value}"`,
      });
    }
    vars[name] = value;
  }

  if (Object.keys(vars).length === 0) {
    throw new ScafoError("invalid-input", "Invalid environment variables", {
      detail: `${field} carries no variable at all; write it as "NAME=value" or leave it unset`,
    });
  }
  return vars;
}

function describe(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
