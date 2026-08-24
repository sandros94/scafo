/*
 * Internal: the operator keypair, and the two files it is written in.
 *
 * The KEY FILE is what `scafo keygen` has always written: an id and both halves
 * of an Ed25519 pair, and nothing about where it is meant to be used. The
 * PORTABLE FILE wraps one together with the endpoints it reaches, so a single
 * self-contained value carries a whole fleet to a machine that has never seen
 * this installation — a CI secret, a password-store entry, a pipe.
 *
 * The two are told apart by what they carry rather than guessed at: a portable
 * file states its `kind` and its version, a key file states neither.
 */

import { readFile } from "node:fs/promises";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { registerNode } from "../core/registry/nodes.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import { fromBase64 } from "../core/utils/base64.ts";

/**
 * The key file, as `scafo keygen` writes it and as every operator command reads
 * it back.
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

/** What a portable operator file says it is. */
export const PORTABLE_KIND: string = "scafo-operator";

/** Version of the portable format written today. */
export const PORTABLE_VERSION: number = 1;

/** Prefix that makes a value an INLINE portable file rather than a path to one. */
export const INLINE_PREFIX: string = "base64:";

/**
 * Everything needed to operate one fleet from a bare machine: who to be, and
 * where to go.
 *
 * `fleet` is the name it was exported under, and is only a suggestion — the
 * machine importing it may file it under any name it likes.
 */
export interface PortableOperator {
  v: number;
  kind: string;
  fleet?: string;
  endpoints: string[];
  key: OperatorKeyFile;
}

/** An operator key, and whatever the document it came in also said. */
export interface OperatorKeySource {
  key: OperatorKeyFile;
  /** Endpoints the document carried; empty for a plain key file. */
  endpoints: string[];
  /** Fleet name the document suggested, when it carried one. */
  fleet?: string;
  /** What is named in a failure: the path, or the inline form. */
  from: string;
}

/**
 * Reads an operator key from one of the three forms a command accepts: a path to
 * a key file, a path to a portable file, or an inline `base64:` value holding a
 * portable file.
 *
 * THE PREFIX DECIDES, and nothing sniffs. A value carrying {@link INLINE_PREFIX}
 * is decoded and never opened; anything else is opened and never decoded, so a
 * path that is not there fails as a path however much its name looks like
 * base64. Guessing between the two would read a mistyped filename as key
 * material.
 *
 * Throws `ScafoError("invalid-input")` for a value that is neither.
 */
export async function loadOperatorKeySource(spec: string): Promise<OperatorKeySource> {
  if (spec.startsWith(INLINE_PREFIX)) {
    const encoded = spec.slice(INLINE_PREFIX.length);
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(fromBase64(encoded));
    } catch (error) {
      throw new ScafoError("invalid-input", "Inline operator key is not base64", {
        detail:
          `the value after "${INLINE_PREFIX}" is not base64; it must hold a portable operator ` +
          `file, as "scafo fleet export" prints one`,
        cause: error,
      });
    }
    return readOperatorDocument(decoded, INLINE_PREFIX);
  }

  let text: string;
  try {
    text = await readFile(spec, "utf8");
  } catch (error) {
    throw new ScafoError("invalid-input", "Operator key could not be read", {
      detail:
        `"${spec}" could not be opened; it must be a key file written by "scafo keygen", ` +
        `a portable file written by "scafo fleet export", or an inline value prefixed ` +
        `with "${INLINE_PREFIX}"`,
      cause: error,
    });
  }
  return readOperatorDocument(text, spec);
}

/**
 * Reads either known document out of `text`, telling them apart by the `kind` a
 * portable file states and a key file does not.
 *
 * Throws `ScafoError("invalid-input")` for anything else. `source` names it.
 */
