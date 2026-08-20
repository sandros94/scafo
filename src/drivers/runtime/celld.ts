/*
 * Runtime driver for celld 0.2.x: the process that serves an environment's
 * cells, the pointer that decides which version it loads, and the gate that
 * says when it may take traffic.
 */

import { ScafoError } from "../../core/error.ts";
import { formatProcessId } from "../../core/placement/ids.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { fleetPrefix } from "../../core/registry/paths.ts";
import type { CasStore } from "../../core/types/store.ts";
import type {
  ProbeOptions,
  RuntimeDriver,
  RuntimeProcess,
  RuntimeSpecInput,
} from "../../core/types/runtime.ts";
import type { ProcessSpec } from "../../core/types/supervisor.ts";
import { withRetry } from "../../core/utils/backoff.ts";
import {
  deployPointerKey,
  pointAtVersion,
  readFleetPointer,
  scriptNameOf,
  versionPrefix,
} from "./_deploy-pointer.ts";

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

/** Path the runtime answers its own health on; every other path belongs to the application. */
export const HEALTH_PATH: string = "/__celld/health";

/** Times the readiness gate is tried, and the wait between attempts. */
const DEFAULT_PROBE_ATTEMPTS = 60;
const DEFAULT_PROBE_DELAY_MS = 250;

/** Status the application-level probe must stay below when none is configured. */
const DEFAULT_EXPECT_BELOW = 500;

/** How far the drain is kept below the stop grace, and the shortest drain worth having. */
const DRAIN_HEADROOM_MS = 5_000;
const MIN_DRAIN_MS = 5_000;

/**
 * Idle eviction stays off until enabling it is a policy, not a variable.
 *
 * celld 0.3.0 — the oldest runtime this driver supports — made idle eviction
 * safe (0.2.x corrupted an evicted cell's replication chain and rolled back
 * acknowledged writes; denoland/celld#158). Safe is not the same as wanted:
 * when cells are evicted, and how that composes with placement and readiness,
 * is a decision this driver must make coherently for the whole node, so it
 * never sets the variable, refuses a caller that tries to, and drops it from
 * the environment it inherits — until typed configuration says otherwise.
 */
const IDLE_EVICT_ENV = "CELLD_IDLE_EVICT_S";

/**
 * Variables this driver derives from the spec it is given. They are the
 * environment spellings of settings it pins on the command line, or credentials
 * that come from the node's own configuration; letting a caller pass them in
 * would let the two disagree about where a process reads its fleet from, what
 * it listens on, or how long it may drain.
 */
const RESERVED_ENV: string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "CELLD_BUCKET",
  "CELLD_ADDR",
  "CELLD_INTERNAL_ADDR",
  "CELLD_ADVERTISE",
  "CELLD_SHUTDOWN_DRAIN_MS",
  /* Derived from the capacity plan and the ingress topology: a caller silently
     winning over them would undo the node's own resource and trust decisions.
     Tuning them belongs in typed configuration, not a raw variable. */
  "CELLD_MAX_RSS_MB",
  "CELLD_MAX_RESIDENT_CELLS",
  "CELLD_TRUST_FORWARDED_HEADERS",
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
   * Store over the bucket the fleets live in, with the same key prefix the rest
   * of this installation uses. Activation reads and writes celld's deployment
   * pointer through it.
   */
  store: CasStore;
  /**
   * Grace a caller gives one of these processes between `SIGTERM` and `SIGKILL`.
   * The drain configured on the process is derived from it and always stays
   * below it, so a process finishes draining before it is killed. Must leave
   * room for the shortest useful drain.
   */
  graceMs?: number;
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
  const ctx: RegistryContext = { store: opts.store };

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
        id: formatProcessId({
          project: input.project,
          env: input.env.name,
          build: input.build.id,
        }),
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
        env: processEnv(input, drainMs),
      };
    },

    async activateVersion(prefix: string, celldVersionId: string): Promise<void> {
      const fleetKey = deployPointerKey(prefix);
      const current = await readFleetPointer(ctx, prefix);
      const script = scriptNameOf(current.value, fleetKey);

      await assertVersionUploaded(ctx, prefix, script, celldVersionId);

      /*
       * celld writes the named pointer before the fleet-wide one, so a writer
       * that loses the race loses it on the object that actually selects the
       * application rather than half-way through. Activation keeps that order.
       */
      const template = current.value;
      const write = async (key: string): Promise<void> => {
        await withRetry(() =>
          pointAtVersion(ctx, key, { script, version: celldVersionId, template }),
        );
      };
      await write(deployPointerKey(prefix, script));
      await write(fleetKey);
    },

    async probeReady(process: RuntimeProcess, probe?: ProbeOptions): Promise<boolean> {
      const fetchFn = probe?.fetchFn ?? globalThis.fetch;
      const attempts = Math.max(1, probe?.attempts ?? DEFAULT_PROBE_ATTEMPTS);
      const delayMs = probe?.delayMs ?? DEFAULT_PROBE_DELAY_MS;
      const expectBelow = probe?.expectBelow ?? DEFAULT_EXPECT_BELOW;
      const path = probe?.path ?? "/";
      const origin = `http://127.0.0.1:${String(process.port)}`;

      for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) await delay(delayMs);

        /*
         * Both signals are required. The runtime answers its health endpoint
         * from the process itself, so a process whose application fails every
         * single request still reports 200 there; and a process on its way out
         * answers the health endpoint while refusing everything else. Neither
         * check alone distinguishes "serving" from "running".
         */
        if ((await statusOf(fetchFn, `${origin}${HEALTH_PATH}`)) !== 200) continue;

        const app = await statusOf(fetchFn, `${origin}${path.startsWith("/") ? path : `/${path}`}`);
        if (app !== null && app < expectBelow) return true;
      }
      return false;
    },
  };
}

