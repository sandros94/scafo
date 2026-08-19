/* `scalo keygen`: mint the operator key that signs tokens to a node's API. */

import { chmod, writeFile } from "node:fs/promises";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { loadAgentConfig } from "../../agent/config.ts";
import { assertNodeId } from "../../core/registry/paths.ts";
import { registerNode } from "../../core/registry/nodes.ts";
import type { NodeRecord } from "../../core/types/registry.ts";
import { createRegistry } from "../_bootstrap.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/** Where the key is written when the caller names no file. */
export const DEFAULT_KEY_PATH: string = "scalo-operator.json";

/**
 * The key file, as written and as `scalo deploy` reads it back.
 *
 * Both halves live in one file: the public half so `--register` can be re-run
 * from it, the private half because it is what signs. The file is created
 * readable by its owner alone and must never be committed or copied to a node.
 */
export interface OperatorKeyFile {
  /** Id the key is registered under, and the `kid` its tokens carry. */
  id: string;
  privateKey: JWK_OKP_Private<"EdDSA">;
  publicKey: JWK_OKP_Public<"EdDSA">;
}

const keygenArgs: ArgsDef = {
  "out": { type: "string", description: `File to write the key pair to (${DEFAULT_KEY_PATH})` },
  "id": { type: "string", description: "Id to register the key under (op-<hex>)" },
  "register": { type: "boolean", description: "Record the public half in the registry" },
  "config": { type: "string", description: "Path to scalo.config.jsonc, for --register" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

export const keygen: CommandDef = defineCommand({
  meta: { name: "keygen", description: "Generate an operator key for the agent API" },
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
  const id = text(flags.id) ?? randomOperatorId();
  assertNodeId(id);

  const { privateKey, publicKey } = await generateJWK("EdDSA", { kid: id });
  const file: OperatorKeyFile = { id, privateKey, publicKey };

  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  /* Written first, then narrowed: a key that briefly existed world-readable is
     a key that has to be assumed read. */
  await chmod(out, 0o600);
  console.log(`scalo: wrote operator key "${id}" to ${out}`);

  if (flags.register !== true) {
    console.log(`scalo: register it with "scalo keygen --id ${id} --register" once configured`);
    return;
  }

  await register(flags, file);
  console.log(`scalo: registered "${id}"; tokens it signs are now accepted by every node`);
}

/**
 * Records the public half in the registry.
 *
 * Operators reuse the node record: an agent verifies a bearer token against the
 * key filed under the token's `kid`, and does not care whether that id belongs
 * to a machine or a person. The address fields are a placeholder, because
 * nothing ever connects to an operator.
 */
async function register(flags: Record<string, unknown>, file: OperatorKeyFile): Promise<void> {
  const config = await loadAgentConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  const record: NodeRecord = {
    v: 1,
    id: file.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: file.publicKey.x },
    addresses: { internal: "operator", agentPort: 0 },
  };
  await registerNode(createRegistry(config), record);
}

function randomOperatorId(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(4))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `op-${hex}`;
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
