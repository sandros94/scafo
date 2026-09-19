/* Runtime-agnostic daemon configuration; flags override environment, then JSONC. */

import { ScafoError } from "../core/error.ts";
import { assertPositiveSafeInteger } from "../core/utils/number.ts";
import { DEFAULT_ARCHIVE_ENTRIES, DEFAULT_ARTIFACT_BYTES } from "../core/types/deploy.ts";
import {
  assertPortRange,
  DEFAULT_PORT_QUARANTINE_MS,
  DEFAULT_PORT_RANGE_START,
  defaultPortRangeEnd,
} from "../core/placement/ports.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import { DEFAULT_LEASE_TTL_MS } from "../core/registry/lease.ts";
import {
  DEFAULT_NODE_REFRESH_INTERVAL_MS,
  DEFAULT_REGISTRY_RESYNC_MS,
} from "../core/registry/view.ts";
import { DEFAULT_REAP_INTERVAL_MS } from "./coordinator.ts";
import type { TransportConfig, TransportMode } from "../core/types/transport.ts";
import { assertEnvVars, parseEnvVarEntries } from "../core/utils/env.ts";
import { assertHost, formatHostPort, isHost, parseInterfaceAddress } from "../core/utils/host.ts";
import { assertLabels, parseLabelEntries } from "../core/utils/labels.ts";
/* Import the driver's reserved names instead of duplicating that contract. */
import { OPERATOR_RESERVED_ENV, TELEMETRY_ENV } from "../drivers/runtime/celld.ts";
import { parseJsoncDocument } from "./_jsonc.ts";
import { DEFAULT_JSON_BYTES } from "./_json.ts";
import {
  DEFAULT_ACTIVE_TASKS,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_APPLICATION_ACTIVE_TASKS,
  DEFAULT_APPLICATION_QUEUED_TASKS,
  DEFAULT_APPLICATION_STAGED_BYTES,
  DEFAULT_QUEUED_TASKS,
  DEFAULT_QUEUE_TIMEOUT_MS,
  DEFAULT_RECEIVE_TIMEOUT_MS,
  DEFAULT_STAGED_BYTES,
  DEFAULT_TASK_TIMEOUT_MS,
} from "./_deploy-scheduler.ts";

export { DEFAULT_JSON_BYTES } from "./_json.ts";

export interface DaemonConfig {
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
    /** Pinned registry id; otherwise persistent node state supplies one. */
    id?: string;
    /** `host:port` the node API binds to. */
    listen: string;
    /** `host:port` other nodes should reach this one at, when it differs from the listener. */
    advertise?: string;
    /** Persistent node state directory; the CLI chooses its default. */
    stateDir?: string;
    /** Selector labels, written wholesale to the node record at registration. */
    labels?: Record<string, string>;
  };
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /** How this node runs and gates the processes that serve its applications. */
  runtime: RuntimeConfig;
  /**
   * How often this node re-reads the registry it holds a view of. Absent leaves
   * every interval at its default, exactly as {@link DaemonConfig.deploy} does.
   */
  registry?: RegistryViewConfig;
  /** How the node behaves on the ticks it spends holding the coordinator lease. */
  coordinator?: CoordinatorConfig;
  /** Resource bounds applied independently while receiving and expanding deploys. */
  deploy?: DeployConfig;
  /** Whether this node reports on itself at all. Off unless it was turned on. */
  observability: ObservabilityConfig;
  /** Whether the fleet's API answers at the platform domains' own apexes. */
  api: ApiConfig;
  /**
   * Which ingress this node drives, and what an ingress presents to read from
   * it. Absent means no ingress at all: the processes still run and are simply
   * not reachable from outside the node.
   */
  ingress?: IngressConfig;
  /**
   * What carries traffic between this node and its peers. Absent is only legal
   * for a node that stays on loopback: see {@link TransportConfig}.
   */
  transport?: TransportConfig;
  /**
   * Where this node sits on the WireGuard tunnel, when one was configured at
   * all. Only read when `transport.driver` is `wireguard`; anything configured
   * here for a node running another transport is ignored.
   */
  wireguard?: WireguardConfig;
}

export interface DeployConfig {
  /** Maximum received compressed bytes and, independently, expanded bytes. */
  artifactBytes: number;
  /** Maximum entries in one tar archive. */
  archiveEntries: number;
  activeTasks: number;
  applicationActiveTasks: number;
  queuedTasks: number;
  applicationQueuedTasks: number;
  stagedBytes: number;
  applicationStagedBytes: number;
  receiveTimeoutMs: number;
  queueTimeoutMs: number;
  taskTimeoutMs: number;
  outputBytes: number;
}

/** WireGuard interface values. Both address and endpoint are required with that transport. */
export interface WireguardConfig {
  /** The node's own address on the tunnel, with its prefix length: `10.83.0.1/24`. */
  address?: string;
  /** `host:port` peers reach this node's tunnel at: `203.0.113.7:51820`. */
  endpoint?: string;
  /** UDP port the interface listens on; {@link DEFAULT_WIREGUARD_PORT} by default. */
  port: number;
}

/** Opt-in local observability. Enables the bounded event ring and defaults
 * {@link TELEMETRY_ENV} to `1` unless runtime configuration overrides it. */
