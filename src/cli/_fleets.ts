/*
 * Internal: the fleets an operator has registered, and the keys that speak for
 * them.
 *
 * One file lists the fleets by NAME — where each is reached, and a REFERENCE to
 * the key it signs with. The reference is an object rather than a path so that a
 * key kept somewhere other than a file, one day, is a new kind rather than a new
 * format. Nothing secret is in the list itself: the keys are their own files,
 * readable by their owner alone.
 */

import { rm, writeFile } from "node:fs/promises";
import { type JSONCParseError, parseJSONC } from "confbox";
import { ScafoError } from "../core/error.ts";
import {
  assertKeyName,
  homeConfigPath,
  homeKeyPath,
  homeKeyRefPath,
  homeKeysDir,
  resolveHomePath,
} from "./_home.ts";
import {
  formatPortable,
  generateOperatorKey,
  loadOperatorKeySource,
  type OperatorKeyFile,
  type PortableOperator,
  PORTABLE_KIND,
  PORTABLE_VERSION,
  readOperatorDocument,
} from "./_operator-key.ts";
import { readTextFile, SECRET_FILE_MODE, writeSecretFile } from "./_utils.ts";

/** Version of the fleet registry written today. */
export const FLEETS_VERSION: number = 1;

/** Where a fleet's key is kept. One kind today; the shape leaves room for more. */
export interface FleetKeyRef {
  kind: "file";
  /** Relative to the home, unless it is absolute. */
  path: string;
}

/** One fleet: where it is reached, and what speaks for the operator there. */
export interface FleetEntry {
  endpoints: string[];
  key: FleetKeyRef;
  /**
   * A key minted for this fleet that the fleet does not yet sign with — the
   * half-finished state of a rotation, and the only state one has.
   *
   * It is written before the new key is registered and cleared by the flip that
   * makes it {@link FleetEntry.key}, so an entry carrying one says exactly this:
   * a rotation reached at least as far as minting, and did not reach its flip.
   * Rerunning the rotation picks that key up instead of minting another, which
   * is what keeps an interrupted run from leaving a key behind in the fleet that
   * nothing here points at.
   */
  rotating?: FleetKeyRef;
}

/** The registry file itself. */
export interface FleetsFile {
  v: number;
  fleets: Record<string, FleetEntry>;
}

/** What is said before a private key is put on a terminal. */
export const STDOUT_KEY_WARNING: string =
  `scafo: this holds a PRIVATE KEY in the clear; pipe it into a secret store, or use ` +
  `--out to write it to a file only you can read`;

const HEADER =
  `/*\n` +
  ` * The fleets this operator can reach, and the key that speaks for each.\n` +
  ` *\n` +
  ` * Managed by "scafo fleet"; hand-written comments are not preserved. NO SECRET\n` +
  ` * LIVES HERE — a key reference names a file under keys/, which is where the\n` +
  ` * private halves are.\n` +
  ` */\n`;

/** Reads the fleet registry, answering an empty one when the home has no file yet. */
export async function readFleets(home: string): Promise<FleetsFile> {
  const text = await readTextFile(homeConfigPath(home));
  if (text === null) return { v: FLEETS_VERSION, fleets: {} };

  const errors: JSONCParseError[] = [];
  const parsed: unknown = parseJSONC(text, { errors, allowTrailingComma: true });
  const failure = errors[0];
  if (failure !== undefined) {
    throw unusable(home, `it has a syntax error at character ${String(failure.offset)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw unusable(home, "it does not hold an object");
  }

  const file = parsed as Partial<FleetsFile>;
  const fleets = file.fleets ?? {};
  if (typeof fleets !== "object" || Array.isArray(fleets)) {
    throw unusable(home, `its "fleets" is not an object of fleets by name`);
  }
  return { v: typeof file.v === "number" ? file.v : FLEETS_VERSION, fleets };
}

/** Writes the fleet registry, creating a home only its owner can enter. */
export async function writeFleets(home: string, file: FleetsFile): Promise<void> {
  await writeSecretFile(home, homeConfigPath(home), `${HEADER}${JSON.stringify(file, null, 2)}\n`);
}

/** One fleet by name. Throws `ScafoError("not-found")`, naming the ones there are. */
export async function getFleet(home: string, name: string): Promise<FleetEntry> {
  const file = await readFleets(home);
  const entry = file.fleets[name];
  if (entry !== undefined) return entry;

  const registered = Object.keys(file.fleets);
  throw new ScafoError("not-found", "Fleet is not registered", {
    detail:
      `"${name}" is not in this operator's home; ` +
      (registered.length === 0
        ? `nothing is registered yet, so start with "scafo fleet add ${name} --endpoint <url>"`
        : `registered: ${registered.join(", ")}`),
  });
}

