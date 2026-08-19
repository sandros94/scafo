/*
 * Agent configuration, merged from a JSONC file, the environment and the command
 * line — each source overriding the one before it.
 *
 * The loader is runtime-agnostic: reading files is injected by the caller (the
 * CLI hands in a reader backed by `node:fs`), so nothing here imports a runtime.
 */

import { type JSONCParseError, parseJSONC } from "confbox";
import { ScaloError } from "../core/error.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import { assertHost, isHost } from "../core/utils/host.ts";

export interface AgentConfig {
  bucket: {
    endpoint: string;
    region: string;
    bucket: string;
    /** Key prefix every registry object lives under, for sharing one bucket. */
    prefix?: string;
    accessKey: string;
    secretKey: string;
  };
  node: {
    id: string;
    /** `host:port` the agent API binds to. */
    listen: string;
    /** `host:port` reserved for node-to-node traffic, when it is separate. */
    internalListen?: string;
    /** `host:port` other nodes should reach this one at, when it differs from the listener. */
    advertise?: string;
  };
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
}

export interface LoadConfigOptions {
  /** Config file to read; defaults to {@link DEFAULT_CONFIG_PATHS}, first readable wins. */
  configPath?: string;
  /** Command-line flags, keyed by their kebab-case name (`access-key`). */
  flags?: Record<string, string | undefined>;
  /** Environment to read; pass `process.env`. Defaults to no environment at all. */
  env?: Record<string, string | undefined>;
  /** Reads a file as text, resolving null when it does not exist. */
  readFile?: (path: string) => Promise<string | null>;
}

/** Config files looked for when no path is given, in order of preference. */
export const DEFAULT_CONFIG_PATHS: string[] = ["./scalo.config.jsonc", "./scalo.config.json"];

/** Signing region used when none is configured; harmless for stores that ignore it. */
export const DEFAULT_REGION: string = "us-east-1";

/** Loopback by default: the agent API is only safe on a trusted network. */
export const DEFAULT_LISTEN: string = "127.0.0.1:7400";

/** A `host:port` pair, as written for a listener or an advertised address. */
export interface HostPort {
  host: string;
  port: number;
}

/**
 * Reads the configuration a node agent starts from.
 *
 * Throws `ScaloError("invalid-input")` when a required setting has no value in
 * any source, or when an address, a node id or a platform domain is malformed.
 */
export async function loadAgentConfig(opts?: LoadConfigOptions): Promise<AgentConfig> {
  const sources: Sources = {
    flags: opts?.flags ?? {},
    env: opts?.env ?? {},
    file: await readConfigFile(opts),
  };

  const listen = resolve("listen", sources) ?? DEFAULT_LISTEN;
  const internalListen = resolve("internalListen", sources);
  const advertise = resolve("advertise", sources);
  const id = resolve("nodeId", sources) ?? randomNodeId();

  /* Parsed for their side effect: an unusable address must fail the boot, not
     the first request that tries to use it. */
  parseHostPort(listen, ORIGINS.listen.file);
  if (internalListen !== undefined) parseHostPort(internalListen, ORIGINS.internalListen.file);
  if (advertise !== undefined) parseHostPort(advertise, ORIGINS.advertise.file);
  assertNodeId(id);

  return {
    bucket: {
      endpoint: required("endpoint", sources),
      region: resolve("region", sources) ?? DEFAULT_REGION,
      bucket: required("bucket", sources),
      prefix: resolve("prefix", sources),
      accessKey: required("accessKey", sources),
      secretKey: required("secretKey", sources),
    },
    node: { id, listen, internalListen, advertise },
    platformDomains: resolvePlatformDomains(sources),
  };
}

/**
 * Splits `host:port`. IPv6 literals must be bracketed the way a URL authority
 * writes them (`[::1]:7400`); every other host is a DNS name or an IPv4 address.
 *
 * Throws `ScaloError("invalid-input")` naming `field` when the value is not one.
 */
export function parseHostPort(value: string, field: string): HostPort {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const bracketed = match?.[1];
  const host = bracketed ?? match?.[2];
  const port = Number(match?.[3]);

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ScaloError("invalid-input", "Invalid address", {
      detail: `"${field}" must be "host:port" with a port in 1-65535, got "${value}"`,
    });
  }
  /* A bracketed literal is taken as given; anything else must be a DNS name or
     an IPv4 address, both of which are plain lowercase labels. */
  if (bracketed === undefined && !isHost(host)) {
    throw new ScaloError("invalid-input", "Invalid address", {
      detail: `"${field}" has host "${host}", which is not a lowercase DNS name or IPv4 address`,
    });
  }
  return { host, port };
}

/** Where one setting may come from, in the order the sources are consulted. */
interface Origin {
  /** Command-line flag, without the leading dashes. */
  flag: string;
  /** Environment variables, most specific first. */
  env: string[];
  /** Dotted path of the config file key. */
  file: string;
}

