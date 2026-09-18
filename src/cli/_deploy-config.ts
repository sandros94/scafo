/*
 * Internal: the only place a project's runtime config is edited, and it is here
 * rather than on a node.
 *
 * The artifact a node receives is byte-for-byte what the runtime is handed, so
 * an edit has to happen before the directory is packed. It happens in memory and
 * goes straight into the archive: the file in the project directory is read and
 * never written, whatever flags were given.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ScafoError } from "../core/error.ts";
import { assertEnvName } from "../core/utils/env.ts";
import { parseJsoncDocument } from "../daemon/_jsonc.ts";
import type { FileSubstitution } from "../drivers/archive/tar-zst.ts";

/** Config files a project may carry, in the order they are looked for. */
export const CONFIG_NAMES: readonly string[] = ["wrangler.jsonc", "wrangler.json"];

/** What the deploy flags ask the config to say that it does not say already. */
export interface ConfigEdit {
  /** Variables to set, overriding same-named entries of the config's own `vars`. */
  vars: Record<string, string>;
  /** Whether `--no-bundle` asked for a self-contained entry. */
  noBundle: boolean;
}

/** Whether anything at all was asked for; nothing asked means nothing is read. */
export function isEmptyEdit(edit: ConfigEdit): boolean {
  return !edit.noBundle && Object.keys(edit.vars).length === 0;
}

/**
 * Reads `KEY:VALUE` pairs as a variable record.
 *
 * SPLIT AT THE FIRST COLON, so a value may hold as many more as it likes — a URL
 * is the ordinary case — and a value may be empty, which is how a variable is
 * set to nothing rather than left unset. A pair with no colon at all is refused:
 * whether the whole text was meant as a name or as a value is not guessable.
 *
 * A NAME GIVEN TWICE is refused rather than resolved, as duplicates are wherever
 * else scafo reads variables: both "the first wins" and "the last wins" are
 * defensible, so neither is chosen on the caller's behalf.
 */
export function parseVarFlags(pairs: readonly string[], flag: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const pair of pairs) {
    const at = pair.indexOf(":");
    if (at < 0) {
      throw new ScafoError("invalid-input", "Invalid variable", {
        detail: `${flag} "${pair}" must be written as KEY:VALUE`,
      });
    }

    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    assertEnvName(name, `${flag} variable name`);
    if (Object.hasOwn(vars, name)) {
      throw new ScafoError("invalid-input", "Invalid variable", {
        detail: `${flag} names "${name}" twice, as "${vars[name]}" and as "${value}"; pass one`,
      });
    }
    vars[name] = value;
  }
  return vars;
}

/**
 * The project's runtime config with `edit` applied, ready to be packed in place
 * of the file on disk.
 *
 * The config's own `vars` are the defaults: an entry the caller named replaces
 * whatever the config holds for that name, of whatever JSON type, and every
 * other entry is kept as written. Anything the config says that the edit does
 * not mention is carried across untouched.
 */
export async function editedConfig(dir: string, edit: ConfigEdit): Promise<FileSubstitution> {
  const found = await readConfig(dir);
  const parsed = parseJsoncDocument(found.text);
  if ("error" in parsed) {
    throw new ScafoError("invalid-input", "Runtime config is not readable", {
      detail: `"${found.name}" could not be parsed as JSON with comments`,
    });
  }
  const document = parsed.value;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new ScafoError("invalid-input", "Runtime config is not an object", {
      detail: `"${found.name}" must hold an object of runtime settings`,
    });
  }

  const record = document as Record<string, unknown>;
  const declared = record.vars;
  if (
    declared !== undefined &&
    (typeof declared !== "object" || declared === null || Array.isArray(declared))
  ) {
    throw new ScafoError("invalid-input", "Runtime config variables are not an object", {
      detail:
        `"${found.name}" must hold "vars" as an object of variable names and values, such as ` +
        `{"APP_VERSION": "v1"}`,
    });
  }

  const vars = { ...(declared as Record<string, unknown> | undefined), ...edit.vars };
  const written = {
    ...record,
    ...(Object.keys(vars).length === 0 ? {} : { vars }),
    ...(edit.noBundle ? { no_bundle: true } : {}),
  };
  return { name: found.name, contents: `${JSON.stringify(written, null, 2)}\n` };
}

/** The config at the root of the project directory, with its name and its text. */
async function readConfig(dir: string): Promise<{ name: string; text: string }> {
  for (const name of CONFIG_NAMES) {
    try {
      return { name, text: await readFile(join(dir, name), "utf8") };
    } catch {}
  }

  throw new ScafoError("invalid-input", "Project carries no runtime config", {
    detail: `"${dir}" holds none of ${CONFIG_NAMES.join(", ")}, so there is nothing to edit`,
  });
}
