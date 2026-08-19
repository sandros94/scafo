/*
 * Internal: the identity a node keeps across restarts.
 *
 * A node is its keypair. The public half is what the registry files under the
 * node's id and what every other node verifies its tokens against; the private
 * half is what signs them. Both live in one file inside the state directory,
 * readable by its owner alone.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { ScaloError } from "../core/error.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import { writeSecretFile } from "./_utils.ts";

/** Name of the state file within the state directory. */
export const NODE_STATE_FILE: string = "node.json";

/** Who this node is, as persisted between boots. */
export interface NodeState {
  /** Id the node registers under, and the `kid` of every token it signs. */
  id: string;
  privateKey: JWK_OKP_Private<"EdDSA">;
  publicKey: JWK_OKP_Public<"EdDSA">;
}

export interface NodeStateOptions {
  /**
   * Id the configuration pins this node to. A pinned id that differs from the
   * stored one replaces the identity: a new keypair is generated and written
   * under it, because the id and the key that speaks for it are one thing.
   */
  id?: string;
  /** Where the identity change is reported. Defaults to `console.log`. */
  log?: (message: string) => void;
}

/**
 * Reads this node's identity, generating and persisting one on first boot.
 *
 * Throws `ScaloError("invalid-input")` when the file exists but cannot be read
 * as an identity. A corrupted state file is never silently replaced: doing so
 * would hand the node a new keypair while the registry still holds the old
 * public key, and every token it signed would start being rejected for reasons
 * nothing on the node explains. An operator deletes it deliberately, knowing the
 * node re-registers under a new key.
 */
export async function loadOrCreateNodeState(
  stateDir: string,
  opts?: NodeStateOptions,
): Promise<NodeState> {
  const path = join(stateDir, NODE_STATE_FILE);
  const pinned = opts?.id;
  if (pinned !== undefined) assertNodeId(pinned);

  const stored = await readNodeState(path);
  if (stored !== null) {
    if (pinned === undefined || pinned === stored.id) return stored;

    (opts?.log ?? console.log)(
      `scalo: node id "${stored.id}" in ${path} was replaced by the configured "${pinned}"; ` +
        `a new key was generated, so this node must be registered again`,
    );
  }

  const state = await generateNodeState(pinned ?? randomNodeId());
  await writeNodeState(stateDir, path, state);
  return state;
}

/** A fresh identity, unwritten. Mirrors the key `scalo keygen` mints for an operator. */
async function generateNodeState(id: string): Promise<NodeState> {
  assertNodeId(id);
  const { privateKey, publicKey } = await generateJWK("EdDSA", { kid: id });
  return { id, privateKey, publicKey };
}

async function writeNodeState(stateDir: string, path: string, state: NodeState): Promise<void> {
  await writeSecretFile(stateDir, path, `${JSON.stringify(state, null, 2)}\n`);
}

async function readNodeState(path: string): Promise<NodeState | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw unreadable(path, "it does not hold valid JSON", error);
  }

  const state = parsed as Partial<NodeState> | null;
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw unreadable(path, "it does not hold a JSON object");
  }
  if (typeof state.id !== "string") {
    throw unreadable(path, `"id" is missing or is not a string`);
  }
  assertNodeId(state.id);
  assertEd25519(path, state.privateKey, "privateKey");
  assertEd25519(path, state.publicKey, "publicKey");

  return { id: state.id, privateKey: state.privateKey, publicKey: state.publicKey };
}

/** Both halves must be Ed25519 JWKs, and the private one must carry its `d`. */
function assertEd25519(
  path: string,
  key: unknown,
  field: "privateKey" | "publicKey",
): asserts key is JWK_OKP_Private<"EdDSA"> & JWK_OKP_Public<"EdDSA"> {
  const jwk = key as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown } | null;

  if (typeof jwk !== "object" || jwk === null || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw unreadable(path, `"${field}" is not an Ed25519 JWK (kty "OKP", crv "Ed25519")`);
  }
  if (typeof jwk.x !== "string") {
    throw unreadable(path, `"${field}" carries no "x"`);
  }
  if (field === "privateKey" && typeof jwk.d !== "string") {
    throw unreadable(path, `"privateKey" carries no "d", so this node cannot sign with it`);
  }
}

function unreadable(path: string, why: string, cause?: unknown): ScaloError {
  return new ScaloError("invalid-input", "Node state file is unusable", {
    detail:
      `"${path}" holds this node's identity but ${why}; delete the file to have the node ` +
      `generate a new one, knowing it then registers under a new key and every token ` +
      `signed by the old one stops verifying`,
    ...(cause === undefined ? {} : { cause }),
  });
}

function randomNodeId(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(4))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `node-${hex}`;
}