export interface ObservabilityConfig {
  enabled: boolean;
  /** JSON access-log path. Requires observability to be enabled. */
  ingressAccessLog?: string;
}

/** Enables the fleet API at platform-domain apexes. Token gates remain in force;
 * the storage surface and the fleet's routing are denied at ingress. */
export interface ApiConfig {
  public: boolean;
  /** Maximum bytes accepted by any JSON control request. */
  jsonBytes: number;
}

/**
 * Ingress configuration.
 *
 * THERE IS NO DRIVER TO SELECT. Both ingresses pull: Caddy through the `scafo`
 * dynamic-upstreams module reading `/v1/ingress/routes`, Traefik through its http
 * provider reading `/v1/ingress/routes/traefik`, and both present the ingress
 * token to do it. So a node is never configured with WHICH ingress stands in
 * front of it — it is configured with what that ingress needs to read it, which
 * is a token, plus the one thing about a Traefik router a document cannot infer.
 */
export interface IngressConfig {
  /**
   * Every token admitted on `/v1/ingress` and `/v1/storage`, primary first, never
   * empty. Explicit tokens replace minting: rotate by expanding to `[new, old]`,
   * restart and migrate consumers, then contract to `[new]`. The first token is
   * persisted for local consumers.
   */
  token?: [string, ...string[]];
  /** Traefik entry points; never empty because omission attaches to all of them. */
  entryPoints?: string[];
}

/**
 * How often a node looks at the registry beyond the change hint it reads once a
 * pass. Both are bounds on how stale a view may get, never on correctness.
 */
export interface RegistryViewConfig {
  /** Full re-read interval, whatever the hint says: the bound on a lost hint. */
  resyncIntervalMs: number;
  /** Node re-read interval; liveness is an age, and no write announces a death. */
  nodeRefreshIntervalMs: number;
}

/** What the node does while it holds the coordinator lease. */
export interface CoordinatorConfig {
  /** Lifetime written into the lease; it is renewed at a third of it. */
  leaseTtlMs: number;
  /** Time between two reap passes while holding. */
  reapIntervalMs: number;
}

/** Every runtime setting, with the defaults already applied. */
export interface RuntimeConfig {
  /** Executable that runs one application; resolved against `PATH` unless it is a path. */
  binPath: string;
  /** First port of the range runtime processes are given pairs from. */
  portRangeStart: number;
  /**
   * Last port of that range, both ends included.
   *
   * Worth sizing on a node that shares the host's network namespace, where these
   * ports are the HOST's and the machine's own services live among them.
   */
  portRangeEnd: number;
  /**
   * How long a port released here is kept from a different application, so a
   * peer or an ingress still routing to it cannot reach another application's
   * process.
   */
  portQuarantineMs: number;
  /** Runtime listener address. Non-loopback requires an explicit transport. */
  bindHost: string;
  /** Variables for every runtime process. Driver-derived names are rejected. */
  celldEnv?: Record<string, string>;
}

export interface LoadConfigOptions {
  /** Config file to read; defaults to {@link DEFAULT_CONFIG_PATHS}, first readable wins. */
  configPath?: string;
  /**
   * Command-line flags, keyed by their kebab-case name (`access-key`). A
   * list-valued setting arrives as the array its flag was repeated into; every
   * other setting arrives as text.
   */
  flags?: Record<string, string | string[] | undefined>;
  /** Environment to read; pass `process.env`. Defaults to no environment at all. */
  env?: Record<string, string | undefined>;
  /** Reads a file as text, resolving null when it does not exist. */
  readFile?: (path: string) => Promise<string | null>;
}

/** Config files looked for when no path is given, in order of preference. */
export const DEFAULT_CONFIG_PATHS: string[] = ["./scafo.config.jsonc", "./scafo.config.json"];

/** Signing region used when none is configured; harmless for stores that ignore it. */
export const DEFAULT_REGION: string = "us-east-1";

/** Loopback by default: the node API is only safe on a trusted network. */
export const DEFAULT_LISTEN: string = "127.0.0.1:7400";

/** Command that runs an application when none is configured. */
export const DEFAULT_RUNTIME_BIN: string = "celld";

/** Address runtime processes bind to when none is configured: loopback only. */
export const DEFAULT_BIND_HOST: string = "127.0.0.1";

/** Bind addresses that answer on every address of the host, loopback included. */
const WILDCARD_BIND_HOSTS: string[] = ["0.0.0.0", "::"];

/**
 * What runtime processes bind on a node whose transport is the network itself.
 * The operator has said that network is private; a process reachable only on
 * loopback there would be one the fleet advertises and nobody can reach. The
 * IPv4 wildcard, not `::`: a host with IPv6 turned off cannot bind the latter,
 * and an IPv6-only fleet is one the operator names its bind for.
 */
const OPEN_BIND_HOST: string = "0.0.0.0";

/** UDP port a WireGuard interface listens on when none is configured. */
export const DEFAULT_WIREGUARD_PORT: number = 51_820;

/** Platform apex API is public unless disabled. */
export const DEFAULT_API_PUBLIC: boolean = true;

/** A `host:port` pair, as written for a listener or an advertised address. */
export interface HostPort {
  host: string;
  port: number;
}

/**
 * Reads the configuration a node daemon starts from.
 *
 * Throws `ScafoError("invalid-input")` when a required setting has no value in
 * any source, or when an address, a node id or a platform domain is malformed.
 */
