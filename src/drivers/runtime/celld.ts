/* Materializes one application-owned Celld process and its start-time config. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ScafoError } from "../../core/error.ts";
import { fleetPrefix } from "../../core/registry/paths.ts";
import type { RuntimeDriver, RuntimeSpecInput } from "../../core/types/runtime.ts";
import type { ProcessSpec } from "../../core/types/supervisor.ts";

/** Command run when the caller does not name one. */
export const DEFAULT_CELLD_BIN: string = "celld";

/**
 * Oldest Celld this build runs against, and the one place that floor is written
 * down: the image, the installer and the docs all quote this.
 *
 * A HARD FLOOR, because it is the release whose bucket format, variable model —
 * variables travel in the Wrangler config at deploy — and storage contract this
 * build is written against. An older binary in a fleet is not a missing feature
 * but a silent hazard: it starts, it serves, and it loses work in ways nothing
 * here would report.
 *
 * CHECKED WHERE A DAEMON STARTS, which is the moment a machine picks up a
 * binary. What keeps one application's fleet from being served by two Celld
 * versions at once is the separate gate on starting a process and on taking a
 * deploy; see `core/placement/version-skew.ts`.
 */
export const MIN_CELLD_VERSION: string = "0.5.0";

/** Default loopback bind; wider peer exposure requires an explicit network decision. */
export const DEFAULT_BIND_HOST: string = "127.0.0.1";

/** Celld's complete process shutdown bound when the operator does not set one. */
export const DEFAULT_CELLD_SHUTDOWN_TOTAL_MS: number = 40_000;

/** Time kept between celld's complete shutdown bound and the supervisor's hard kill. */
const STOP_HEADROOM_MS = 5_000;

/** Largest delay Node timers can represent without overflowing to an immediate timeout. */
const MAX_TIMER_MS = 2_147_483_647;

/** Operator-settable Celld telemetry switch; unlike reserved variables it may override a default. */
export const TELEMETRY_ENV: string = "CELLD_OTEL";

/**
 * Variables an operator may not set through `runtime.celldEnv` because Scafo
 * derives or removes them for each supervised process.
 */
export const OPERATOR_RESERVED_ENV: string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "CELLD_BUCKET",
  "CELLD_ADDR",
  "CELLD_INTERNAL_ADDR",
  "CELLD_ADVERTISE",
  /* Derived from ingress topology, not application input. */
  "CELLD_TRUST_FORWARDED_HEADERS",
];

export interface CelldDriverOptions {
  /** Executable to run; resolved against `PATH` unless it is a path. */
  binPath?: string;
  /** Base variables for every process. Driver-derived values override conflicts. */
  operatorEnv?: Record<string, string>;
}

/** Builds the Celld runtime driver; validates its shutdown timeout. */
export function createCelldDriver(opts: CelldDriverOptions): RuntimeDriver {
  const binPath = opts.binPath ?? DEFAULT_CELLD_BIN;
  const operatorEnv = opts.operatorEnv === undefined ? undefined : { ...opts.operatorEnv };
  const shutdownTotalMs = parseShutdownTotalMs(operatorEnv?.CELLD_SHUTDOWN_TOTAL_MS);

  return {
    stopGraceMs: shutdownTotalMs + STOP_HEADROOM_MS,

    processSpec(input: RuntimeSpecInput): ProcessSpec {
      const fleet = fleetPrefix(input.application.name);
      const objectPrefix = joinPrefix(input.node.keyPrefix, fleet);
      /* Both listeners bind the node's bind host; peers are told the advertise
         host below, and the two are only the same thing when nothing sits between
         them — the tunnel case is what keeps them apart. */
      const bindHost = input.node.bindHost ?? DEFAULT_BIND_HOST;
      const listen = `${bindHost}:${String(input.ports.public)}`;
      const internalListen = `${bindHost}:${String(input.ports.internal)}`;

      return {
        id: input.application.name,
        command: binPath,
        args: [
          "--bucket",
          `${input.node.bucket}/${objectPrefix}`,
          "--endpoint",
          input.node.endpoint,
          "--listen",
          listen,
          "--internal-listen",
          internalListen,
          "--advertise",
          `${input.node.advertiseHost}:${String(input.ports.internal)}`,
        ],
        env: processEnv(input, operatorEnv),
      };
    },

    async reload(input): Promise<void> {
      const url = `http://${input.host}:${String(input.port)}/reload`;
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(RELOAD_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new ScafoError("capability-missing", "Celld refused to reload", {
          detail: `POST ${url} answered HTTP ${String(response.status)}`,
        });
      }
      /* The body is read to completion so the connection is not left hanging on
         a keep-alive socket this node never speaks on again. */
      await response.text();
    },
  };
}

