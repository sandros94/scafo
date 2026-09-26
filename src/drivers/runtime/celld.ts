/* Materializes one application-owned Celld process and its start-time config. */

import { execFile } from "node:child_process";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { secureRandomNumber } from "unsecure/random";
import { ScafoError } from "../../core/error.ts";
import {
  assertPortRange,
  choosePorts,
  DEFAULT_PORT_QUARANTINE_MS,
  DEFAULT_PORT_RANGE_START,
  defaultPortRangeEnd,
  type PortPair,
  type PortRange,
} from "../../core/placement/ports.ts";
import { fleetPrefix } from "../../core/registry/paths.ts";
/* The one path a Celld process answers for itself on, shared with the ingress
   rendering that health-checks the very same port. */
import { APP_HEALTH_PATH } from "../ingress/traefik.ts";
import type { RuntimeDriver, RuntimePorts, RuntimeSpecInput } from "../../core/types/runtime.ts";
import type { ProcessSpec } from "../../core/types/supervisor.ts";
import { assertSlug, isSlug } from "../../core/utils/slug.ts";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "../_private-dir.ts";

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
 * versions that may not share it is the separate gate on starting a process and
 * on taking a deploy; see `core/placement/version-skew.ts`.
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
  /* The node's own identity and the private directories it keeps per
     application; see {@link celldStateDirs}. */
  "CELLD_NODE",
  "CELLD_WATCH",
  "CELLD_ASSET_CACHE_DIR",
];

/** Directory of the node's state every supervised process's own lives under. */
const STATE_SUBDIR = "celld";

/** Local work directory: the process's SQLite and its follower disk. */
const WORK_SUBDIR = "work";

/** Where one process caches the static assets it downloads. */
const ASSETS_SUBDIR = "assets";

/** File holding the two ports one application holds on this node. */
const PORTS_FILE = "ports.json";

/**
 * File holding the ports released here and when, beside the per-application
 * directories rather than inside one: what it records is exactly the pairs whose
 * directory is gone. Its name is no application name, so it is never mistaken
 * for one.
 */
const RELEASED_FILE = ".released.json";

/**
 * The private directories one application's process on this node works out of.
 *
 * DERIVED, NEVER CONFIGURED, and under the node's own state directory rather
 * than under a temporary one, because of what they hold.
 *
 * The WORK directory is the local half of the fleet's durability. A write is
 * acknowledged once a peer has it on the follower disk kept here, before the
 * bucket has it; a node recovers those writes at boot by taking over the log its
 * predecessor of the same name left, and it serves its own retained follower
 * disk to the peers doing the same. A directory that is new on every start
 * leaves those acknowledged writes nowhere, and the fleet comes back reporting a
 * bounded loss instead of the last write. Upstream's own default is
 * `$TMPDIR/celld-<pid>`, which is a different directory on every start of every
 * process — so this is set, and set somewhere that outlives the machine's boot
 * and the container's life.
 *
 * The ASSET CACHE is separated per application for a plainer reason: upstream
 * defaults it to one directory under `$TMPDIR` shared by every Celld process on
 * the machine, and the processes of a node are several tenants' at once.
 *
 * The application name is one path segment, which its slug rule already
 * guarantees; it is asserted here because this is where a name becomes a path.
 */
export function celldStateDirs(
  stateDir: string,
  application: string,
): { root: string; work: string; assets: string } {
  assertSlug(application);
  const root = join(stateDir, STATE_SUBDIR, application);
  return { root, work: join(root, WORK_SUBDIR), assets: join(root, ASSETS_SUBDIR) };
}

export interface CelldDriverOptions {
  /**
   * Where this node keeps what it has to remember between boots. Every
   * supervised process's own directories live under it; see
   * {@link celldStateDirs} for what that costs when it does not survive.
   */
  stateDir: string;
  /** Executable to run; resolved against `PATH` unless it is a path. */
  binPath?: string;
  /** Base variables for every process. Driver-derived values override conflicts. */
  operatorEnv?: Record<string, string>;
  /**
   * Ports this node draws its pairs from. Defaults to the documented range.
   *
   * WORTH SIZING ON A HOST-NETWORK DEPLOYMENT: a node that shares the host's
   * network namespace draws from the HOST's port space, where the machine's own
   * services live, so an operator fits the range to the machine.
   */
  portRange?: PortRange;
  /** How long a released pair is kept from another application. */
  portQuarantineMs?: number;
  /** Address ports are probed on; the address processes bind their listeners to. */
  bindHost?: string;
  /** Randomness a port choice draws on. Injected so a test can fix the choice. */
  random?: (min: number, max: number, ignore: Set<number>) => number;
  /** Whether a port can be bound on `host` now. Injected so a test binds nothing. */
  isFree?: (port: number, host: string) => Promise<boolean>;
  /** Milliseconds since the epoch, as the quarantine ages its entries by. */
  now?: () => number;
}