export async function loadDaemonConfig(opts?: LoadConfigOptions): Promise<DaemonConfig> {
  const sources: Sources = {
    flags: opts?.flags ?? {},
    env: opts?.env ?? {},
    file: await readConfigFile(opts),
  };

  const configuredListen = resolve("listen", sources);
  const configuredAdvertise = resolve("advertise", sources);
  const id = resolve("nodeId", sources);
  const stateDir = resolve("stateDir", sources);
  const labels = resolveNodeLabels(sources);

  /* Reject malformed addresses before starting the daemon. */
  if (configuredListen !== undefined) parseHostPort(configuredListen, ORIGINS.listen.file);
  if (configuredAdvertise !== undefined) {
    parseHostPort(configuredAdvertise, ORIGINS.advertise.file);
  }
  if (id !== undefined) assertNodeId(id);

  const ingress = resolveIngress(sources);
  const observing = resolveBoolean("observability", sources, false);
  const ingressAccessLog = resolveIngressAccessLog(sources, observing);
  /* Operator runtime config overrides the observability telemetry default. */
  const celldEnv = withTelemetry(resolveCelldEnv(sources), observing);
  const transport = resolveTransport(sources);
  const wireguard = resolveWireguard(sources);

  /* WireGuard supplies aligned defaults for API, advertised, and runtime binds. */
  const tunnelHost =
    transport?.driver === "wireguard" && wireguard?.address !== undefined
      ? (parseInterfaceAddress(wireguard.address)?.host ?? undefined)
      : undefined;

  const listen =
    configuredListen ??
    (tunnelHost === undefined
      ? DEFAULT_LISTEN
      : formatHostPort(tunnelHost, parseHostPort(DEFAULT_LISTEN, ORIGINS.listen.file).port));
  const listenAddress = parseHostPort(listen, ORIGINS.listen.file);
  const advertise =
    configuredAdvertise ??
    (tunnelHost === undefined ? undefined : formatHostPort(tunnelHost, listenAddress.port));

  return {
    bucket: {
      endpoint: required("endpoint", sources),
      region: resolve("region", sources) ?? DEFAULT_REGION,
      bucket: required("bucket", sources),
      prefix: resolve("prefix", sources),
      accessKey: required("accessKey", sources),
      secretKey: required("secretKey", sources),
    },
    node: {
      id,
      listen,
      advertise,
      stateDir,
      ...(labels === undefined ? {} : { labels }),
    },
    platformDomains: resolvePlatformDomains(sources),
    runtime: {
      binPath: resolve("celldBin", sources) ?? DEFAULT_RUNTIME_BIN,
      ...resolvePortRange(sources),
      portQuarantineMs: resolvePositiveSafeInteger(
        "portQuarantineMs",
        sources,
        DEFAULT_PORT_QUARANTINE_MS,
      ),
      bindHost: resolveBindHost(sources) ?? defaultBindHost(transport, tunnelHost),
      ...(celldEnv === undefined ? {} : { celldEnv }),
    },
    registry: {
      resyncIntervalMs: resolvePositiveSafeInteger(
        "registryResyncMs",
        sources,
        DEFAULT_REGISTRY_RESYNC_MS,
      ),
      nodeRefreshIntervalMs: resolvePositiveSafeInteger(
        "registryNodeRefreshMs",
        sources,
        DEFAULT_NODE_REFRESH_INTERVAL_MS,
      ),
    },
    coordinator: {
      leaseTtlMs: resolvePositiveSafeInteger(
        "coordinatorLeaseTtlMs",
        sources,
        DEFAULT_LEASE_TTL_MS,
      ),
      reapIntervalMs: resolvePositiveSafeInteger(
        "coordinatorReapIntervalMs",
        sources,
        DEFAULT_REAP_INTERVAL_MS,
      ),
    },
    deploy: resolveDeploy(sources),
    observability: {
      enabled: observing,
      ...(ingressAccessLog === undefined ? {} : { ingressAccessLog }),
    },
    api: {
      public: resolveBoolean("apiPublic", sources, DEFAULT_API_PUBLIC),
      jsonBytes: resolvePositiveSafeInteger("jsonBytes", sources, DEFAULT_JSON_BYTES),
    },
    ...(ingress === undefined ? {} : { ingress }),
    ...(transport === undefined ? {} : { transport }),
    ...(wireguard === undefined ? {} : { wireguard }),
  };
}

/**
 * Where runtime processes bind when the operator did not say: on the tunnel
 * when there is one, on every interface when the transport is the network
 * itself, and on loopback when no transport decision was made at all — a node
 * that has not said what network it trusts exposes its processes to none.
 */
function defaultBindHost(
  transport: TransportConfig | undefined,
  tunnelHost: string | undefined,
): string {
  if (tunnelHost !== undefined) return tunnelHost;
  return transport?.driver === "none" ? OPEN_BIND_HOST : DEFAULT_BIND_HOST;
}

/**
 * Where other nodes should reach this one: the advertised address wins, and the
 * daemon's own listener stands in when nothing was advertised.
 */
export function advertisedAddress(node: DaemonConfig["node"]): HostPort {
  if (node.advertise !== undefined) return parseHostPort(node.advertise, "node.advertise");
  return parseHostPort(node.listen, "node.listen");
}