/**
 * How long the internal listener has to answer a reload before this node stops
 * waiting for it.
 *
 * SHORT, because of what is on the other side of the wait: a deploy's caller,
 * already holding a `deployed` record. The reload only shortens the seconds
 * between that record and the application serving what it names, and Celld's own
 * pointer poll covers the case where it never lands — so a listener that is busy,
 * gone, or on a version whose API has moved must cost the deploy a few seconds
 * and nothing more. The endpoint itself is unauthenticated, on loopback, and
 * documented upstream as alpha.
 */
const RELOAD_TIMEOUT_MS = 3000;

/** How long `--version` may take before the binary counts as unreadable. */
const VERSION_TIMEOUT_MS = 10_000;

/** Output quoted back in a refusal, so a chatty or broken binary cannot flood a log. */
const VERSION_OUTPUT_CHARS = 200;

/** What the binary prints: `celld 0.5.0`, and `celld 0.5.0 (debug)` from a debug build. */
const VERSION_RE = /^celld (\d+)\.(\d+)\.(\d+)\b/;

const run = promisify(execFile);

/**
 * Runs `<binPath> --version` and answers the `X.Y.Z` it named, refusing anything
 * this build cannot run with `ScafoError("capability-missing")`.
 *
 * Three distinct refusals, because they are three different things to do about
 * it: a binary that could not be STARTED is a path or a permission problem, one
 * whose version is UNREADABLE is not the binary anybody meant, and one that is
 * TOO OLD is an upgrade that has not happened yet. {@link MIN_CELLD_VERSION} says
 * why the last of those is worth refusing to start over.
 */
export async function probeCelldVersion(
  binPath: string,
  opts?: { timeoutMs?: number },
): Promise<string> {
  const timeoutMs = opts?.timeoutMs ?? VERSION_TIMEOUT_MS;
  const command = `${binPath} --version`;
  let printed: string;

  try {
    ({ stdout: printed } = await run(binPath, ["--version"], { timeout: timeoutMs }));
  } catch (error) {
    if (!neverStarted(error)) throw unreadable(command, timeoutMs, error);
    throw new ScafoError("capability-missing", "Celld could not be run", {
      detail: `"${command}" could not be started on this node`,
      cause: error,
    });
  }

  const output = printed.trim();
  const found = VERSION_RE.exec(output);
  if (found === null) {
    throw new ScafoError("capability-missing", "Celld version is unreadable", {
      detail: `"${command}" printed ${quoteOutput(output)}, not a "celld X.Y.Z" line`,
    });
  }

  const version = found.slice(1, 4).join(".");
  if (compareVersions(version, MIN_CELLD_VERSION) < 0) {
    throw new ScafoError("capability-missing", "Celld is too old", {
      detail: `"${binPath}" is celld ${version}; this build requires ${MIN_CELLD_VERSION} or newer`,
    });
  }
  return version;
}

