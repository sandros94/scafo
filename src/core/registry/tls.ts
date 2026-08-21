/*
 * The TLS material an ingress running beside a node persists through it —
 * certificates, account keys, and whatever else it must keep across restarts —
 * kept in the installation's own bucket so that no other process needs a
 * credential for it.
 *
 * BINARY-SAFE OVER A STRING-BODIED STORE. A value arrives as raw bytes and some
 * of them are DER rather than text, so each is wrapped in a JSON envelope
 * carrying the value base64-encoded beside the time it was written. Nothing here
 * reads a value or cares what is in one.
 *
 * WRITES ARE LAST WRITER WINS, deliberately outside the CAS discipline every
 * registry record follows: one object is one write, so a value is never half
 * replaced, and two writers of the same key are writing the same material.
 * Serializing the work that PRODUCES a value is what the locks beside this file
 * are for.
 */

import { ScafoError } from "../error.ts";
import { fromBase64, toBase64 } from "../utils/base64.ts";
import { deleteKey, putJson, readJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { assertTlsKey, tlsObjectKey, tlsObjectsPrefix } from "./paths.ts";

/** What one stored value looks like in the bucket. */
export interface TlsEnvelope {
  /** The bytes that were written, base64. */
  value: string;
  /** ISO time of the write that produced them. */
  modified: string;
}

/** One stored value, decoded. */
export interface TlsObject {
  value: Uint8Array<ArrayBuffer>;
  /** ISO time of the write that produced it. */
  modified: string;
}

/** What a caller learns about a key without reading the value behind it. */
export interface TlsStat {
  /** The key as it was asked about. */
  key: string;
  /** When the value was last written; null for a key that only has keys beneath it. */
  modified: string | null;
  /** Length of the decoded value; 0 for a key that only has keys beneath it. */
  size: number;
  /** True when the key names a value, false when it only names keys beneath it. */
  isTerminal: boolean;
}

export interface ListTlsOptions {
  /**
   * List every key at or under the prefix. Off by default, which lists the
   * IMMEDIATE children only: a deeper key contributes the child it sits under,
   * once, and a value stored at the prefix itself is not a child of itself.
   */
  recursive?: boolean;
}

/** Writes `value` at `key`, replacing whatever was there. */
export async function putTlsObject(
  ctx: RegistryContext,
  key: string,
  value: Uint8Array,
): Promise<void> {
  await putJson<TlsEnvelope>(ctx, tlsObjectKey(key), {
    value: toBase64(value),
    modified: nowIso(ctx),
  });
}

/** Reads the value at `key`, or null when nothing is stored there. */
export async function readTlsObject(ctx: RegistryContext, key: string): Promise<TlsObject | null> {
  const objectKey = tlsObjectKey(key);
  const found = await readJson<TlsEnvelope>(ctx, objectKey);
  return found === null ? null : decode(objectKey, found.value);
}

/**
 * Removes the value at `key` AND every value beneath it, and answers how many
 * keys went.
 *
 * A key naming neither answers 0, which is the caller's cue that there was
 * nothing there at all rather than that a deletion did nothing.
 */
export async function deleteTlsObject(ctx: RegistryContext, key: string): Promise<number> {
  const objectKey = tlsObjectKey(key);
  /* One listing rather than a read and a listing, narrowed to the key itself and
     what is under it: listing is prefix-matched, so a sibling whose name merely
     starts with this one ("certs" beside "cert") would otherwise go with it. */
  const doomed = (await ctx.store.list(objectKey)).filter(
    (found) => found === objectKey || found.startsWith(`${objectKey}/`),
  );

  for (const found of doomed) await deleteKey(ctx, found);
  return doomed.length;
}

/**
 * The keys at or under `prefix`, spelled as the caller stored them and sorted.
 *
 * An EMPTY prefix lists everything. A prefix nothing matches answers an empty
 * list; a caller that must tell "no such name" from "a name holding nothing"
 * decides that from the emptiness, because this key space has no way to store
 * the second.
 */
export async function listTlsObjects(
  ctx: RegistryContext,
  prefix: string,
  opts?: ListTlsOptions,
): Promise<string[]> {
  if (prefix !== "") assertTlsKey(prefix);

  const root = tlsObjectsPrefix();
  const stored = await ctx.store.list(`${root}${prefix}`);
  /* What "under the prefix" means, and the reason the listing above is filtered:
     a prefix matches by string, so "cert" would otherwise pull "certs/…" in. */
  const under = prefix === "" ? "" : `${prefix}/`;

  const keys = new Set<string>();
  for (const found of stored) {
    const key = found.slice(root.length);
    if (prefix !== "" && key !== prefix && !key.startsWith(under)) continue;

    if (opts?.recursive === true) {
      keys.add(key);
      continue;
    }
    if (key === prefix) continue;
    keys.add(`${under}${key.slice(under.length).split("/")[0]}`);
  }
  return [...keys].sort();
}

/**
 * What is at `key`: a stored value, a name that only has values beneath it, or
 * nothing at all (null).
 */
export async function statTlsObject(ctx: RegistryContext, key: string): Promise<TlsStat | null> {
  const objectKey = tlsObjectKey(key);

  const found = await readJson<TlsEnvelope>(ctx, objectKey);
  if (found !== null) {
    const object = decode(objectKey, found.value);
    return { key, modified: object.modified, size: object.value.length, isTerminal: true };
  }

  const children = await ctx.store.list(`${objectKey}/`);
  return children.length === 0 ? null : { key, modified: null, size: 0, isTerminal: false };
}

function decode(objectKey: string, envelope: TlsEnvelope): TlsObject {
  if (typeof envelope.value !== "string" || typeof envelope.modified !== "string") {
    throw unreadable(objectKey, "does not carry a value and the time it was written");
  }

  try {
    return { value: fromBase64(envelope.value), modified: envelope.modified };
  } catch (error) {
    throw unreadable(objectKey, "carries a value that is not base64", error);
  }
}

function unreadable(objectKey: string, why: string, cause?: unknown): ScafoError {
  return new ScafoError("store-nonconforming", "Stored object is not a storage envelope", {
    detail: `"${objectKey}" ${why}`,
    ...(cause === undefined ? {} : { cause }),
  });
}