/** How a listener bound on this machine is dialled from it. A wildcard bind
 * answers on loopback; every specific bind is dialled as it was bound,
 * tunnel addresses included. */
export function localDialHost(host: string): string {
  return WILDCARD_BIND_HOSTS.includes(host) ? DEFAULT_BIND_HOST : host;
}

/** Local runtime dial address. Wildcard binds use loopback; specific binds stay
 * specific, including tunnel addresses. */
export function runtimeDialHost(runtime: DaemonConfig["runtime"]): string {
  return localDialHost(runtime.bindHost);
}

/**
 * Splits `host:port`. IPv6 literals must be bracketed the way a URL authority
 * writes them (`[::1]:7400`); every other host is a DNS name or an IPv4 address.
 *
 * Throws `ScafoError("invalid-input")` naming `field` when the value is not one.
 */
export function parseHostPort(value: string, field: string): HostPort {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const bracketed = match?.[1];
  const host = bracketed ?? match?.[2];
  const port = Number(match?.[3]);

  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ScafoError("invalid-input", "Invalid address", {
      detail: `"${field}" must be "host:port" with a port in 1-65535, got "${value}"`,
    });
  }
  /* Non-bracketed hosts must be lowercase DNS names or IPv4 addresses. */
  if (bracketed === undefined && !isHost(host)) {
    throw new ScafoError("invalid-input", "Invalid address", {
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

/** Configuration origins. Scafo-specific bucket variables outrank AWS/S3 ones. */
const ORIGINS = {
  endpoint: {
    flag: "endpoint",
    env: ["SCAFO_S3_ENDPOINT", "S3_ENDPOINT"],
    file: "bucket.endpoint",
  },
  region: { flag: "region", env: ["SCAFO_S3_REGION", "AWS_REGION"], file: "bucket.region" },
  bucket: { flag: "bucket", env: ["SCAFO_S3_BUCKET"], file: "bucket.bucket" },
  prefix: { flag: "prefix", env: ["SCAFO_S3_PREFIX"], file: "bucket.prefix" },
  accessKey: {
    flag: "access-key",
    env: ["SCAFO_S3_ACCESS_KEY", "AWS_ACCESS_KEY_ID"],
    file: "bucket.accessKey",
  },
  secretKey: {
    flag: "secret-key",
    env: ["SCAFO_S3_SECRET_KEY", "AWS_SECRET_ACCESS_KEY"],
    file: "bucket.secretKey",
  },
  nodeId: { flag: "node-id", env: ["SCAFO_NODE_ID"], file: "node.id" },
  listen: { flag: "listen", env: ["SCAFO_LISTEN"], file: "node.listen" },
  advertise: { flag: "advertise", env: ["SCAFO_ADVERTISE"], file: "node.advertise" },
  stateDir: { flag: "state-dir", env: ["SCAFO_STATE_DIR"], file: "node.stateDir" },
  nodeLabels: { flag: "node-labels", env: ["SCAFO_NODE_LABELS"], file: "node.labels" },
  platformDomains: {
    flag: "platform-domains",
    env: ["SCAFO_PLATFORM_DOMAINS"],
    file: "platformDomains",
  },
  celldBin: { flag: "celld-bin", env: ["SCAFO_CELLD_BIN"], file: "runtime.binPath" },
  celldEnv: { flag: "celld-env", env: ["SCAFO_CELLD_ENV"], file: "runtime.celldEnv" },
  portRangeStart: {
    flag: "port-range-start",
    env: ["SCAFO_PORT_RANGE_START"],
    file: "runtime.portRangeStart",
  },
  portRangeEnd: {
    flag: "port-range-end",
    env: ["SCAFO_PORT_RANGE_END"],
    file: "runtime.portRangeEnd",
  },
  portQuarantineMs: {
    flag: "port-quarantine-ms",
    env: ["SCAFO_PORT_QUARANTINE_MS"],
    file: "runtime.portQuarantineMs",
  },
  bindHost: { flag: "bind-host", env: ["SCAFO_BIND_HOST"], file: "runtime.bindHost" },
  registryResyncMs: {
    flag: "registry-resync-ms",
    env: ["SCAFO_REGISTRY_RESYNC_MS"],
    file: "registry.resyncIntervalMs",
  },
  registryNodeRefreshMs: {
    flag: "registry-node-refresh-ms",
    env: ["SCAFO_REGISTRY_NODE_REFRESH_MS"],
    file: "registry.nodeRefreshIntervalMs",
  },
  coordinatorLeaseTtlMs: {
    flag: "coordinator-lease-ttl-ms",
    env: ["SCAFO_COORDINATOR_LEASE_TTL_MS"],
    file: "coordinator.leaseTtlMs",
  },
  coordinatorReapIntervalMs: {
    flag: "coordinator-reap-interval-ms",
    env: ["SCAFO_COORDINATOR_REAP_INTERVAL_MS"],
    file: "coordinator.reapIntervalMs",
  },
  artifactBytes: {
    flag: "artifact-bytes",
    env: ["SCAFO_ARTIFACT_BYTES"],
    file: "deploy.artifactBytes",
  },
  archiveEntries: {
    flag: "archive-entries",
    env: ["SCAFO_ARCHIVE_ENTRIES"],
    file: "deploy.archiveEntries",
  },
  activeTasks: { flag: "active-tasks", env: ["SCAFO_ACTIVE_TASKS"], file: "deploy.activeTasks" },
  applicationActiveTasks: {
    flag: "application-active-tasks",
    env: ["SCAFO_APPLICATION_ACTIVE_TASKS"],
    file: "deploy.applicationActiveTasks",
  },
  queuedTasks: { flag: "queued-tasks", env: ["SCAFO_QUEUED_TASKS"], file: "deploy.queuedTasks" },
  applicationQueuedTasks: {
    flag: "application-queued-tasks",
    env: ["SCAFO_APPLICATION_QUEUED_TASKS"],
    file: "deploy.applicationQueuedTasks",
  },
  stagedBytes: { flag: "staged-bytes", env: ["SCAFO_STAGED_BYTES"], file: "deploy.stagedBytes" },
  applicationStagedBytes: {
    flag: "application-staged-bytes",
    env: ["SCAFO_APPLICATION_STAGED_BYTES"],
    file: "deploy.applicationStagedBytes",
  },
  receiveTimeoutMs: {
    flag: "receive-timeout-ms",
    env: ["SCAFO_RECEIVE_TIMEOUT_MS"],
    file: "deploy.receiveTimeoutMs",
  },
  queueTimeoutMs: {
    flag: "queue-timeout-ms",
    env: ["SCAFO_QUEUE_TIMEOUT_MS"],
    file: "deploy.queueTimeoutMs",
  },
  taskTimeoutMs: {
    flag: "task-timeout-ms",
    env: ["SCAFO_TASK_TIMEOUT_MS"],
    file: "deploy.taskTimeoutMs",
  },
  outputBytes: { flag: "output-bytes", env: ["SCAFO_OUTPUT_BYTES"], file: "deploy.outputBytes" },
  observability: {
    flag: "observability",
    env: ["SCAFO_OBSERVABILITY"],
    file: "observability.enabled",
  },
  ingressAccessLog: {
    flag: "ingress-access-log",
    env: ["SCAFO_INGRESS_ACCESS_LOG"],
    file: "observability.ingressAccessLog",
  },
  apiPublic: { flag: "api-public", env: ["SCAFO_API_PUBLIC"], file: "api.public" },
  jsonBytes: { flag: "json-bytes", env: ["SCAFO_JSON_BYTES"], file: "api.jsonBytes" },
  traefikEntryPoints: {
    flag: "traefik-entrypoints",
    env: ["SCAFO_TRAEFIK_ENTRYPOINTS"],
    file: "ingress.entryPoints",
  },
  /* `SCAFO_STORAGE_TOKEN` is the name this had when the token only guarded storage. */
  ingressToken: {
    flag: "ingress-token",
    env: ["SCAFO_INGRESS_TOKEN", "SCAFO_STORAGE_TOKEN"],
    file: "ingress.token",
  },
  transport: { flag: "transport", env: ["SCAFO_TRANSPORT"], file: "transport.driver" },
  wgAddress: { flag: "wg-address", env: ["SCAFO_WG_ADDRESS"], file: "wireguard.address" },
  wgEndpoint: { flag: "wg-endpoint", env: ["SCAFO_WG_ENDPOINT"], file: "wireguard.endpoint" },
  wgPort: { flag: "wg-port", env: ["SCAFO_WG_PORT"], file: "wireguard.port" },
} satisfies Record<string, Origin>;

/** Formats a WireGuard setting with its config, flag, and environment spellings. */
export function describeWireguardSetting(setting: "address" | "endpoint" | "port"): string {
  const origin: Origin =
    setting === "address"
      ? ORIGINS.wgAddress
      : setting === "endpoint"
        ? ORIGINS.wgEndpoint
        : ORIGINS.wgPort;
  return `"${origin.file}" (--${origin.flag}, or ${origin.env.join(" or ")})`;
}

type Setting = keyof typeof ORIGINS;

interface Sources {
  flags: Record<string, string | string[] | undefined>;
  env: Record<string, string | undefined>;
  file: Record<string, unknown> | undefined;
}

/**
 * Every entry a list-valued setting names on the command line or in the
 * environment, unread and untrimmed, or undefined when neither source states it.
 *
 * THIS IS THE ONE PLACE THE TWO SPELLINGS OF A LIST DIFFER. A flag repeats, and
 * each occurrence is one whole entry — nothing is split, so an entry may hold a
 * comma. An environment variable cannot repeat, so it carries the entries as
 * comma-separated text and an entry there may hold no comma. The config file has
 * a third spelling of its own, a JSON array, which each setting reads for itself
 * once neither of these answered.
 *
 * A repeated flag nobody wrote reaches the loader as an empty array, which says
 * nothing and lets the environment answer; a flag written empty says an empty
 * entry, which is a setting's own to refuse.
 */
function listFlagOrEnv(origin: Origin, sources: Sources): string[] | undefined {
  const flag = sources.flags[origin.flag];
  if (typeof flag === "string") return [flag];
  if (Array.isArray(flag) && flag.length > 0) return flag;

  for (const variable of origin.env) {
    const value = sources.env[variable];
    if (value !== undefined) return value.split(",");
  }
  return undefined;
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
  throw new ScafoError("invalid-input", "Missing required configuration", {
    detail:
      `"${origin.file}" has no value: set it in the config file, ` +
      `set ${origin.env.join(" or ")} in the environment, or pass --${origin.flag}`,
  });
}

/** Resolves a port from numeric JSON or text-based flags and environment. */
function resolvePort(setting: Setting, sources: Sources, fallback: number): number {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === null || raw === "") return fallback;

  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail: `"${origin.file}" must be a port in 1-65535, got ${JSON.stringify(raw)}`,
    });
  }
  return value;
}

