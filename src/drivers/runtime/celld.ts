/*
 * Runtime driver for celld: one environment-owned process and its start-time
 * configuration. Celld owns deployment adoption and application readiness.
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

/** Time a stopped runtime process is given between `SIGTERM` and `SIGKILL`. */
export const DEFAULT_STOP_GRACE_MS: number = 30_000;

/** How far the drain is kept below the stop grace, and the shortest drain worth having. */
const DRAIN_HEADROOM_MS = 5_000;
const MIN_DRAIN_MS = 5_000;

/**
 * Idle eviction is a node policy, never a variable.
 *
 * celld 0.3.0 — the oldest runtime this driver supports — made idle eviction
 * safe (0.2.x corrupted an evicted cell's replication chain and rolled back
 * acknowledged writes; denoland/celld#158). The age now comes from the
 * driver's `cellIdleEvictS` option and nowhere else: the variable is refused
 * from a caller and dropped from the inherited environment, so every process
 * on a node evicts on the one clock its operator configured.
 */
export const IDLE_EVICT_ENV: string = "CELLD_IDLE_EVICT_S";

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
 * Variables this driver derives from the spec it is given. They are the
 * environment spellings of settings it pins on the command line, or credentials
 * that come from the node's own configuration; letting a caller pass them in
 * would let the two disagree about where a process reads its fleet from, what
 * it listens on, or how long it may drain.
 *
 * Exported because whatever CONFIGURES a node's extra variables must refuse
 * these by name, at the point they are written rather than at the process that
 * would have ignored them. {@link IDLE_EVICT_ENV} belongs to the driver on the
 * same terms and is listed separately only because its refusal names the setting
 * that does carry it.
 */
export const RESERVED_ENV: string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "CELLD_BUCKET",
  "CELLD_ADDR",
  "CELLD_INTERNAL_ADDR",
  "CELLD_ADVERTISE",
  "CELLD_SHUTDOWN_DRAIN_MS",
  /* Derived from the ingress topology: a caller silently winning over it would
     undo the node's trust decision. */
  "CELLD_TRUST_FORWARDED_HEADERS",
  "CELLD_VARS_FILE",
  /* The durability posture, the replication destination, the node's session
     identity and its control plane decide when a write is called durable and
     who may restart the process — the node's decisions, never a deploy's. */
  "CELLD_DURABILITY",
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
   * Grace a caller gives one of these processes between `SIGTERM` and `SIGKILL`.
   * The drain configured on the process is derived from it and always stays
   * below it, so a process finishes draining before it is killed. Must leave
   * room for the shortest useful drain.
   */
  graceMs?: number;
  /**
   * When a runtime process calls a write durable: `"bucket"` (the default)
   * acknowledges once the write is in the bucket, `"fleet"` at follower fsync
   * with the bucket upload behind. The trade is the operator's to make in
   * typed configuration — this is the only door; the raw variable is refused.
   */
  durability?: "bucket" | "fleet";
  /**
   * Seconds a cell may sit idle before its process evicts it from memory;
   * absent or `0`, cells are never evicted for being idle. Transparent to the
   * application — state is in the bucket, the next request restores it.
   */
  cellIdleEvictS?: number;
  /**
   * Variables the operator hands EVERY process this driver spawns, on top of
   * the environment it is given and under everything the driver writes itself.
   * The runtime's own switches are what this is for — `CELLD_OTEL` and the
   * `CELLD_OTEL_*` tuning above all — since no typed option carries them and
   * the environment a node starts from is a narrow allowlist.
   *
   * A name in {@link RESERVED_ENV} put here is OVERWRITTEN rather than refused:
   * the driver derives those from the node's configuration and from the ports
   * its processes actually bound. Runtime policy such as `CELLD_MAX_RSS_MB`
   * remains operator-owned and therefore is not reserved.
   */
  operatorEnv?: Record<string, string>;
}

/**
 * Builds the driver that runs environments as celld processes.
 *
 * Throws `ScafoError("invalid-input")` when `graceMs` is too short to contain a
 * drain.
 */