/** Builds the Celld runtime driver; validates its shutdown timeout and port range. */
export function createCelldDriver(opts: CelldDriverOptions): RuntimeDriver {
  const binPath = opts.binPath ?? DEFAULT_CELLD_BIN;
  const stateDir = opts.stateDir;
  const operatorEnv = opts.operatorEnv === undefined ? undefined : { ...opts.operatorEnv };
  const shutdownTotalMs = parseShutdownTotalMs(operatorEnv?.CELLD_SHUTDOWN_TOTAL_MS);
  const portRange = opts.portRange ?? {
    start: DEFAULT_PORT_RANGE_START,
    end: defaultPortRangeEnd(DEFAULT_PORT_RANGE_START),
  };
  assertPortRange(portRange);
  const quarantineMs = opts.portQuarantineMs ?? DEFAULT_PORT_QUARANTINE_MS;
  const bindHost = opts.bindHost ?? DEFAULT_BIND_HOST;
  const random = opts.random ?? secureRandomNumber;
  const now = opts.now ?? Date.now;
  const probe = opts.isFree ?? bindableNow;
  const isFree = (port: number): Promise<boolean> => probe(port, bindHost);

  /** Ports every OTHER application of this node holds, read off their files. */
  async function heldPorts(except: string): Promise<Set<number>> {
    const held = new Set<number>();
    for (const application of await heldApplications(stateDir)) {
      if (application === except) continue;
      const pair = await readPortsFile(portsPath(stateDir, application));
      if (pair === null) continue;
      held.add(pair.public);
      held.add(pair.internal);
    }
    return held;
  }

  /** The quarantine as it stands now, with everything that has aged out dropped. */
  async function readQuarantine(): Promise<ReleasedPort[]> {
    const released = await readReleasedFile(releasedPath(stateDir));
    const floor = now() - quarantineMs;
    return released.filter((entry) => entry.at > floor);
  }

  /** Puts both halves of `pair` under quarantine, pruning what has aged out. */
  async function release(pair: PortPair): Promise<void> {
    const at = now();
    const kept = (await readQuarantine()).filter(
      (entry) => entry.port !== pair.public && entry.port !== pair.internal,
    );
    kept.push({ port: pair.public, at }, { port: pair.internal, at });
    await ensurePrivateDir(join(stateDir, STATE_SUBDIR));
    await writePrivateJson(releasedPath(stateDir), {
      v: 1,
      released: kept.map((entry) => ({ port: entry.port, at: new Date(entry.at).toISOString() })),
    });
  }

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
        env: processEnv(input, celldStateDirs(stateDir, input.application.name), operatorEnv),
      };
    },

    async prepareLocalState(application: string): Promise<void> {
      const dirs = celldStateDirs(stateDir, application);
      await ensurePrivateDir(dirs.work);
      await ensurePrivateDir(dirs.assets);
    },

    async ports(application: string): Promise<RuntimePorts> {
      const path = portsPath(stateDir, application);
      const held = await heldPorts(application);
      const kept = await readPortsFile(path);

      /* Held first, and probed second: a pair another application of this node
         has taken over is not this one's however free the sockets look, and a
         pair a foreign process is listening on cannot be started on at all. */
      if (
        kept !== null &&
        !held.has(kept.public) &&
        !held.has(kept.internal) &&
        (await isFree(kept.public)) &&
        (await isFree(kept.internal))
      ) {
        return { ports: kept };
      }

      const quarantined = (await readQuarantine()).map((entry) => entry.port);
      const ports = await choosePorts({ range: portRange, held, quarantined, isFree, random });
      await ensurePrivateDir(celldStateDirs(stateDir, application).root);
      await writePrivateJson(path, { v: 1, public: ports.public, internal: ports.internal });
      /* The pair being left behind is quarantined too: until every peer and
         ingress has re-read the routing they still send this application's
         traffic there, and a second application on it would answer that. */
      if (kept !== null) await release(kept);
      return kept === null ? { ports } : { ports, replaced: kept };
    },

    async heldLocalState(): Promise<string[]> {
      return await heldApplications(stateDir);
    },

    async removeLocalState(application: string): Promise<void> {
      const kept = await readPortsFile(portsPath(stateDir, application));
      await rm(celldStateDirs(stateDir, application).root, { recursive: true, force: true });
      /* After the directory, so a release recorded for an application still
         holding its file cannot outlive a removal that failed half way. */
      if (kept !== null) await release(kept);
    },

    async ready(input): Promise<boolean> {
      const url = `http://${input.host}:${String(input.port)}${APP_HEALTH_PATH}`;
      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
      } catch {
        /* A refused connection is the ordinary answer for a process that has not
           opened its listener yet, and a timeout is one that opened it and is
           not answering on it: neither is a failure of the pass asking. */
        return false;
      }
      /* Read to completion so the connection is not left hanging on a keep-alive
         socket this node will never speak on again. */
      await response.text().catch(() => "");
      return response.ok;
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