/**
 * The range this node draws port pairs from.
 *
 * The end defaults to a span from whatever start was configured, never past the
 * last port there is, so an operator who moves only the start still gets a
 * usable range. Both ends are then weighed together: a range that cannot hold
 * two ports places nothing.
 */
function resolvePortRange(sources: Sources): { portRangeStart: number; portRangeEnd: number } {
  const start = resolvePort("portRangeStart", sources, DEFAULT_PORT_RANGE_START);
  const end = resolvePort("portRangeEnd", sources, defaultPortRangeEnd(start));
  assertPortRange(
    { start, end },
    { start: ORIGINS.portRangeStart.file, end: ORIGINS.portRangeEnd.file },
  );
  return { portRangeStart: start, portRangeEnd: end };
}

function resolvePositiveSafeInteger(setting: Setting, sources: Sources, fallback: number): number {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  assertPositiveSafeInteger(value, origin.file);
  return value;
}

function resolveNonNegativeSafeInteger(
  setting: Setting,
  sources: Sources,
  fallback: number,
): number {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail: `"${origin.file}" must be a non-negative safe integer, got ${JSON.stringify(raw)}`,
    });
  }
  return value;
}

function resolveDeploy(sources: Sources): DeployConfig {
  const deploy: DeployConfig = {
    artifactBytes: resolvePositiveSafeInteger("artifactBytes", sources, DEFAULT_ARTIFACT_BYTES),
    archiveEntries: resolvePositiveSafeInteger("archiveEntries", sources, DEFAULT_ARCHIVE_ENTRIES),
    activeTasks: resolvePositiveSafeInteger("activeTasks", sources, DEFAULT_ACTIVE_TASKS),
    applicationActiveTasks: resolvePositiveSafeInteger(
      "applicationActiveTasks",
      sources,
      DEFAULT_APPLICATION_ACTIVE_TASKS,
    ),
    queuedTasks: resolveNonNegativeSafeInteger("queuedTasks", sources, DEFAULT_QUEUED_TASKS),
    applicationQueuedTasks: resolveNonNegativeSafeInteger(
      "applicationQueuedTasks",
      sources,
      DEFAULT_APPLICATION_QUEUED_TASKS,
    ),
    stagedBytes: resolvePositiveSafeInteger("stagedBytes", sources, DEFAULT_STAGED_BYTES),
    applicationStagedBytes: resolvePositiveSafeInteger(
      "applicationStagedBytes",
      sources,
      DEFAULT_APPLICATION_STAGED_BYTES,
    ),
    receiveTimeoutMs: resolvePositiveSafeInteger(
      "receiveTimeoutMs",
      sources,
      DEFAULT_RECEIVE_TIMEOUT_MS,
    ),
    queueTimeoutMs: resolvePositiveSafeInteger("queueTimeoutMs", sources, DEFAULT_QUEUE_TIMEOUT_MS),
    taskTimeoutMs: resolvePositiveSafeInteger("taskTimeoutMs", sources, DEFAULT_TASK_TIMEOUT_MS),
    outputBytes: resolvePositiveSafeInteger("outputBytes", sources, DEFAULT_OUTPUT_BYTES),
  };

  for (const [application, global] of [
    ["applicationActiveTasks", "activeTasks"],
    ["applicationQueuedTasks", "queuedTasks"],
    ["applicationStagedBytes", "stagedBytes"],
  ] as const) {
    if (deploy[application] > deploy[global]) {
      throw new ScafoError("invalid-input", "Invalid deploy limits", {
        detail: `"deploy.${application}" must not exceed "deploy.${global}"`,
      });
    }
  }
  for (const field of ["stagedBytes", "applicationStagedBytes"] as const) {
    if (deploy[field] < deploy.artifactBytes) {
      throw new ScafoError("invalid-input", "Invalid deploy byte limits", {
        detail: `"deploy.${field}" must be at least "deploy.artifactBytes"`,
      });
    }
  }
  return deploy;
}

