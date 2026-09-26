/* Operator keypair, portable remote document, and public enrollment document. */

import { readFile } from "node:fs/promises";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { safeJsonParse } from "unsecure/sanitize";
import { ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import {
  assertGrantableScope,
  bootstrapRole,
  type OperatorRole,
  trustOperator,
} from "../core/registry/operators.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import { fromBase64 } from "../core/utils/base64.ts";

/**
 * The key file, as `scafo operator keygen` writes it and as every operator command reads
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

/**
 * An operator's PUBLIC half: who they are, and what verifies what they sign.
 *
 * Every registration surface takes one of these rather than a whole key file,
 * because a registration is the one thing a private half is never needed for —
 * and a signature is the one thing it must never leave the operator's own
 * machine to produce.
 */
export type PublicHalf = Pick<OperatorKeyFile, "id" | "publicKey">;

/** What a portable operator file says it is. */
export const PORTABLE_KIND: string = "scafo-operator";

/** Version of the portable format written today. */
export const PORTABLE_VERSION: number = 1;

/** Prefix that makes a value an INLINE portable file rather than a path to one. */
export const INLINE_PREFIX: string = "base64:";

/**
 * Everything needed to operate one remote from a bare machine: who to be, and
 * where to go.
 *
 * `remote` is the name it was exported under, and is only a suggestion — the
 * machine importing it may file it under any name it likes.
 */
export interface PortableOperator {
  v: number;
  kind: string;
  remote?: string;
  endpoints: string[];
  key: OperatorKeyFile;
}

/** What a public operator document says it is. */
export const PUBLIC_KIND: string = "scafo-operator-public";

/** Version of the public format written today. */
export const PUBLIC_VERSION: number = 1;

/** Public enrollment document: identity and verifying key, never signing material. */
export interface PublicOperator extends PublicHalf {
  v: number;
  kind: string;
}

/** An operator key, and whatever the document it came in also said. */
export interface OperatorKeySource {
  key: OperatorKeyFile;
  /** Endpoints the document carried; empty for a plain key file. */
  endpoints: string[];
  /** Remote name the document suggested, when it carried one. */
  remote?: string;
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
          `file, as "scafo remote export" prints one`,
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
        `"${spec}" could not be opened; it must be a key file written by "scafo operator keygen", ` +
        `a portable file written by "scafo remote export", or an inline value prefixed ` +
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
    /* Somebody else's file: read without the keys an object answers for on its own. */
    parsed = safeJsonParse<unknown>(text);
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
  const remote = document.remote;
  if (remote !== undefined && typeof remote !== "string") {
    throw notAnOperatorFile(source, `its "remote" is not a name`);
  }

  return { key, endpoints, ...(remote === undefined ? {} : { remote }), from: source };
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
 * The public document of a key, BUILT FIELD BY FIELD rather than by stripping.
 *
 * A spread with `d` deleted afterwards is one refactor away from printing a
 * private key; naming the two fields that may leave is not.
 */
export function publicOperator(key: PublicHalf): PublicOperator {
  return {
    v: PUBLIC_VERSION,
    kind: PUBLIC_KIND,
    id: key.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: key.publicKey.x },
  };
}

/** A public document as text, the way it is printed and read back. */
export function formatPublicOperator(pub: PublicOperator): string {
  return JSON.stringify(pub, null, 2);
}

/**
 * Reads a public operator document out of `text`. `source` names it in a
 * failure.
 *
 * A document carrying a PRIVATE half is refused rather than narrowed. It would
 * be trivial to take the public fields out of it and carry on, and that is
 * exactly the wrong thing to do: somebody has just sent their private key to
 * somebody else, and the only useful thing this can do about it is say so, out
 * loud, before it is enrolled and forgotten about.
 *
 * Throws `ScafoError("invalid-input")` for anything that is not one.
 */
export function readPublicOperator(text: string, source: string): PublicOperator {
  let parsed: unknown;
  try {
    parsed = safeJsonParse<unknown>(text);
  } catch (error) {
    throw notAPublicOperator(source, "it does not hold valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw notAPublicOperator(source, "it does not hold a JSON object");
  }

  const document = parsed as Record<string, unknown>;
  if (document.privateKey !== undefined) {
    throw new ScafoError("invalid-input", "That is a PRIVATE operator key", {
      detail:
        `"${source}" carries a private half, so it is somebody's whole key file rather than ` +
        `the public document "scafo operator show" prints. Nothing needs a private key to ` +
        `enrol one — ask for the output of "scafo operator show" instead, and treat the key ` +
        `that was sent here as compromised`,
    });
  }
  if (document.kind !== PUBLIC_KIND) {
    throw notAPublicOperator(source, `its "kind" is not "${PUBLIC_KIND}"`);
  }
  if (document.v !== PUBLIC_VERSION) {
    throw notAPublicOperator(
      source,
      `it is version ${JSON.stringify(document.v)} and this scafo writes version ` +
        `${String(PUBLIC_VERSION)}`,
    );
  }
  if (typeof document.id !== "string" || document.id === "") {
    throw notAPublicOperator(source, `it carries no "id"`);
  }

  const key = document.publicKey as { kty?: unknown; crv?: unknown; x?: unknown } | null;
  if (typeof key !== "object" || key === null || key.kty !== "OKP" || key.crv !== "Ed25519") {
    throw notAPublicOperator(source, `its "publicKey" is not an Ed25519 JWK`);
  }
  if (typeof key.x !== "string" || key.x === "") {
    throw notAPublicOperator(source, `its "publicKey" carries no "x"`);
  }

  return {
    v: PUBLIC_VERSION,
    kind: PUBLIC_KIND,
    id: document.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: key.x },
  };
}

/**
 * Reads a public operator document from one of the three forms an enrollment
 * accepts: a path to a file, an inline `base64:` value, or the document itself
 * written out on the command line.
 *
 * THE VALUE'S OWN SHAPE DECIDES, and nothing sniffs the filesystem: the
 * {@link INLINE_PREFIX} is decoded, a value that opens with `{` is the document,
 * and anything else is a path — so a mistyped filename fails as a filename.
 */
export async function loadPublicOperator(spec: string): Promise<PublicOperator> {
  const value = spec.trim();

  if (value.startsWith(INLINE_PREFIX)) {
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(fromBase64(value.slice(INLINE_PREFIX.length)));
    } catch (error) {
      throw notAPublicOperator(INLINE_PREFIX, `the value after it is not base64`, error);
    }
    return readPublicOperator(decoded, INLINE_PREFIX);
  }
  if (value.startsWith("{"))
    return readPublicOperator(value, "the value given on the command line");

  let text: string;
  try {
    text = await readFile(value, "utf8");
  } catch (error) {
    throw notAPublicOperator(
      value,
      `it could not be opened, and it is neither an inline "${INLINE_PREFIX}" value nor a ` +
        `document written out on the command line`,
      error,
    );
  }
  return readPublicOperator(text, value);
}