/** One quarantined port and the moment it was released, in epoch milliseconds. */
interface ReleasedPort {
  port: number;
  at: number;
}

/** Where one application's ports are kept. */
function portsPath(stateDir: string, application: string): string {
  return join(celldStateDirs(stateDir, application).root, PORTS_FILE);
}

/** Where the ports released on this node are kept. */
function releasedPath(stateDir: string): string {
  return join(stateDir, STATE_SUBDIR, RELEASED_FILE);
}

/** Applications this node holds a directory for; anything else under it is not ours. */
async function heldApplications(stateDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(stateDir, STATE_SUBDIR), { withFileTypes: true });
  } catch (error) {
    /* Nothing has run on this node yet, which is not a failure of the pass
       asking. Anything else is, and is raised. */
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isSlug(entry.name))
    .map((entry) => entry.name);
}

/**
 * The pair a file names, or `null` when there is none to read.
 *
 * A FILE THAT DOES NOT SAY A PAIR IS NO PAIR. It is absent, truncated by a
 * machine that lost power mid-write, or something else entirely; in every one of
 * those cases the honest answer is that this node does not know what ports the
 * application had, and the caller chooses a new pair and writes it down. The
 * alternative — refusing to start the application until somebody deletes a
 * file — trades a moved port for an outage.
 */
async function readPortsFile(path: string): Promise<PortPair | null> {
  const parsed = await readJsonFile(path);
  if (parsed === null) return null;
  const record = parsed as { public?: unknown; internal?: unknown };
  if (!isPort(record.public) || !isPort(record.internal)) return null;
  if (record.public === record.internal) return null;
  return { public: record.public, internal: record.internal };
}

/** The quarantine a file names; an unreadable one quarantines nothing. */
async function readReleasedFile(path: string): Promise<ReleasedPort[]> {
  const parsed = await readJsonFile(path);
  const entries = (parsed as { released?: unknown } | null)?.released;
  if (!Array.isArray(entries)) return [];

  const released: ReleasedPort[] = [];
  for (const entry of entries as { port?: unknown; at?: unknown }[]) {
    const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
    if (!isPort(entry.port) || Number.isNaN(at)) continue;
    released.push({ port: entry.port, at });
  }
  return released;
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Writes JSON where a reader only ever sees a whole document: into a temporary
 * file beside the target, then renamed over it, which is atomic within a
 * directory. A node that loses power mid-write comes back to the previous
 * document or to none, never to half of one.
 */
async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: PRIVATE_FILE_MODE });
  await rename(temporary, path);
}

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

/**
 * Whether `port` can be bound on `host` at this instant: the only answer worth
 * having, because the range is this node's by convention and anything at all on
 * the machine may be listening in it.
 *
 * Bound exclusively, so a port another process is sharing through
 * `SO_REUSEPORT` reads as taken rather than as free, and closed again at once.
 */
async function bindableNow(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
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

/**
 * How long a process has to answer that it is serving before this pass takes the
 * silence for an answer.
 *
 * SHORTER THAN THE RELOAD, and shorter still than the reconcile interval: the
 * question is asked of every process that has not answered yet, on a loopback
 * socket, and the cost of waiting is a pass that does nothing else in the
 * meantime. A process that is up answers this in microseconds; one that is not
 * will not answer it in two seconds either, and the next pass asks again.
 */
const READY_TIMEOUT_MS = 2000;

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
  dirs: { work: string; assets: string },
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

  /* The identity this process comes back under, and the directories it comes
     back to: what makes an acknowledged write recoverable. See
     `RuntimeNodeInput.id` and {@link celldStateDirs}. */
  env.CELLD_NODE = input.node.id;
  env.CELLD_WATCH = dirs.work;
  env.CELLD_ASSET_CACHE_DIR = dirs.assets;

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
