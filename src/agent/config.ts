/*
 * Agent configuration, merged from a JSONC file, the environment and the command
 * line — each source overriding the one before it.
 *
 * The loader is runtime-agnostic: reading files is injected by the caller (the
 * CLI hands in a reader backed by `node:fs`), so nothing here imports a runtime.
 */

import { type JSONCParseError, parseJSONC } from "confbox";
import { ScaloError } from "../core/error.ts";
import { DEFAULT_PORT_RANGE_START } from "../core/placement/ports.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import type { TransportConfig, TransportMode } from "../core/types/transport.ts";
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
    /**
     * Id this node registers under, when the operator pins one. Absent leaves it
     * to the node's persistent state, which generates an id on first boot and
     * keeps it thereafter — pinning a different one replaces that identity.
     */
    id?: string;
    /** `host:port` the agent API binds to. */
    listen: string;
    /** `host:port` reserved for node-to-node traffic, when it is separate. */
    internalListen?: string;
    /** `host:port` other nodes should reach this one at, when it differs from the listener. */
    advertise?: string;
    /**
     * Directory holding what this node must remember across restarts — its
     * identity above all. Absent means the caller decides: the CLI resolves a
     * default for the user it runs as.
     */
    stateDir?: string;
  };
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /** How this node runs and gates the processes that serve its environments. */
  runtime: RuntimeConfig;
  /**
   * Where the node publishes what it serves. Absent means no ingress at all:
   * the processes still run and are simply not reachable from outside the node.
   */
  ingress?: IngressConfig;
  /**
   * Where this node reads the key that opens its environments' sealed variable
   * sets. Absent means it holds none, and may only serve environments that point
   * at no varset at all.
   */
  varsets?: VarsetsConfig;
  /**
   * What carries traffic between this node and its peers. Absent is only legal
   * for a node that stays on loopback: see {@link TransportConfig}.
   */
  transport?: TransportConfig;
}

/** How this node gets at the variables its environments are configured with. */
export interface VarsetsConfig {
  /** File holding the 32-byte AES-256 key, raw or as base64url or hex text. */
  keyFile: string;
}

/** Which ingress a node drives, and how it is reached. */
export interface IngressConfig {
  /** The only ingress implemented; anything else fails the boot. */
  driver: "caddy";
  /** Base URL of the ingress admin API; the driver's own default applies when absent. */
  adminUrl?: string;
  /** Server within the ingress configuration this node writes its routes into. */
  serverName?: string;
}

/** Every runtime setting, with the defaults already applied. */
export interface RuntimeConfig {
  /** Executable that runs one environment; resolved against `PATH` unless it is a path. */
  binPath: string;
  /** First port of the loopback range runtime processes are given pairs from. */
  portRangeStart: number;
  /** Path the application-level half of the readiness gate requests. */
  probePath: string;
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

/** Command that runs an environment when none is configured. */
export const DEFAULT_RUNTIME_BIN: string = "celld";

/** Path probed for application readiness when none is configured. */
export const DEFAULT_PROBE_PATH: string = "/";

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
  const id = resolve("nodeId", sources);
  const stateDir = resolve("stateDir", sources);

  /* Parsed for their side effect: an unusable address must fail the boot, not
     the first request that tries to use it. */
  parseHostPort(listen, ORIGINS.listen.file);
  if (internalListen !== undefined) parseHostPort(internalListen, ORIGINS.internalListen.file);
  if (advertise !== undefined) parseHostPort(advertise, ORIGINS.advertise.file);
  if (id !== undefined) assertNodeId(id);

  const ingress = resolveIngress(sources);
  const keyFile = resolve("varsetKeyFile", sources);
  const transport = resolveTransport(sources);

  return {
    bucket: {
      endpoint: required("endpoint", sources),
      region: resolve("region", sources) ?? DEFAULT_REGION,
      bucket: required("bucket", sources),
      prefix: resolve("prefix", sources),
      accessKey: required("accessKey", sources),
      secretKey: required("secretKey", sources),
    },
    node: { id, listen, internalListen, advertise, stateDir },
    platformDomains: resolvePlatformDomains(sources),
    runtime: {
      binPath: resolve("celldBin", sources) ?? DEFAULT_RUNTIME_BIN,
      portRangeStart: resolvePort("portRangeStart", sources, DEFAULT_PORT_RANGE_START),
      probePath: resolve("probePath", sources) ?? DEFAULT_PROBE_PATH,
    },
    ...(ingress === undefined ? {} : { ingress }),
    ...(keyFile === undefined ? {} : { varsets: { keyFile } }),
    ...(transport === undefined ? {} : { transport }),
  };
}