/** Resolves JSON booleans or `1`/`true` and `0`/`false`; rejects ambiguity. */
function resolveBoolean(setting: Setting, sources: Sources, fallback: boolean): boolean {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;

  const written = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (written === "1" || written === "true") return true;
  if (written === "0" || written === "false") return false;

  throw new ScafoError("invalid-input", "Invalid configuration value", {
    detail:
      `"${origin.file}" must be a switch, written "1" or "true" to turn it on and ` +
      `"0" or "false" to turn it off, got ${JSON.stringify(raw)}`,
  });
}

/** Defaults runtime telemetry on for observation without overriding operator config. */
function withTelemetry(
  configured: Record<string, string> | undefined,
  observing: boolean,
): Record<string, string> | undefined {
  if (!observing) return configured;
  if (configured?.[TELEMETRY_ENV] !== undefined) return configured;
  return { ...configured, [TELEMETRY_ENV]: "1" };
}

/** Returns the access log path; rejects it when observability is disabled. */
function resolveIngressAccessLog(sources: Sources, observing: boolean): string | undefined {
  const origin: Origin = ORIGINS.ingressAccessLog;
  const path = resolve("ingressAccessLog", sources);
  if (path === undefined || observing) return path;

  throw new ScafoError("invalid-input", "Access log configured with observability off", {
    detail:
      `"${origin.file}" (--${origin.flag}) names ${JSON.stringify(path)}, but ` +
      `"${ORIGINS.observability.file}" is off, so nothing would ever read that file. ` +
      `Turn observability on (--${ORIGINS.observability.flag}, or ` +
      `${ORIGINS.observability.env.join(" or ")}=1), or drop the access log setting`,
  });
}

