/* `scafo varset`: seal an environment's variables into the registry, and list what it carries. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { createRegistry } from "../_bootstrap.ts";
import { flagList } from "../_flags.ts";
import { readTextFile, reportFailure } from "../_utils.ts";
import { readVarsetKeyFile, VARSET_KEY_FORMS } from "../_varset-key.ts";
import {
  DOTENV_SYNTAX,
  formatVarset,
  parseDotenv,
  setVarset,
  showVarset,
  toPlainVarset,
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

const targetArgs: ArgsDef = {
  "project": { type: "string", description: "Project the environment belongs to", required: true },
  "env": { type: "string", description: "Environment to seal the variables for", required: true },
  "key-file": {
    type: "string",
    description: `File holding the varset key (${VARSET_KEY_FORMS})`,
  },
};

const setArgs: ArgsDef = {
  ...targetArgs,
  ...bucketArgs,
  file: {
    type: "string",
    description: `Variable file to seal: ${DOTENV_SYNTAX}`,
    required: true,
  },
  /* Comma-separated rather than repeated: the parser keeps only the last
     occurrence of a repeated flag, and a `--public` that read one would seal the
     variables an operator asked to publish and never say it had. */
  public: {
    type: "string",
    description:
      "Variable to store in the clear; comma-separated for several. Everything else is secret",
  },
};

const showArgs: ArgsDef = { ...targetArgs, ...bucketArgs };

const set: CommandDef = defineCommand({
  meta: { name: "set", description: "Seal a variable file and point an environment at it" },
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
  meta: { name: "show", description: "List the variables an environment carries" },
  args: showArgs,
  async run({ args }): Promise<void> {
    try {
      await runShow(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const varset: CommandDef = defineCommand({
  meta: { name: "varset", description: "Manage the variables an environment is configured with" },
  subCommands: { set, show },
});

async function runSet(flags: Record<string, unknown>): Promise<void> {
  const target = await resolveTarget(flags);
  const path = required(flags, "file");

  const contents = await readTextFile(path);
  if (contents === null) {
    throw new ScafoError("invalid-input", "Variable file not found", {
      detail: `"${path}" could not be read`,
    });
  }

  const plain = toPlainVarset(parseDotenv(contents, path), flagList(flags.public));
  const result = await setVarset(target.registry, {
    project: target.project,
    env: target.env,
    plain,
    key: target.key,
  });

  const count = Object.keys(plain).length;
  console.log(
    `scafo: sealed ${String(count)} variable${count === 1 ? "" : "s"} as varset "${result.id}" ` +
      `for "${target.project}/${target.env}"`,
  );
}

async function runShow(flags: Record<string, unknown>): Promise<void> {
  const target = await resolveTarget(flags);
  const shown = await showVarset(target.registry, {
    project: target.project,
    env: target.env,
    key: target.key,
  });

  /* Secret values are never printed, key in hand or not: this output is read
     over shoulders, pasted into issues and captured by CI logs. */
  console.log(`scafo: "${target.project}/${target.env}" uses varset "${shown.id}"`);
  const listed = formatVarset(shown.described);
  if (listed !== "") console.log(listed);
}

interface Target {
  registry: RegistryContext;
  project: string;
  env: string;
  key: CryptoKey;
}

/** Everything both subcommands need: the bucket, the environment and the key. */
async function resolveTarget(flags: Record<string, unknown>): Promise<Target> {
  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  const keyFile = text(flags["key-file"]) ?? config.varsets?.keyFile;
  if (keyFile === undefined) {
    throw new ScafoError("invalid-input", "Missing required configuration", {
      detail:
        `"varsets.keyFile" has no value: pass --key-file, set SCAFO_VARSET_KEY_FILE in the ` +
        `environment, or set it in the config file`,
    });
  }

  return {
    registry: createRegistry(config),
    project: required(flags, "project"),
    env: required(flags, "env"),
    key: await readVarsetKeyFile(keyFile),
  };
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