export function createCelldDriver(opts: CelldDriverOptions): RuntimeDriver {
  const binPath = opts.binPath ?? DEFAULT_CELLD_BIN;
  const graceMs = opts.graceMs ?? DEFAULT_STOP_GRACE_MS;
  const durability = opts.durability ?? "bucket";
  const cellIdleEvictS = opts.cellIdleEvictS ?? 0;

  if (!Number.isInteger(graceMs) || graceMs < MIN_DRAIN_MS + DRAIN_HEADROOM_MS) {
    throw new ScafoError("invalid-input", "Stop grace is too short", {
      detail:
        `"graceMs" must be a whole number of at least ` +
        `${String(MIN_DRAIN_MS + DRAIN_HEADROOM_MS)} ms so a process can drain ` +
        `before it is killed, got ${String(graceMs)}`,
    });
  }
  const drainMs = Math.max(MIN_DRAIN_MS, graceMs - DRAIN_HEADROOM_MS);

  return {
    stopGraceMs: graceMs,

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
        env: processEnv(input, {
          drainMs,
          durability,
          cellIdleEvictS,
          ...(opts.operatorEnv === undefined ? {} : { operatorEnv: opts.operatorEnv }),
        }),
      };
    },
  };
}

/** What the driver's own options put into every process it spawns. */
interface EnvSettings {
  drainMs: number;
  durability: "bucket" | "fleet";
  cellIdleEvictS: number;
  operatorEnv?: Record<string, string>;
}

/** Environment of one runtime process, in the order the parts override each other. */
function processEnv(input: RuntimeSpecInput, settings: EnvSettings): Record<string, string> {
  /*
   * Precedence, weakest first: the environment the daemon was started from, then
   * the variables the operator handed this node, then everything this driver
   * derives — credentials, drain, forwarded-header trust and durability — then
   * the environment's own varset, and idle eviction last of all.
   * The driver's half is written AFTER the operator's on purpose: those values
   * come from the node's configuration and from the ports these processes
   * actually bound, so a variable that disagreed with them could only describe a
   * process that does not exist. `RESERVED_ENV` is that half, by name.
   */
  const env: Record<string, string> = { ...input.baseEnv, ...settings.operatorEnv };

  env.AWS_ACCESS_KEY_ID = input.node.accessKey;
  env.AWS_SECRET_ACCESS_KEY = input.node.secretKey;
  env.AWS_REGION = input.node.region;

  /* Rule: the drain must fit inside the stop grace, or a draining process is
     killed mid-flight and its in-progress requests die with it. */
  env.CELLD_SHUTDOWN_DRAIN_MS = String(settings.drainMs);

  /* The node is reached through an ingress that terminates TLS and rewrites
     both forwarded headers, so the application sees its own public origin. */
  env.CELLD_TRUST_FORWARDED_HEADERS = "1";

  /* Always written, never inherited: which acknowledgement counts as durable
     must come from this installation's configuration, not from whatever the
     runtime's own default is this release — celld 0.3.0 flipped its to
     `fleet` (ack at follower fsync, bucket upload behind). On one node the
     two are identical; on a fleet they are the RPO trade the operator made. */
  env.CELLD_DURABILITY = settings.durability;

  /* A node configures each environment through its own CELLD_VAR_* entries.
     An inherited shared file would merge unrelated configuration into it. */
  delete env.CELLD_VARS_FILE;

  /* The name after the prefix becomes the binding name verbatim, so a variable
     reaches the application under exactly the name the varset gave it. */
  for (const [name, entry] of Object.entries(input.vars ?? {})) {
    if (name !== "") env[`CELLD_VAR_${name}`] = entry.value;
  }

  Object.assign(env, checkedExtraEnv(input.extraEnv));

  /* Last word on idle eviction, whatever the inherited environment carried:
     the node's one clock, or nothing at all. */
  delete env[IDLE_EVICT_ENV];
  if (settings.cellIdleEvictS > 0) env[IDLE_EVICT_ENV] = String(settings.cellIdleEvictS);
  return env;
}

/** Refuses what a caller may not set, and passes the rest through. */
function checkedExtraEnv(extraEnv?: Record<string, string>): Record<string, string> {
  if (extraEnv === undefined) return {};

  if (IDLE_EVICT_ENV in extraEnv) {
    throw new ScafoError("invalid-input", "Idle eviction is not set this way", {
      detail:
        `"${IDLE_EVICT_ENV}" must not be set by a caller: cells on a node evict on ` +
        `the one clock its operator configured, "runtime.cellIdleEvictS"`,
    });
  }

  const reserved = RESERVED_ENV.filter((name) => name in extraEnv);
  if (reserved.length > 0) {
    throw new ScafoError("invalid-input", "Reserved environment variable", {
      detail:
        `${reserved.join(", ")} is derived from the node's configuration and the ` +
        `process's own listeners, and cannot be set by a caller`,
    });
  }
  return extraEnv;
}

/** Joins the installation's key prefix to a fleet prefix. */
function joinPrefix(keyPrefix: string | undefined, fleet: string): string {
  const trimmed = keyPrefix?.replaceAll(/^\/+|\/+$/g, "") ?? "";
  return trimmed === "" ? fleet : `${trimmed}/${fleet}`;
}
