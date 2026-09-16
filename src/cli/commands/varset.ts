/*
 * `scafo varset`: the named variable sets of a project, and what carries them.
 *
 * A varset is edited in place and reaches an application through a deploy, so
 * every subcommand that changes one says which environments point at it and
 * that the change lands at their next deploy.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import {
  deleteVarset,
  environmentsUsingVarset,
  getVarset,
  listVarsets,
  putVarset,
} from "../../core/registry/varsets.ts";
import { createRegistry } from "../_bootstrap.ts";
import { readTextFile, reportFailure } from "../_utils.ts";
import {
  describeVarsetUse,
  describeVarsetWrite,
  DOTENV_SYNTAX,
  formatVarsetVars,
  parseDotenv,
} from "../_varset.ts";

/* The bucket the registry lives in, exactly as `scafo sail` takes it. */
const bucketArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

const projectArgs: ArgsDef = {
  ...bucketArgs,
  project: { type: "string", description: "Project the varset belongs to", required: true },
};

const namedArgs: ArgsDef = {
  ...projectArgs,
  name: { type: "string", description: "Varset to act on", required: true },
};

const setArgs: ArgsDef = {
  ...namedArgs,
  file: {
    type: "string",
    description: `Variable file to store: ${DOTENV_SYNTAX}`,
    required: true,
  },
};

const showArgs: ArgsDef = {
  ...namedArgs,
  reveal: {
    type: "boolean",
    description: "Print the values too; without it only the variable names are listed",
  },
};

const set: CommandDef = defineCommand({
  meta: { name: "set", description: "Create or replace a varset from a variable file" },
  args: setArgs,
  async run({ args }): Promise<void> {
    try {
      await runSet(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const show: CommandDef = defineCommand({
  meta: { name: "show", description: "List the variables a varset holds" },
  args: showArgs,
  async run({ args }): Promise<void> {
    try {
      await runShow(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const list: CommandDef = defineCommand({
  meta: { name: "list", description: "List a project's varsets and what carries them" },
  args: projectArgs,
  async run({ args }): Promise<void> {
    try {
      await runList(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const remove: CommandDef = defineCommand({
  meta: { name: "delete", description: "Delete a varset no environment points at" },
  args: namedArgs,
  async run({ args }): Promise<void> {
    try {
      await runDelete(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const varset: CommandDef = defineCommand({
  meta: { name: "varset", description: "Manage the named variable sets of a project" },
  subCommands: { set, show, list, delete: remove },
});

async function runSet(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const name = required(flags, "name");
  const path = required(flags, "file");

  const contents = await readTextFile(path);
  if (contents === null) {
    throw new ScafoError("invalid-input", "Variable file not found", {
      detail: `"${path}" could not be read`,
    });
  }

  const registry = await openRegistry(flags);
  const stored = await putVarset(registry, project, {
    name,
    vars: parseDotenv(contents, path),
  });

  console.log(
    describeVarsetWrite({
      project,
      name,
      variables: Object.keys(stored.vars).length,
      environments: await environmentsUsingVarset(registry, project, name),
    }),
  );
}

async function runShow(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const name = required(flags, "name");

  const stored = await getVarset(await openRegistry(flags), project, name);
  const printed = formatVarsetVars(stored.vars, { reveal: flags.reveal === true });

  if (printed === "") {
    console.log(`scafo: varset "${name}" of "${project}" holds no variables`);
    return;
  }
  console.log(printed);
}

async function runList(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const registry = await openRegistry(flags);

  const names = await listVarsets(registry, project);
  if (names.length === 0) {
    console.log(`scafo: "${project}" has no varsets`);
    return;
  }

  for (const name of names) {
    const [stored, environments] = await Promise.all([
      getVarset(registry, project, name),
      environmentsUsingVarset(registry, project, name),
    ]);
    console.log(
      describeVarsetUse({
        project,
        name,
        variables: Object.keys(stored.vars).length,
        environments,
      }),
    );
  }
}

async function runDelete(flags: Record<string, unknown>): Promise<void> {
  const project = required(flags, "project");
  const name = required(flags, "name");

  await deleteVarset(await openRegistry(flags), project, name);
  console.log(`scafo: deleted varset "${name}" of "${project}"`);
}

/** The bucket these subcommands write straight into; no node holds a varset. */
async function openRegistry(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  return createRegistry(config);
}

function required(flags: Record<string, unknown>, name: string): string {
  const value = text(flags[name]);
  if (value !== undefined) return value;

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail: `--${name} must be given`,
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