/** Resolves an explicit runtime bind host; tunnel configuration supplies its own default. */
function resolveBindHost(sources: Sources): string | undefined {
  const value = resolve("bindHost", sources);
  if (value === undefined) return undefined;

  /* Wildcard bind addresses are valid runtime interfaces, not DNS names. */
  if (value !== "0.0.0.0" && value !== "::" && !isHost(value)) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.bindHost.file}" must be an address runtime processes can bind, ` +
        `such as "127.0.0.1" or "0.0.0.0", got ${JSON.stringify(value)}`,
    });
  }
  return value;
}

/**
 * What this node says it is, or undefined when the operator said nothing.
 *
 * Two spellings, because the sources can carry two shapes: a flag and an
 * environment variable state one `k=v` pair per entry, while the config file
 * holds the object those pairs parse into. The inline form wins whole rather
 * than merging with the file's — labels describe one machine, and a set
 * half-stated in two places is one nobody can read off either.
 */
function resolveNodeLabels(sources: Sources): Record<string, string> | undefined {
  const origin: Origin = ORIGINS.nodeLabels;

  const inline = listFlagOrEnv(origin, sources);
  if (inline !== undefined) return parseLabelEntries(inline, `"${origin.file}"`);

  const value = fileValue(sources.file, origin.file);
  if (value === undefined || value === null) return undefined;

  assertLabels(value, `"${origin.file}"`);
  return { ...value };
}

/**
 * The variables an operator hands every runtime process, or undefined when they
 * handed over none.
 *
 * Two spellings, as the node labels have: a flag and an environment variable
 * state one `NAME=value` pair per entry, while the config file carries the
 * object those pairs parse into. A VALUE HOLDING A COMMA is written by repeating
 * the flag, or in the config file; the environment variable is the one form that
 * cannot carry one, because its entries are separated by commas. The inline form
 * replaces the file's whole set rather than merging into it, for the reason
 * labels do: a set half-stated in two places is one nobody can read off either.
 *
 * A name the runtime driver derives for itself is refused here, naming the
 * variable, because this is the last moment an operator is still looking at
 * what they wrote — the process would simply overwrite it and say nothing.
 */
function resolveCelldEnv(sources: Sources): Record<string, string> | undefined {
  const origin: Origin = ORIGINS.celldEnv;
  const inline = listFlagOrEnv(origin, sources);

  let vars: Record<string, string>;
  if (inline === undefined) {
    const value = fileValue(sources.file, origin.file);
    if (value === undefined || value === null) return undefined;

    assertEnvVars(value, `"${origin.file}"`);
    vars = { ...value };
  } else {
    vars = parseEnvVarEntries(inline, `"${origin.file}"`);
  }

  for (const name of Object.keys(vars)) {
    if (!OPERATOR_RESERVED_ENV.includes(name)) continue;

    throw new ScafoError("invalid-input", "Reserved environment variable", {
      detail:
        `"${origin.file}" sets "${name}", which the runtime driver writes itself from this ` +
        `node's configuration, from the listeners its processes bind and from the private ` +
        `directories it keeps for them — a value set here would be overwritten. Drop it from ` +
        `the Celld policy`,
    });
  }
  return Object.keys(vars).length === 0 ? undefined : vars;
}

/**
 * Resolves explicit ingress tokens, in the order the source states them, primary
 * first. An explicit empty value is rejected, not treated as absent.
 *
 * A file holding one token writes it as the string it is; several are an array,
 * and each entry is one whole token.
 */
function resolveIngressTokens(sources: Sources): [string, ...string[]] | undefined {
  const origin: Origin = ORIGINS.ingressToken;
  const inFile: unknown = fileValue(sources.file, origin.file);
  const written: unknown =
    listFlagOrEnv(origin, sources) ?? (typeof inFile === "string" ? [inFile] : inFile);
  if (written === undefined || written === null) return undefined;

  if (!Array.isArray(written) || written.some((entry) => typeof entry !== "string")) {
    throw refuseIngressTokens(written, "must be a token, or a list of them");
  }

  const tokens = (written as string[]).map((entry) => entry.trim());
  const [primary, ...rest] = tokens;
  if (tokens.length === 0 || tokens.some((token) => token === "")) {
    throw refuseIngressTokens(
      written,
      "names no token, and an entry holding nothing would admit a caller presenting nothing",
    );
  }
  return [primary, ...rest];
}

