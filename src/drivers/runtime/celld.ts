/*
 * Runtime driver for celld 0.4.0: one environment-owned process and its
 * start-time configuration. Celld owns deployment adoption, application
 * readiness and runtime resource policy.
 */

import { ScafoError } from "../../core/error.ts";
import { formatProcessId } from "../../core/placement/ids.ts";
import { fleetPrefix } from "../../core/registry/paths.ts";
import type { RuntimeDriver, RuntimeSpecInput } from "../../core/types/runtime.ts";
import type { ProcessSpec } from "../../core/types/supervisor.ts";

/** Command run when the caller does not name one. */
export const DEFAULT_CELLD_BIN: string = "celld";

/**
 * Address a runtime process binds its listeners to when the caller names none.
 *
 * Loopback, because it is the only setting that is safe without knowing the
 * network: the peer listener carries no authentication of its own, so binding it
 * wider is a decision an operator makes about a network they have classified,
 * never a default.
 */
export const DEFAULT_BIND_HOST: string = "127.0.0.1";

/** celld 0.4.0's complete process shutdown bound when the operator does not set one. */
export const DEFAULT_CELLD_SHUTDOWN_TOTAL_MS: number = 40_000;

/** Time kept between celld's complete shutdown bound and the supervisor's hard kill. */
const STOP_HEADROOM_MS = 5_000;

/** Largest delay Node timers can represent without overflowing to an immediate timeout. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The runtime's own telemetry switch, and the ONE name that is neither derived
 * here nor reserved from a caller.
 *
 * It is exported for the same reason the reserved names are — so that whatever
 * turns a node's observability on can default it UNDER the operator's own
 * `runtime.celldEnv` without the two spellings ever drifting apart — and it is
 * absent from {@link RESERVED_ENV} on purpose: an operator who states it
 * themselves, on or off, wins over that default.
 */
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
  /* Derived from the ingress topology: a caller silently winning over it would
     undo the node's trust decision. */
  "CELLD_TRUST_FORWARDED_HEADERS",
  "CELLD_VARS_FILE",
];

/** Variables one environment may not use to change node-wide Celld policy. */
export const RESERVED_ENV: string[] = [
  ...OPERATOR_RESERVED_ENV,
  "CELLD_SHUTDOWN_DRAIN_MS",
  "CELLD_SHUTDOWN_TOTAL_MS",
  "CELLD_DURABILITY",
  "CELLD_IDLE_EVICT_S",
  "CELLD_LTX_S3_BUCKET",
  "CELLD_LTX_S3_ENDPOINT",
  "CELLD_NODE",
  "CELLD_CLOUD",
  "CELLD_CONTROL_URL",
  "CELLD_UNSAFE_PUBLIC_ADVERTISE",
];

export interface CelldDriverOptions {
  /** Executable to run; resolved against `PATH` unless it is a path. */
  binPath?: string;
  /**
   * Variables the operator hands EVERY process this driver spawns, on top of
   * the environment it is given and under everything the driver writes itself.
   * The runtime's own switches are what this is for — `CELLD_OTEL` and the
   * `CELLD_OTEL_*` tuning above all — since no typed option carries them and
   * the environment a node starts from is a narrow allowlist.
   *
   * Node-wide policy names in {@link RESERVED_ENV} are allowed here. Values the
   * driver must derive are overwritten; settings Celld owns, including its
   * shutdown and resource limits, pass through.
   */
  operatorEnv?: Record<string, string>;
}

/**
 * Builds the driver that runs environments as celld processes.
 *
 * Throws `ScafoError("invalid-input")` when the operator's
 * `CELLD_SHUTDOWN_TOTAL_MS` is not a positive integer the supervisor can time.
 */
export function createCelldDriver(opts: CelldDriverOptions): RuntimeDriver {
  const binPath = opts.binPath ?? DEFAULT_CELLD_BIN;
  const operatorEnv = opts.operatorEnv === undefined ? undefined : { ...opts.operatorEnv };
  const shutdownTotalMs = parseShutdownTotalMs(operatorEnv?.CELLD_SHUTDOWN_TOTAL_MS);

  return {
    stopGraceMs: shutdownTotalMs + STOP_HEADROOM_MS,

    processSpec(input: RuntimeSpecInput): ProcessSpec {
      const fleet = fleetPrefix(input.project, input.env.name);
      const objectPrefix = joinPrefix(input.node.keyPrefix, fleet);
      /* Both listeners bind the same address: the public one is dialled by this
         node's ingress and the internal one by peers, and a process reachable at
         its advertised address must actually be listening on it. */
      const bindHost = input.node.bindHost ?? DEFAULT_BIND_HOST;
      const listen = `${bindHost}:${String(input.ports.public)}`;
      const internalListen = `${bindHost}:${String(input.ports.internal)}`;

      return {
        id: formatProcessId({ project: input.project, env: input.env.name }),
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
  };
}

/** Environment of one runtime process, in the order the parts override each other. */
function processEnv(
  input: RuntimeSpecInput,
  operatorEnv?: Record<string, string>,
): Record<string, string> {
  /*
   * Precedence, weakest first: the environment the daemon was started from, then
   * the variables the operator handed this node, then everything this driver
   * derives — credentials and forwarded-header trust — then the environment's
   * varset and caller extras.
   * The driver's half is written AFTER the operator's on purpose: those values
   * come from the node's configuration and from the ports these processes
   * actually bound, so a variable that disagreed with them could only describe a
   * process that does not exist. `RESERVED_ENV` is that half, by name.
   */
  const env: Record<string, string> = { ...input.baseEnv, ...operatorEnv };

  env.AWS_ACCESS_KEY_ID = input.node.accessKey;
  env.AWS_SECRET_ACCESS_KEY = input.node.secretKey;
  env.AWS_REGION = input.node.region;

  /* The node is reached through an ingress that terminates TLS and rewrites
     both forwarded headers, so the application sees its own public origin. */
  env.CELLD_TRUST_FORWARDED_HEADERS = "1";

  /* A node configures each environment through its own CELLD_VAR_* entries.
     An inherited shared file would merge unrelated configuration into it. */
  delete env.CELLD_VARS_FILE;

  /* The name after the prefix becomes the binding name verbatim, so a variable
     reaches the application under exactly the name the varset gave it. */
  for (const [name, entry] of Object.entries(input.vars ?? {})) {
    if (name !== "") env[`CELLD_VAR_${name}`] = entry.value;
  }

  Object.assign(env, checkedExtraEnv(input.extraEnv));

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

/** Refuses what a caller may not set, and passes the rest through. */
function checkedExtraEnv(extraEnv?: Record<string, string>): Record<string, string> {
  if (extraEnv === undefined) return {};

  const reserved = RESERVED_ENV.filter((name) => name in extraEnv);
  if (reserved.length > 0) {
    throw new ScafoError("invalid-input", "Reserved environment variable", {
      detail:
        `${reserved.join(", ")} is derived by the driver or reserved for node-wide ` +
        `Celld policy, and cannot be set by one environment`,
    });
  }
  return extraEnv;
}

/** Joins the installation's key prefix to a fleet prefix. */
function joinPrefix(keyPrefix: string | undefined, fleet: string): string {
  const trimmed = keyPrefix?.replaceAll(/^\/+|\/+$/g, "") ?? "";
  return trimmed === "" ? fleet : `${trimmed}/${fleet}`;
}