/** Reads the key one fleet signs with. */
export async function readFleetKey(home: string, entry: FleetEntry): Promise<OperatorKeyFile> {
  const path = resolveHomePath(home, entry.key.path);
  const text = await readTextFile(path);
  if (text === null) {
    throw new ScafoError("not-found", "Fleet key is missing", {
      detail: `"${path}" is what this fleet signs with, and it is not there`,
    });
  }
  return readOperatorDocument(text, path).key;
}

export interface AddFleetOptions {
  /** Name to file it under. Optional only with {@link AddFleetOptions.from}. */
  name?: string;
  /** Agent URLs it is reached at. Required unless a portable file carries them. */
  endpoints?: string[];
  /** An existing key in this home to reuse, instead of minting a fresh one. */
  keyName?: string;
  /** A portable file to import: a path, or an inline `base64:` value. */
  from?: string;
}

/** A fleet as it was registered. */
export interface AddedFleet {
  name: string;
  entry: FleetEntry;
  key: OperatorKeyFile;
  /** Absolute path of the key file the entry points at. */
  keyPath: string;
  /** Whether a fresh keypair was minted for this fleet. */
  minted: boolean;
}

/**
 * Registers a fleet: writes its key, then its entry.
 *
 * A fresh keypair is minted by default and named after the fleet, because the
 * common case is a new installation that has nothing yet. `keyName` reuses a key
 * this home already holds, so one key can speak for several fleets; `from` takes
 * both the key and the endpoints out of a portable file.
 *
 * Throws `ScafoError("invalid-input")` when the name is already registered — an
 * entry replaced in place would strand the key the old one pointed at.
 */
export async function addFleet(home: string, opts: AddFleetOptions): Promise<AddedFleet> {
  const imported = opts.from === undefined ? null : await loadOperatorKeySource(opts.from);
  if (imported !== null && opts.keyName !== undefined) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail: `--from carries the key to use and --key names another one; pass one of them`,
    });
  }

  const name = opts.name ?? imported?.fleet;
  if (name === undefined) {
    throw new ScafoError("invalid-input", "Fleet has no name", {
      detail:
        `the portable file names no fleet, so this one has to: ` +
        `"scafo fleet add <name> --from ..."`,
    });
  }
  assertKeyName(name);

  const stated = opts.endpoints ?? [];
  const endpoints = stated.length === 0 ? (imported?.endpoints ?? []) : stated;
  if (endpoints.length === 0) {
    throw new ScafoError("invalid-input", "Fleet has no endpoint", {
      detail: `nothing could reach "${name}": give --endpoint <url> of one of its nodes`,
    });
  }

  const file = await readFleets(home);
  if (file.fleets[name] !== undefined) {
    throw new ScafoError("invalid-input", "Fleet is already registered", {
      detail:
        `"${name}" is already in this operator's home; run "scafo fleet remove ${name}" ` +
        `first if it is meant to be replaced`,
    });
  }

  const keyName = opts.keyName ?? name;
  assertKeyName(keyName);
  const keyPath = homeKeyPath(home, keyName);
  const stored = await readTextFile(keyPath);

  let key: OperatorKeyFile;
  let minted = false;
  if (opts.keyName !== undefined) {
    if (stored === null) {
      throw new ScafoError("not-found", "Key is not in this operator's home", {
        detail: `--key "${opts.keyName}" names "${keyPath}", and it is not there`,
      });
    }
    key = readOperatorDocument(stored, keyPath).key;
  } else {
    /* Never over a key that is already there: it may be what another fleet
       signs with, and replacing it would take that fleet down silently. */
    if (stored !== null) {
      throw new ScafoError("invalid-input", "Key is already in this operator's home", {
        detail:
          `"${keyPath}" holds a key another fleet may still sign with; pass ` +
          `--key ${keyName} to reuse it, or remove it deliberately`,
      });
    }
    key = imported?.key ?? (await generateOperatorKey());
    minted = imported === null;
    await writeSecretFile(homeKeysDir(home), keyPath, `${JSON.stringify(key, null, 2)}\n`);
  }

  const entry: FleetEntry = { endpoints, key: { kind: "file", path: homeKeyRefPath(keyName) } };
  await writeFleets(home, { ...file, fleets: { ...file.fleets, [name]: entry } });
  return { name, entry, key, keyPath, minted };
}

/** A fleet as it was unregistered. */
export interface RemovedFleet {
  name: string;
  keyPath: string;
  /** Whether the key file went with the entry. */
  keyRemoved: boolean;
  /** Fleets still signing with that key, which is why it stayed. */
  sharedWith: string[];
}

