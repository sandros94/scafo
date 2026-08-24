/*
 * Internal: which fleet a command acts on, and which key it signs with.
 *
 * ONE CHAIN, in one place, so that every operator-facing command answers "which
 * installation is this?" the same way: what the command said, then what the
 * shell said, then what the project pinned, then the only fleet there is — and,
 * where none of those decide it, the operator is ASKED rather than guessed at.
 * Off a terminal there is nobody to ask, so it is refused with everything needed
 * to answer next time.
 */

import { type JSONCParseError, parseJSONC } from "confbox";
import { DEFAULT_CONFIG_PATHS } from "../agent/config.ts";
import { ScafoError } from "../core/error.ts";
import { getFleet, readFleetKey, readFleets } from "./_fleets.ts";
import {
  loadOperatorKeySource,
  type OperatorKeyFile,
  readOperatorDocument,
} from "./_operator-key.ts";
import { readTextFile } from "./_utils.ts";

/** Environment variable naming the fleet every command acts on. */
export const SCAFO_FLEET_ENV: string = "SCAFO_FLEET";

/**
 * Environment variable carrying an operator key outright: a path to a key file,
 * a path to a portable file, or an inline `base64:` value. The CI shape — one
 * secret string, no files to place.
 */
export const SCAFO_OPERATOR_KEY_ENV: string = "SCAFO_OPERATOR_KEY";

/** Where `scafo keygen` leaves a key when the caller names no file. */
export const DEFAULT_KEY_PATH: string = "scafo-operator.json";

/** What `--key` and {@link SCAFO_OPERATOR_KEY_ENV} accept, for anything naming them. */
export const OPERATOR_KEY_FORMS: string =
  `a key file from "scafo keygen", a portable file from "scafo fleet export", ` +
  `or an inline "base64:" value of one`;

/** The flags of an operator-facing command that bear on this. */
export interface OperatorFlags {
  fleet?: string;
  key?: string;
  agent?: string;
  config?: string;
}

/** The four flags above, as a command's parsed arguments carry them. */
export function operatorFlags(flags: Record<string, unknown>): OperatorFlags {
  const given: OperatorFlags = {};
  for (const name of ["fleet", "key", "agent", "config"] as const) {
    const value = text(flags[name]);
    if (value !== undefined) given[name] = value;
  }
  return given;
}

export interface ResolveOperatorOptions {
  home: string;
  env: Record<string, string | undefined>;
  flags: OperatorFlags;
  /** Reads a file as text, resolving null when it is not there. */
  readFile?: (path: string) => Promise<string | null>;
  /** Whether there is somebody to ask. Defaults to what stdin says. */
  isTTY?: boolean;
  /** How the operator is asked. Defaults to a consola select prompt. */
  choose?: (names: string[]) => Promise<string>;
  /** The key `scafo keygen` leaves behind, for a home that holds no fleet yet. */
  defaultKeyPath?: string;
}

/** Who the operator is for this invocation, and where they are pointed. */
export interface ResolvedOperator {
  /**
   * The key this invocation signs with, READ ONLY WHEN SOMETHING SIGNS. A
   * command that turns out to reach the bucket rather than a node never needs
   * one, and must not fail for the want of a key it was never going to use.
   */
  readKey: () => Promise<OperatorKeyFile>;
  /** The agent to talk to, when anything named one. */
  agentUrl?: string;
  /** The fleet this resolved to, when a fleet decided it. */
  fleet?: string;
}

/**
 * The fleet and key one invocation acts with.
 *
 * The KEY comes from `--key`, then {@link SCAFO_OPERATOR_KEY_ENV}, then the
 * fleet — a key given outright says WITH WHAT and never WHERE, so a fleet still
 * supplies the endpoint beside it. The ENDPOINT comes from `--agent`, then
 * whatever a portable key carried, then the fleet.
 *
 * Throws `ScafoError("invalid-input")` when nothing decides the fleet and there
 * is nobody to ask, and `ScafoError("not-found")` for a fleet that is not
 * registered.
 */