/**
 * Records the public half in the registry, which is what makes a node accept the
 * tokens this key signs.
 *
 * STRAIGHT TO THE BUCKET, which is what it is for: this is how an installation
 * is bootstrapped, before there is a node daemon whose trust could be asked for,
 * and how one whose operator keys have all been lost is recovered. An operator
 * who already holds a working key changes it through a node instead — `scafo
 * operator rotate` — and needs no bucket credential at all.
 *
 * `role` is what `--role` carries. The tier it actually lands at is
 * {@link bootstrapRole}'s to decide, because this is the one path a key can
 * enter a fleet that has no admin to add one: the first key of an installation
 * is always an admin, an explicit operator-tier first key is REFUSED, and every
 * key after it is least privilege unless an admin is asked for.
 *
 * AND IT GRANTS NO SCOPE, which is why an operator-tier key cannot come out of
 * it at all: this path admits a key with no applications named, and an operator-tier
 * key that names none reaches nothing. Refused rather than written, by the same
 * check the wire route meets — the ceremony bypasses the TIER rules on purpose,
 * because there may be no admin to ask, and it bypasses nothing about what a
 * record may say. Seeding is unaffected: the first key of an installation is
 * always an admin, and an admin is never scoped.
 *
 * Nothing is emitted about it. There is no daemon in this path — that is the
 * point of it — so the observability seam a node reports its own trust changes
 * through does not exist here, and the record of the ceremony is the bucket's
 * own access log rather than the fleet's traces.
 */
export async function registerOperatorKey(
  registry: RegistryContext,
  key: PublicHalf,
  opts: { role?: OperatorRole } = {},
): Promise<OperatorRole> {
  const role = await bootstrapRole(registry, opts.role);
  assertGrantableScope({ role });
  await trustOperator(registry, {
    id: key.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: key.publicKey.x },
    role,
  });
  return role;
}

/* ---------------------------------------------------------------- internals */

function readEndpoints(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw notAnOperatorFile(source, `its "endpoints" is not a list of node URLs`);
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

function notAPublicOperator(source: string, why: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Operator public document is unusable", {
    detail: `"${source}" is not a public operator document as "scafo operator show" prints one: ${why}`,
    ...(cause === undefined ? {} : { cause }),
  });
}

function notAnOperatorFile(source: string, why: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Operator key file is unusable", {
    detail:
      `"${source}" is neither a key file written by "scafo operator keygen" nor a portable file ` +
      `written by "scafo remote export": ${why}`,
    ...(cause === undefined ? {} : { cause }),
  });
}