export function readOperatorDocument(text: string, source: string): OperatorKeySource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw notAnOperatorFile(source, "it does not hold valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw notAnOperatorFile(source, "it does not hold a JSON object");
  }

  const document = parsed as Record<string, unknown>;
  if (document.kind === undefined && document.v === undefined) {
    return { key: readKeyFile(document, source), endpoints: [], from: source };
  }
  if (document.kind !== PORTABLE_KIND) {
    throw notAnOperatorFile(source, `its "kind" is not "${PORTABLE_KIND}"`);
  }
  if (document.v !== PORTABLE_VERSION) {
    throw notAnOperatorFile(
      source,
      `it is version ${JSON.stringify(document.v)} and this scafo writes version ` +
        `${String(PORTABLE_VERSION)}`,
    );
  }

  const endpoints = readEndpoints(document.endpoints, source);
  const key = readKeyFile(document.key, source);
  const fleet = document.fleet;
  if (fleet !== undefined && typeof fleet !== "string") {
    throw notAnOperatorFile(source, `its "fleet" is not a name`);
  }

  return { key, endpoints, ...(fleet === undefined ? {} : { fleet }), from: source };
}

/** A fresh operator keypair, unwritten. */
export async function generateOperatorKey(id?: string): Promise<OperatorKeyFile> {
  const wanted = id ?? randomOperatorId();
  assertNodeId(wanted);

  const { privateKey, publicKey } = await generateJWK("EdDSA", { kid: wanted });
  return { id: wanted, privateKey, publicKey };
}

/** The id a key takes when the operator names none. */
export function randomOperatorId(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(4))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `op-${hex}`;
}

/** A portable file as text, the way it is printed and written. */
export function formatPortable(portable: PortableOperator): string {
  return JSON.stringify(portable, null, 2);
}

/**
 * Records the public half in the registry, which is what makes a node accept the
 * tokens this key signs.
 *
 * Operators reuse the node record: an agent verifies a bearer token against the
 * key filed under the token's `kid`, and does not care whether that id belongs
 * to a machine or a person. The address fields are a placeholder, because
 * nothing ever connects to an operator.
 */
export async function registerOperatorKey(
  registry: RegistryContext,
  key: OperatorKeyFile,
): Promise<void> {
  await registerNode(registry, {
    v: 1,
    id: key.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: key.publicKey.x },
    addresses: { internal: "operator", agentPort: 0 },
  });
}

/* ---------------------------------------------------------------- internals */

function readEndpoints(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw notAnOperatorFile(source, `its "endpoints" is not a list of agent URLs`);
  }
  return value as string[];
}

function readKeyFile(value: unknown, source: string): OperatorKeyFile {
  const file = value as Partial<OperatorKeyFile> | null;
  if (typeof file !== "object" || file === null || Array.isArray(file)) {
    throw notAnOperatorFile(source, "it carries no operator key");
  }
  if (typeof file.id !== "string") {
    throw notAnOperatorFile(source, `its key carries no "id"`);
  }
  assertEd25519(source, file.privateKey, "privateKey");
  assertEd25519(source, file.publicKey, "publicKey");

  return { id: file.id, privateKey: file.privateKey, publicKey: file.publicKey };
}

/** Both halves must be Ed25519 JWKs, and the private one must carry its `d`. */
function assertEd25519(
  source: string,
  key: unknown,
  field: "privateKey" | "publicKey",
): asserts key is JWK_OKP_Private<"EdDSA"> & JWK_OKP_Public<"EdDSA"> {
  const jwk = key as { kty?: unknown; crv?: unknown; x?: unknown; d?: unknown } | null;

  if (typeof jwk !== "object" || jwk === null || jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw notAnOperatorFile(source, `its "${field}" is not an Ed25519 JWK`);
  }
  if (typeof jwk.x !== "string") {
    throw notAnOperatorFile(source, `its "${field}" carries no "x"`);
  }
  if (field === "privateKey" && typeof jwk.d !== "string") {
    throw notAnOperatorFile(source, `its "privateKey" carries no "d", so nothing could sign`);
  }
}

function notAnOperatorFile(source: string, why: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Operator key file is unusable", {
    detail:
      `"${source}" is neither a key file written by "scafo keygen" nor a portable file ` +
      `written by "scafo fleet export": ${why}`,
    ...(cause === undefined ? {} : { cause }),
  });
}