export async function resolveOperator(opts: ResolveOperatorOptions): Promise<ResolvedOperator> {
  const stated = text(opts.flags.key) ?? text(opts.env[SCAFO_OPERATOR_KEY_ENV]);
  const given = stated === undefined ? null : await loadOperatorKeySource(stated);

  const fleet = await resolveFleet(opts, given === null);
  const entry = fleet === null ? null : await getFleet(opts.home, fleet);

  let reading: Promise<OperatorKeyFile> | null = null;
  const readKey = (): Promise<OperatorKeyFile> => {
    reading ??=
      given !== null
        ? Promise.resolve(given.key)
        : entry === null
          ? fallbackKey(opts)
          : readFleetKey(opts.home, entry);
    return reading;
  };

  const agentUrl = text(opts.flags.agent) ?? given?.endpoints[0] ?? entry?.endpoints[0];
  const named = fleet ?? given?.fleet;
  return {
    readKey,
    ...(agentUrl === undefined ? {} : { agentUrl }),
    ...(named === undefined ? {} : { fleet: named }),
  };
}

/**
 * Which fleet this invocation is about, or null when the home holds none.
 *
 * `mustDecide` is false when a key was given outright: such a command already
 * knows who it is, so an ambiguous home is left undecided rather than refused,
 * and the fleet only ever adds an endpoint it did not have.
 */
export async function resolveFleet(
  opts: ResolveOperatorOptions,
  mustDecide: boolean = true,
): Promise<string | null> {
  const named =
    text(opts.flags.fleet) ?? text(opts.env[SCAFO_FLEET_ENV]) ?? (await readFleetPin(opts));
  if (named !== undefined) {
    /* Read for its side effect: a name nothing answers to is a typo worth
       reporting, not a fleet to fall back from. */
    await getFleet(opts.home, named);
    return named;
  }

  const names = Object.keys((await readFleets(opts.home)).fleets);
  if (names.length === 1) return names[0] as string;
  if (names.length === 0) return null;

  /* A command carrying its own key already knows who it is; the fleet would only
     have added an endpoint, which is not worth interrupting anyone over. */
  if (!mustDecide) return null;
  if (opts.isTTY ?? process.stdin.isTTY === true) return (opts.choose ?? selectFleet)(names);

  throw new ScafoError("invalid-input", "No fleet chosen", {
    detail:
      `this operator's home holds ${String(names.length)} fleets (${names.join(", ")}) and ` +
      `nothing said which one to act on: pass --fleet <name>, set ${SCAFO_FLEET_ENV}, or pin ` +
      `one for this project with { "fleet": "<name>" } in ./scafo.config.jsonc — that pin ` +
      `holds no secret and belongs in the repository`,
  });
}

/** The fleet a project pinned, read out of the config file beside it. */
export async function readFleetPin(opts: ResolveOperatorOptions): Promise<string | undefined> {
  const read = opts.readFile ?? readTextFile;
  const explicit = text(opts.flags.config);

  for (const path of explicit === undefined ? DEFAULT_CONFIG_PATHS : [explicit]) {
    const contents = await read(path);
    if (contents === null) continue;

    const errors: JSONCParseError[] = [];
    const parsed: unknown = parseJSONC(contents, { errors, allowTrailingComma: true });
    if (errors.length > 0) return undefined;
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const pinned = (parsed as { fleet?: unknown }).fleet;
    return typeof pinned === "string" ? text(pinned) : undefined;
  }
  return undefined;
}

/* ---------------------------------------------------------------- internals */

/**
 * The key an installation that predates fleets left in the working directory.
 *
 * Only reached when the home holds no fleet at all: once there is one, the home
 * is the authority and a stray file beside the terminal must not quietly take
 * over from it.
 */
async function fallbackKey(opts: ResolveOperatorOptions): Promise<OperatorKeyFile> {
  const path = opts.defaultKeyPath ?? DEFAULT_KEY_PATH;
  const stored = await readTextFile(path);
  /* Read rather than tried: a file that IS there and is malformed must say so,
     not fall through to a refusal saying there is no key at all. */
  if (stored !== null) return readOperatorDocument(stored, path).key;

  throw new ScafoError("invalid-input", "No operator key", {
    detail:
      `this operator's home holds no fleet, ${SCAFO_OPERATOR_KEY_ENV} is not set, no --key ` +
      `was given and "${path}" is not there: register a fleet with ` +
      `"scafo fleet add <name> --endpoint <url>"`,
  });
}

/** The consola prompt, reached only when there is a terminal to ask at. */
async function selectFleet(names: string[]): Promise<string> {
  const { consola } = await import("consola");
  const picked = await consola.prompt("Which fleet?", { type: "select", options: names });

  if (typeof picked !== "string" || !names.includes(picked)) {
    throw new ScafoError("invalid-input", "No fleet chosen", {
      detail: `nothing was picked out of ${names.join(", ")}`,
    });
  }
  return picked;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