/**
 * Every key file an entry points at: the one it signs with, and the one a
 * rotation it has not finished would sign with next.
 *
 * As the home REFERS to them, so two entries naming the same file compare equal
 * whatever either of them calls it.
 */
export function fleetKeyRefs(entry: FleetEntry): string[] {
  return entry.rotating === undefined ? [entry.key.path] : [entry.key.path, entry.rotating.path];
}

/** The fleets, other than `name`, that point at any of `paths`. */
export function fleetsReferencing(file: FleetsFile, name: string, paths: string[]): string[] {
  return Object.entries(file.fleets)
    .filter(
      ([other, entry]) => other !== name && fleetKeyRefs(entry).some((p) => paths.includes(p)),
    )
    .map(([other]) => other);
}

/**
 * Unregisters a fleet, and deletes its key only when no other fleet still
 * references it — a shared key deleted with one of its fleets would take the
 * others down with it.
 *
 * A key an unfinished rotation left pending goes with the fleet unconditionally:
 * nothing else can be pointing at it, because a rotation always mints its own.
 */
export async function removeFleet(home: string, name: string): Promise<RemovedFleet> {
  const file = await readFleets(home);
  const entry = file.fleets[name];
  if (entry === undefined) {
    throw new ScafoError("not-found", "Fleet is not registered", {
      detail:
        `"${name}" is not in this operator's home; ` +
        `registered: ${Object.keys(file.fleets).join(", ") || "nothing"}`,
    });
  }

  const remaining = { ...file.fleets };
  delete remaining[name];
  const sharedWith = fleetsReferencing(file, name, [entry.key.path]);

  await writeFleets(home, { ...file, fleets: remaining });

  const keyPath = resolveHomePath(home, entry.key.path);
  if (sharedWith.length === 0) await rm(keyPath, { force: true });
  if (entry.rotating !== undefined) {
    await rm(resolveHomePath(home, entry.rotating.path), { force: true });
  }
  return { name, keyPath, keyRemoved: sharedWith.length === 0, sharedWith };
}

export interface ExportFleetOptions {
  /** File to write it to, 0600. Without one it goes to {@link ExportFleetOptions.write}. */
  out?: string;
  /** Whether the output is a terminal, which is what the warning is about. */
  isTTY?: boolean;
  write?: (line: string) => void;
  warn?: (line: string) => void;
}

/**
 * Writes one fleet out as a portable file — everything needed to operate it from
 * a bare machine.
 *
 * Stdout by default, so it pipes straight into a secret store. A terminal is
 * WARNED first: what is about to be printed is a private key, and a terminal is
 * exactly where one gets left behind in scrollback.
 */
export async function exportFleet(
  home: string,
  name: string,
  opts: ExportFleetOptions,
): Promise<PortableOperator> {
  const entry = await getFleet(home, name);
  const portable: PortableOperator = {
    v: PORTABLE_VERSION,
    kind: PORTABLE_KIND,
    fleet: name,
    endpoints: entry.endpoints,
    key: await readFleetKey(home, entry),
  };

  const write = opts.write ?? ((line: string): void => console.log(line));
  if (opts.out === undefined) {
    if (opts.isTTY === true)
      (opts.warn ?? ((line: string): void => console.warn(line)))(STDOUT_KEY_WARNING);
    write(formatPortable(portable));
    return portable;
  }

  await writeFile(opts.out, `${formatPortable(portable)}\n`, {
    encoding: "utf8",
    mode: SECRET_FILE_MODE,
  });
  write(`scafo: wrote the portable file for fleet "${name}" to ${opts.out}`);
  return portable;
}

/** The fleets a home holds, as an operator reads them. */
export function formatFleetList(file: FleetsFile): string {
  const names = Object.keys(file.fleets);
  if (names.length === 0) {
    return `scafo: no fleet is registered; add one with "scafo fleet add <name> --endpoint <url>"`;
  }

  const lines = [`scafo: ${String(names.length)} fleet${names.length === 1 ? "" : "s"}`];
  for (const name of names) {
    const entry = file.fleets[name] as FleetEntry;
    lines.push(
      `  ${name}`,
      `    endpoints  ${entry.endpoints.join(", ")}`,
      `    key        ${entry.key.path}`,
    );
  }
  return lines.join("\n");
}

/* ---------------------------------------------------------------- internals */

function unusable(home: string, why: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Fleet registry is unusable", {
    detail: `"${homeConfigPath(home)}" lists this operator's fleets but ${why}`,
    ...(cause === undefined ? {} : { cause }),
  });
}