/**
 * Every configurable setting and the sources that can carry it. The `AWS_*` and
 * `S3_*` names are accepted below the `SCALO_*` ones so a shell already set up
 * for the bucket works, without letting it override an explicit scalo setting.
 */
const ORIGINS = {
  endpoint: {
    flag: "endpoint",
    env: ["SCALO_S3_ENDPOINT", "S3_ENDPOINT"],
    file: "bucket.endpoint",
  },
  region: { flag: "region", env: ["SCALO_S3_REGION", "AWS_REGION"], file: "bucket.region" },
  bucket: { flag: "bucket", env: ["SCALO_S3_BUCKET"], file: "bucket.bucket" },
  prefix: { flag: "prefix", env: ["SCALO_S3_PREFIX"], file: "bucket.prefix" },
  accessKey: {
    flag: "access-key",
    env: ["SCALO_S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID"],
    file: "bucket.accessKey",
  },
  secretKey: {
    flag: "secret-key",
    env: ["SCALO_S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"],
    file: "bucket.secretKey",
  },
  nodeId: { flag: "node-id", env: ["SCALO_NODE_ID"], file: "node.id" },
  listen: { flag: "listen", env: ["SCALO_LISTEN"], file: "node.listen" },
  internalListen: {
    flag: "internal-listen",
    env: ["SCALO_INTERNAL_LISTEN"],
    file: "node.internalListen",
  },
  advertise: { flag: "advertise", env: ["SCALO_ADVERTISE"], file: "node.advertise" },
  platformDomains: {
    flag: "platform-domains",
    env: ["SCALO_PLATFORM_DOMAINS"],
    file: "platformDomains",
  },
} satisfies Record<string, Origin>;

type Setting = keyof typeof ORIGINS;

interface Sources {
  flags: Record<string, string | undefined>;
  env: Record<string, string | undefined>;
  file: Record<string, unknown> | undefined;
}

function resolve(setting: Setting, sources: Sources): string | undefined {
  const origin: Origin = ORIGINS[setting];
  return flagOrEnv(origin, sources) ?? text(fileValue(sources.file, origin.file));
}

function flagOrEnv(origin: Origin, sources: Sources): string | undefined {
  const flag = text(sources.flags[origin.flag]);
  if (flag !== undefined) return flag;
  for (const variable of origin.env) {
    const value = text(sources.env[variable]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function required(setting: Setting, sources: Sources): string {
  const value = resolve(setting, sources);
  if (value !== undefined) return value;

  const origin: Origin = ORIGINS[setting];
  throw new ScaloError("invalid-input", "Missing required configuration", {
    detail:
      `"${origin.file}" has no value: set it in the config file, ` +
      `set ${origin.env.join(" or ")} in the environment, or pass --${origin.flag}`,
  });
}

function resolvePlatformDomains(sources: Sources): string[] {
  const origin: Origin = ORIGINS.platformDomains;
  const inline = flagOrEnv(origin, sources);
  const domains =
    inline === undefined
      ? fileStringList(sources.file, origin.file)
      : inline
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");

  for (const domain of domains) assertHost(domain);
  return domains;
}

async function readConfigFile(
  opts: LoadConfigOptions | undefined,
): Promise<Record<string, unknown> | undefined> {
  /* No file is read unless the caller injects a reader — this module has no I/O. */
  const readFile = opts?.readFile ?? (async (): Promise<null> => null);
  const explicit = opts?.configPath;

  for (const path of explicit === undefined ? DEFAULT_CONFIG_PATHS : [explicit]) {
    const text = await readFile(path);
    if (text === null) continue;

    const errors: JSONCParseError[] = [];
    const parsed: unknown = parseJSONC(text, { errors });
    const failure = errors[0];
    if (failure !== undefined) {
      throw new ScaloError("invalid-input", "Config file is not valid JSONC", {
        detail: `"${path}" has a syntax error at character ${String(failure.offset)}`,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ScaloError("invalid-input", "Config file is not a JSON object", {
        detail: `"${path}" must hold an object of settings`,
      });
    }
    return parsed as Record<string, unknown>;
  }

  /* A named file that is not there is a typo worth reporting; the defaults are
     only defaults, so their absence means "everything comes from elsewhere". */
  if (explicit !== undefined) {
    throw new ScaloError("invalid-input", "Config file not found", {
      detail: `"${explicit}" could not be read`,
    });
  }
  return undefined;
}

/** Walks a dotted key path (`bucket.endpoint`) through the parsed config file. */
function fileValue(file: Record<string, unknown> | undefined, path: string): unknown {
  let current: unknown = file;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function fileStringList(file: Record<string, unknown> | undefined, path: string): string[] {
  const value = fileValue(file, path);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ScaloError("invalid-input", "Invalid configuration value", {
      detail: `"${path}" must be an array of strings`,
    });
  }
  return value as string[];
}

/** A usable string, or undefined: a blank value counts as unset everywhere. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function randomNodeId(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(4))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `node-${hex}`;
}
