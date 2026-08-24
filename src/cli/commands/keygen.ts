/*
 * `scafo keygen`: mint the operator key that signs tokens to a node's API,
 * as a FILE in the working directory.
 *
 * The guided path is `scafo fleet add`, which mints the same key into the
 * operator's home and records where it is meant to be used, so that no later
 * command has to be told either. This command stays for what it has always been
 * good at: producing one key file, at a path of the caller's choosing, for
 * something else to place — a secret store, a configuration manager, a machine
 * that has no home to keep.
 */

import { chmod, writeFile } from "node:fs/promises";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadAgentConfig } from "../../agent/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { OperatorRole } from "../../core/registry/operators.ts";
import { assertNodeId } from "../../core/registry/paths.ts";
import { createRegistry } from "../_bootstrap.ts";
import {
  generateOperatorKey,
  type OperatorKeyFile,
  registerOperatorKey,
} from "../_operator-key.ts";
import { DEFAULT_KEY_PATH } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

export type { OperatorKeyFile };
export { DEFAULT_KEY_PATH };

const keygenArgs: ArgsDef = {
  "out": { type: "string", description: `File to write the key pair to (${DEFAULT_KEY_PATH})` },
  "id": { type: "string", description: "Id to register the key under (op-<hex>)" },
  "register": { type: "boolean", description: "Record the public half in the registry" },
  "role": {
    type: "string",
    description: "Tier to register at: admin|operator (the first key is always admin)",
  },
  "config": { type: "string", description: "Path to scafo.config.jsonc, for --register" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

export const keygen: CommandDef = defineCommand({
  meta: {
    name: "keygen",
    description:
      `Write an operator key file for the agent API ` +
      `(to set an operator up, use "scafo fleet add" instead)`,
  },
  args: keygenArgs,
  async run({ args }): Promise<void> {
    try {
      await runKeygen(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

async function runKeygen(flags: Record<string, unknown>): Promise<void> {
  const out = text(flags.out) ?? DEFAULT_KEY_PATH;
  const id = text(flags.id);
  if (id !== undefined) assertNodeId(id);

  const file = await generateOperatorKey(id);

  /* The mode is given at CREATION, because it only applies there: a key that
     briefly existed world-readable is a key that has to be assumed read. The
     `chmod` after it is what narrows a file that was ALREADY on disk, which
     `writeFile` would otherwise leave at whatever mode it had. */
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(out, 0o600);
  console.log(`scafo: wrote operator key "${file.id}" to ${out}`);

  if (flags.register !== true) {
    console.log(
      `scafo: register it with "scafo keygen --id ${file.id} --register" once configured`,
    );
    return;
  }

  const role = await register(flags, file);
  console.log(
    `scafo: registered "${file.id}" as ${role}-tier; tokens it signs are now accepted by ` +
      `every node`,
  );
}

async function register(
  flags: Record<string, unknown>,
  file: OperatorKeyFile,
): Promise<OperatorRole> {
  const config = await loadAgentConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  return registerOperatorKey(createRegistry(config), file, { ...operatorRole(flags.role) });
}

/**
 * The tier `--role` names, refused here rather than at the bucket: a misspelled
 * one would otherwise be dropped and the key filed at whatever the default is,
 * which is the kind of mistake an operator finds out about from a refusal months
 * later.
 *
 * Absent stays absent, so the registration surface keeps its own defaults.
 *
 * @internal exported for its tests.
 */
export function operatorRole(value: unknown): { role?: OperatorRole } {
  const wanted = text(value);
  if (wanted === undefined) return {};
  if (wanted === "admin" || wanted === "operator") return { role: wanted };

  throw new ScafoError("invalid-input", "Unknown operator role", {
    detail: `--role takes "admin" or "operator"; "${wanted}" is neither`,
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