/**
 * Compares two `X.Y.Z` versions by their numbers: negative when `a` is older
 * than `b`, zero when they name the same release.
 *
 * By number rather than by text, because text puts `0.4.10` before `0.4.9` —
 * which would let the gate admit a binary older than the floor, and would order
 * a fleet listing backwards at exactly the moment an operator is reading it to
 * see which machines still run the old one. A part that is not a number counts
 * as older than any number, so a record carrying something unexpected sorts last
 * instead of shuffling the rest.
 */
export function compareVersions(a: string, b: string): number {
  const left = triple(a);
  const right = triple(b);
  for (let i = 0; i < 3; i++) {
    const diff = left[i] - right[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Environment of one runtime process, in the order the parts override each other. */
function processEnv(
  input: RuntimeSpecInput,
  operatorEnv?: Record<string, string>,
): Record<string, string> {
  /* Base environment, then node configuration; the driver derives the rest last,
     so neither layer can displace a value Scafo owns. */
  const env: Record<string, string> = { ...input.baseEnv, ...operatorEnv };

  env.AWS_ACCESS_KEY_ID = input.node.accessKey;
  env.AWS_SECRET_ACCESS_KEY = input.node.secretKey;
  env.AWS_REGION = input.node.region;

  /* The node ingress terminates TLS and supplies forwarded headers. */
  env.CELLD_TRUST_FORWARDED_HEADERS = "1";

  return env;
}

/** Reads the upstream shutdown bound so the supervisor always waits longer. */
function parseShutdownTotalMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_CELLD_SHUTDOWN_TOTAL_MS;

  if (!/^\d+$/.test(value)) {
    throw invalidShutdownTotal(value);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TIMER_MS - STOP_HEADROOM_MS) {
    throw invalidShutdownTotal(value);
  }
  return parsed;
}

function invalidShutdownTotal(value: string): ScafoError {
  return new ScafoError("invalid-input", "Invalid celld shutdown bound", {
    detail:
      `"CELLD_SHUTDOWN_TOTAL_MS" must be a positive integer no greater than ` +
      `${String(MAX_TIMER_MS - STOP_HEADROOM_MS)}, got ${JSON.stringify(value)}`,
  });
}

/**
 * Whether the child never ran at all. Node says so with a system error — a
 * string errno and the syscall that failed — while a child that ran and failed
 * carries an exit code, a signal, and whatever it managed to print.
 */
function neverStarted(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { code?: unknown; syscall?: unknown };
  return typeof failure.syscall === "string" && typeof failure.code === "string";
}

/** A binary that ran and said nothing usable: a bad exit, a signal, or a timeout. */
function unreadable(command: string, timeoutMs: number, error: unknown): ScafoError {
  const failure = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  const said = outputText(failure.stderr) === "" ? failure.stdout : failure.stderr;
  const how =
    failure.killed === true
      ? `did not answer within ${String(timeoutMs)}ms`
      : typeof failure.signal === "string"
        ? `was killed by ${failure.signal}`
        : `exited with code ${String(failure.code)}`;

  return new ScafoError("capability-missing", "Celld version is unreadable", {
    detail: `"${command}" ${how} and printed ${quoteOutput(outputText(said))}`,
    cause: error,
  });
}

function outputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The tail of what the binary printed, bounded so a chatty one cannot flood a log. */
function quoteOutput(output: string): string {
  if (output === "") return "nothing";
  const tail =
    output.length <= VERSION_OUTPUT_CHARS ? output : `…${output.slice(-VERSION_OUTPUT_CHARS)}`;
  return JSON.stringify(tail);
}

/** The three numbers of a version; anything unparseable reads as older than any of them. */
function triple(version: string): [number, number, number] {
  const parts = version.split(".");
  return [versionPart(parts[0]), versionPart(parts[1]), versionPart(parts[2])];
}

function versionPart(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

/** Joins the installation's key prefix to a fleet prefix. */
function joinPrefix(keyPrefix: string | undefined, fleet: string): string {
  const trimmed = keyPrefix?.replaceAll(/^\/+|\/+$/g, "") ?? "";
  return trimmed === "" ? fleet : `${trimmed}/${fleet}`;
}
