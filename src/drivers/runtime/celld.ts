/* Materializes one environment-owned Celld process and its start-time config. */

import { ScafoError } from "../../core/error.ts";
import { formatProcessId } from "../../core/placement/ids.ts";
import { fleetPrefix } from "../../core/registry/paths.ts";
import type { RuntimeDriver, RuntimeSpecInput } from "../../core/types/runtime.ts";
import type { ProcessSpec } from "../../core/types/supervisor.ts";

/** Command run when the caller does not name one. */
export const DEFAULT_CELLD_BIN: string = "celld";

/** Default loopback bind; wider peer exposure requires an explicit network decision. */
export const DEFAULT_BIND_HOST: string = "127.0.0.1";

/** celld 0.4.1's complete process shutdown bound when the operator does not set one. */
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
  /* Derived from ingress topology, not environment input. */
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
      const fleet = fleetPrefix(input.project, input.env.name);
      const objectPrefix = joinPrefix(input.node.keyPrefix, fleet);
      /* Both listeners bind the node's bind host; peers are told the advertise
         host below, and the two are only the same thing when nothing sits between
         them — the tunnel case is what keeps them apart. */
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
  /* Base environment, then node configuration; derived variables cannot be
     overridden by an environment. */
  const env: Record<string, string> = { ...input.baseEnv, ...operatorEnv };

  env.AWS_ACCESS_KEY_ID = input.node.accessKey;
  env.AWS_SECRET_ACCESS_KEY = input.node.secretKey;
  env.AWS_REGION = input.node.region;

  /* The node ingress terminates TLS and supplies forwarded headers. */
  env.CELLD_TRUST_FORWARDED_HEADERS = "1";

  /* A shared inherited vars file could merge unrelated environment settings. */
  delete env.CELLD_VARS_FILE;

  /* Preserve each varset name after the Celld variable prefix. */
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

/** Rejects environment-scoped overrides of node-wide or derived values. */
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