/** Environment of one runtime process, in the order the parts override each other. */
function processEnv(input: RuntimeSpecInput, drainMs: number): Record<string, string> {
  const env: Record<string, string> = { ...input.baseEnv };

  env.AWS_ACCESS_KEY_ID = input.node.accessKey;
  env.AWS_SECRET_ACCESS_KEY = input.node.secretKey;
  env.AWS_REGION = input.node.region;

  /* Rule: the drain must fit inside the stop grace, or a draining process is
     killed mid-flight and its in-progress requests die with it. */
  env.CELLD_SHUTDOWN_DRAIN_MS = String(drainMs);

  /* The node is reached through an ingress that terminates TLS and rewrites
     both forwarded headers, so the application sees its own public origin. */
  env.CELLD_TRUST_FORWARDED_HEADERS = "1";

  /* An acknowledged write is in the bucket, not merely on a peer's disk.
     celld 0.3.0 flipped its default to `fleet` (ack at follower fsync, bucket
     upload behind); on one node the two are identical, on a fleet they are
     not, and a node whose bucket may lag its acks breaks the recovery
     assumption everything above this driver builds on. Opting a fleet into
     write-behind is a typed-configuration decision, not a default. */
  env.CELLD_DURABILITY = "bucket";

  const capacity = input.capacity;
  if (capacity !== undefined) {
    /* Zero means "unbounded" to the runtime, so a degenerate budget is left
       to the runtime's own default rather than written as no limit at all. */
    if (capacity.maxRssMbPerProcess >= 1) {
      env.CELLD_MAX_RSS_MB = String(capacity.maxRssMbPerProcess);
    }
    if (capacity.maxResidentCells >= 1) {
      env.CELLD_MAX_RESIDENT_CELLS = String(capacity.maxResidentCells);
    }
  }

  /* The name after the prefix becomes the binding name verbatim, so a variable
     reaches the application under exactly the name the varset gave it. */
  for (const [name, entry] of Object.entries(input.vars ?? {})) {
    if (name !== "") env[`CELLD_VAR_${name}`] = entry.value;
  }

  Object.assign(env, checkedExtraEnv(input.extraEnv));

  /* Last word on idle eviction, whatever the inherited environment carried. */
  delete env[IDLE_EVICT_ENV];
  return env;
}

/** Refuses what a caller may not set, and passes the rest through. */
function checkedExtraEnv(extraEnv?: Record<string, string>): Record<string, string> {
  if (extraEnv === undefined) return {};

  if (IDLE_EVICT_ENV in extraEnv) {
    throw new ScafoError("invalid-input", "Idle eviction cannot be enabled", {
      detail:
        `"${IDLE_EVICT_ENV}" must not be set: in this runtime version, evicting an ` +
        `idle cell corrupts its replication chain in the bucket and rolls back writes ` +
        `that were already acknowledged to the client`,
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

/**
 * Refuses to point a fleet at a version whose modules are not in the bucket: the
 * pointer is read once, while a process starts, so a wrong one is only found out
 * by the next process that fails to boot.
 */
async function assertVersionUploaded(
  ctx: RegistryContext,
  prefix: string,
  script: string,
  version: string,
): Promise<void> {
  const key = `${prefix}/${versionPrefix(script, version)}/manifest.json`;
  if ((await ctx.store.get(key)) === null) {
    throw new ScafoError("not-found", "Version was never uploaded", {
      detail: `"${key}" does not exist, so version "${version}" cannot be activated`,
    });
  }
}

/** Joins the installation's key prefix to a fleet prefix. */
function joinPrefix(keyPrefix: string | undefined, fleet: string): string {
  const trimmed = keyPrefix?.replaceAll(/^\/+|\/+$/g, "") ?? "";
  return trimmed === "" ? fleet : `${trimmed}/${fleet}`;
}

/** Status of one probe request; null when the request itself did not complete. */
async function statusOf(fetchFn: typeof fetch, url: string): Promise<number | null> {
  try {
    const response = await fetchFn(url, { redirect: "manual" });
    /* Nothing reads the body, and an unread one holds the connection open. */
    await response.body?.cancel();
    return response.status;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
