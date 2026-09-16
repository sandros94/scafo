/*
 * Varsets: the variables an environment's deploys carry, stored as plain
 * registry records named per project and edited in place.
 *
 * A varset reaches a running application only through a deploy, so changing one
 * changes nothing that is already running; {@link varsetHash} is what makes the
 * difference between what an environment carries and what it was last deployed
 * with visible.
 */

import { ScafoError } from "../error.ts";
import type { VarsetRecord } from "../types/registry.ts";
import { isEnvName } from "../utils/env.ts";
import { sha256Hex } from "../utils/hash.ts";
import { stableStringify } from "../utils/json.ts";
import { isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, deleteKey, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { listEnvironments } from "./environments.ts";
import { environmentKey, varsetKey, varsetsPrefix } from "./paths.ts";

/** The variables to store under a name; the record's timestamp is the registry's. */
export interface PutVarsetInput {
  name: string;
  vars: Record<string, string>;
}

/**
 * Keys a JSON object may not carry as a variable name. They are valid variable
 * names for a process, and reading one back off an object literal would answer
 * with something JavaScript put there rather than with what was stored.
 */
const RESERVED_VAR_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/** The rule a variable name has to meet, worded for a refusal. */
export const VAR_NAME_RULE: string =
  "letters, digits and underscores, never beginning on a digit, and never " +
  [...RESERVED_VAR_NAMES].map((reserved) => `"${reserved}"`).join(", ");

/** Whether `name` is one a varset may hold and a process could read back. */
export function isVarsetVarName(name: string): boolean {
  return isEnvName(name) && !RESERVED_VAR_NAMES.has(name);
}

/**
 * Digest of a varset's variables, independent of the order they were written in.
 * A deploy records it, so a later read says whether the environment still
 * carries what it was deployed with.
 */
export async function varsetHash(vars: Record<string, string>): Promise<string> {
  return sha256Hex(stableStringify(vars));
}

/**
 * Throws `ScafoError("invalid-varset")` naming the offending entry unless every
 * name is one a process could read back and every value is text.
 *
 * A value is refused rather than stringified: a number or a boolean written into
 * a variable file is something its author meant as text and spelled another way.
 */
export function assertVarsetVars(vars: unknown): asserts vars is Record<string, string> {
  if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
    throw new ScafoError("invalid-varset", "Invalid varset variables", {
      detail: "a varset holds an object of variable names and text values",
    });
  }

  for (const [name, value] of Object.entries(vars)) {
    if (!isVarsetVarName(name)) {
      throw new ScafoError("invalid-varset", "Invalid varset variable name", {
        detail: `"${name}" is not a usable variable name: ${VAR_NAME_RULE}`,
      });
    }
    if (typeof value !== "string") {
      throw new ScafoError("invalid-varset", "Invalid varset variable", {
        detail: `the value of "${name}" must be text, got ${typeof value}`,
      });
    }
  }
}

/**
 * Creates the varset or replaces it wholesale, stamping the moment it was
 * written. The name is a slug, and the record that comes back is the one stored.
 */
export async function putVarset(
  ctx: RegistryContext,
  project: string,
  input: PutVarsetInput,
): Promise<VarsetRecord> {
  const key = varsetKey(project, input.name);
  assertVarsetVars(input.vars);

  const record: VarsetRecord = {
    v: 1,
    name: input.name,
    vars: { ...input.vars },
    updatedAt: nowIso(ctx),
  };

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    /* Replacing is conditional on what was read, so two operators writing the
       same varset at once leave one whole record behind rather than a mix. A
       delete racing this write surfaces as `not-found`. */
    const updated = await updateJson<VarsetRecord>(ctx, key, () => record);
    return updated.value;
  }
}

/**
 * Reads one varset. Throws `not-found` when there is none, and
 * `ScafoError("invalid-varset")` for a record this build cannot read.
 */
export async function getVarset(
  ctx: RegistryContext,
  project: string,
  name: string,
): Promise<VarsetRecord> {
  const found = await requireJson<unknown>(ctx, varsetKey(project, name));
  return readVarsetRecord(found.value, project, name);
}

/** Names of every varset of `project`, sorted. */
export async function listVarsets(ctx: RegistryContext, project: string): Promise<string[]> {
  const prefix = varsetsPrefix(project);
  return namesFromKeys(await ctx.store.list(prefix), prefix).sort();
}

/** Environments of `project` whose deploys carry the varset, sorted by name. */
export async function environmentsUsingVarset(
  ctx: RegistryContext,
  project: string,
  name: string,
): Promise<string[]> {
  const environments = await listEnvironments(ctx, project);
  const carried = await Promise.all(
    environments.map(async (env) => {
      const found = await readJson<{ varset?: string }>(ctx, environmentKey(project, env));
      return found?.value.varset === name ? env : null;
    }),
  );
  return carried.filter((env): env is string => env !== null).sort();
}

/**
 * Deletes a varset once nothing carries it. Throws `not-found` when there is
 * none to delete — a misspelled name is worth saying so about — and
 * `ScafoError("reference-held")` naming the environments that still point at it.
 */
export async function deleteVarset(
  ctx: RegistryContext,
  project: string,
  name: string,
): Promise<void> {
  const key = varsetKey(project, name);
  await requireJson<unknown>(ctx, key);

  const used = await environmentsUsingVarset(ctx, project, name);
  if (used.length > 0) {
    throw new ScafoError("reference-held", "Varset is carried by an environment", {
      detail:
        `"${name}" of project "${project}" is still pointed at by ${used.join(", ")}: ` +
        `point each of them elsewhere with "scafo env varset --none" first`,
    });
  }

  await deleteKey(ctx, key);
}

/** A stored object as this build reads a varset, or a refusal naming the way back. */
function readVarsetRecord(value: unknown, project: string, name: string): VarsetRecord {
  const record = (
    typeof value === "object" && value !== null ? value : {}
  ) as Partial<VarsetRecord> & { iv?: unknown; ct?: unknown; alg?: unknown };
  const sealed = record.iv !== undefined || record.ct !== undefined || record.alg !== undefined;

  if (sealed || record.vars === undefined) {
    throw new ScafoError("invalid-varset", "Varset cannot be read", {
      detail:
        `"${name}" of project "${project}" was written by an earlier build in a sealed form ` +
        `this build does not read; "scafo varset set" recreates it from a variable file`,
    });
  }

  assertVarsetVars(record.vars);
  return record as VarsetRecord;
}