/**
 * Where other nodes should reach this one: the advertised address wins, then the
 * internal listener, then the agent's own.
 */
export function advertisedAddress(node: AgentConfig["node"]): HostPort {
  if (node.advertise !== undefined) return parseHostPort(node.advertise, "node.advertise");
  if (node.internalListen !== undefined) {
    return parseHostPort(node.internalListen, "node.internalListen");
  }
  return parseHostPort(node.listen, "node.listen");
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
  stateDir: { flag: "state-dir", env: ["SCALO_STATE_DIR"], file: "node.stateDir" },
  platformDomains: {
    flag: "platform-domains",
    env: ["SCALO_PLATFORM_DOMAINS"],
    file: "platformDomains",
  },
  celldBin: { flag: "celld-bin", env: ["SCALO_CELLD_BIN"], file: "runtime.binPath" },
  portRangeStart: {
    flag: "port-range-start",
    env: ["SCALO_PORT_RANGE_START"],
    file: "runtime.portRangeStart",
  },
  probePath: { flag: "probe-path", env: ["SCALO_PROBE_PATH"], file: "runtime.probePath" },
  ingressDriver: {
    flag: "ingress-driver",
    env: ["SCALO_INGRESS_DRIVER"],
    file: "ingress.driver",
  },
  caddyAdmin: { flag: "caddy-admin", env: ["SCALO_CADDY_ADMIN"], file: "ingress.adminUrl" },
  caddyServer: { flag: "caddy-server", env: ["SCALO_CADDY_SERVER"], file: "ingress.serverName" },
  varsetKeyFile: {
    flag: "varset-key-file",
    env: ["SCALO_VARSET_KEY_FILE"],
    file: "varsets.keyFile",
  },
  transport: { flag: "transport", env: ["SCALO_TRANSPORT"], file: "transport.driver" },
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

/**
 * A port-valued setting. The file may carry it as a JSON number while a flag or
 * an environment variable can only carry text, so both spellings are accepted.
 */
function resolvePort(setting: Setting, sources: Sources, fallback: number): number {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === null || raw === "") return fallback;

  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ScaloError("invalid-input", "Invalid configuration value", {
      detail: `"${origin.file}" must be a port in 1-65535, got ${JSON.stringify(raw)}`,
    });
  }
  return value;
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

/**
 * The ingress this node drives, or undefined when it drives none.
 *
 * Naming an admin API is enough to ask for one: there is a single driver, so
 * spelling it out as well would be ceremony. Configuring nothing but a server
 * name leaves the ingress off, because nothing says where to reach it.
 */
function resolveIngress(sources: Sources): IngressConfig | undefined {
  const driver = resolve("ingressDriver", sources);
  const adminUrl = resolve("caddyAdmin", sources);
  const serverName = resolve("caddyServer", sources);

  if (driver === undefined && adminUrl === undefined) return undefined;
  if (driver !== undefined && driver !== "caddy") {
    throw new ScaloError("invalid-input", "Invalid configuration value", {
      detail: `"${ORIGINS.ingressDriver.file}" must be "caddy", got ${JSON.stringify(driver)}`,
    });
  }

  return {
    driver: "caddy",
    ...(adminUrl === undefined ? {} : { adminUrl }),
    ...(serverName === undefined ? {} : { serverName }),
  };
}

/**
 * The transport this node runs, or undefined when the operator has said nothing.
 *
 * Undefined is a distinct answer, not a default: a node whose addresses reach
 * beyond loopback refuses to boot until it is told which network it is on.
 */
function resolveTransport(sources: Sources): TransportConfig | undefined {
  const driver = resolve("transport", sources);
  if (driver === undefined) return undefined;

  const modes: TransportMode[] = ["wireguard", "none"];
  if (!(modes as string[]).includes(driver)) {
    throw new ScaloError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.transport.file}" must be one of ${modes.map((m) => `"${m}"`).join(", ")}, ` +
        `got ${JSON.stringify(driver)}`,
    });
  }
  return { driver: driver as TransportMode };
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
    const parsed: unknown = parseJSONC(text, { errors, allowTrailingComma: true });
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