/** The one refusal the ingress tokens get, whichever source carried the value. */
function refuseIngressTokens(written: unknown, why: string): ScafoError {
  const origin: Origin = ORIGINS.ingressToken;
  return new ScafoError("invalid-input", "Invalid configuration value", {
    detail:
      `"${origin.file}" (--${origin.flag}, or ${origin.env.join(" or ")}) ${why}, got ` +
      `${JSON.stringify(written)}. Write one token, several by repeating --${origin.flag} or ` +
      `separating them with commas in the environment, or an array of them in the config file, ` +
      `with the one in use first; leave the setting out altogether to have this node mint its ` +
      `own instead`,
  });
}

function resolvePlatformDomains(sources: Sources): string[] {
  const origin: Origin = ORIGINS.platformDomains;
  const inline = listFlagOrEnv(origin, sources);
  const domains = (inline ?? fileStringList(sources.file, origin.file))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  for (const domain of domains) assertHost(domain);
  return domains;
}

/**
 * Resolves the ingress settings — which are not about WHICH ingress, only about
 * what one needs to read this node. See {@link IngressConfig}.
 */
function resolveIngress(sources: Sources): IngressConfig | undefined {
  const entryPoints = resolveEntryPoints(sources);
  const token = resolveIngressTokens(sources);

  if (entryPoints === undefined) return token === undefined ? undefined : { token };
  return { ...(token === undefined ? {} : { token }), entryPoints };
}

/** Resolves Traefik entry points from a repeated flag, comma text or JSON. Empty
 * is rejected: Traefik otherwise attaches routers to every entry point. */
function resolveEntryPoints(sources: Sources): string[] | undefined {
  const origin: Origin = ORIGINS.traefikEntryPoints;
  const inline = listFlagOrEnv(origin, sources);

  if (inline === undefined) {
    const written = fileValue(sources.file, origin.file);
    if (written === undefined || written === null) return undefined;
  }

  const names = (inline ?? fileStringList(sources.file, origin.file))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (names.length === 0) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${origin.file}" must name at least one Traefik entryPoint, such as "web", or both ` +
        `with "--${origin.flag} web --${origin.flag} websecure": routers attached to none are ` +
        `attached to all of them`,
    });
  }
  return names;
}

/** Resolves explicit transport. Non-loopback configuration may not infer one. */
function resolveTransport(sources: Sources): TransportConfig | undefined {
  const driver = resolve("transport", sources);
  if (driver === undefined) return undefined;

  const modes: TransportMode[] = ["wireguard", "none"];
  if (!(modes as string[]).includes(driver)) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.transport.file}" must be one of ${modes.map((m) => `"${m}"`).join(", ")}, ` +
        `got ${JSON.stringify(driver)}`,
    });
  }
  return { driver: driver as TransportMode };
}

/** Resolves WireGuard fields. Transport validation decides whether both are required. */
function resolveWireguard(sources: Sources): WireguardConfig | undefined {
  const address = resolve("wgAddress", sources);
  const endpoint = resolve("wgEndpoint", sources);
  const port = resolvePort("wgPort", sources, DEFAULT_WIREGUARD_PORT);
  if (address === undefined && endpoint === undefined) return undefined;

  if (address !== undefined && parseInterfaceAddress(address) === null) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.wgAddress.file}" must be this node's tunnel address with its prefix ` +
        `length, such as "10.83.0.1/24", got ${JSON.stringify(address)}`,
    });
  }
  if (endpoint !== undefined) parseHostPort(endpoint, ORIGINS.wgEndpoint.file);

  return {
    ...(address === undefined ? {} : { address }),
    ...(endpoint === undefined ? {} : { endpoint }),
    port,
  };
}

async function readConfigFile(
  opts: LoadConfigOptions | undefined,
): Promise<Record<string, unknown> | undefined> {
  /* File access remains caller-injected to keep this loader runtime-agnostic. */
  const readFile = opts?.readFile ?? (async (): Promise<null> => null);
  const explicit = opts?.configPath;

  for (const path of explicit === undefined ? DEFAULT_CONFIG_PATHS : [explicit]) {
    const text = await readFile(path);
    if (text === null) continue;

    const document = parseJsoncDocument(text);
    if ("error" in document) {
      throw new ScafoError("invalid-input", "Config file is not valid JSONC", {
        detail: `"${path}" has a syntax error at character ${String(document.error.offset)}`,
      });
    }
    const parsed = document.value;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ScafoError("invalid-input", "Config file is not a JSON object", {
        detail: `"${path}" must hold an object of settings`,
      });
    }
    return parsed as Record<string, unknown>;
  }

  /* Explicit config paths must exist; default paths are optional. */
  if (explicit !== undefined) {
    throw new ScafoError("invalid-input", "Config file not found", {
      detail: `"${explicit}" could not be read`,
    });
  }
  return undefined;
}

/**
 * Walks a dotted key path (`bucket.endpoint`) through the parsed config file.
 *
 * Every step reads a key the file itself wrote: a document can name a setting
 * only by holding it, never by what it inherits.
 */
function fileValue(file: Record<string, unknown> | undefined, path: string): unknown {
  let current: unknown = file;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function fileStringList(file: Record<string, unknown> | undefined, path: string): string[] {
  const value = fileValue(file, path);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
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
