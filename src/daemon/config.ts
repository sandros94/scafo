/*
 * Daemon configuration, merged from a JSONC file, the environment and the command
 * line — each source overriding the one before it.
 *
 * The loader is runtime-agnostic: reading files is injected by the caller (the
 * CLI hands in a reader backed by `node:fs`), so nothing here imports a runtime.
 */

import { type JSONCParseError, parseJSONC } from "confbox";
import { DEFAULT_DAEMON_OVERHEAD_MB, DEFAULT_MEMORY_FRACTION } from "../core/capacity/compute.ts";
import { ScafoError } from "../core/error.ts";
import { assertPositiveSafeInteger } from "../core/utils/number.ts";
import { DEFAULT_ARCHIVE_ENTRIES, DEFAULT_ARTIFACT_BYTES } from "../core/types/deploy.ts";
import { DEFAULT_PORT_RANGE_START } from "../core/placement/ports.ts";
import { assertNodeId } from "../core/registry/paths.ts";
import type { TransportConfig, TransportMode } from "../core/types/transport.ts";
import { assertEnvVars, parseEnvVars } from "../core/utils/env.ts";
import { assertHost, isHost, parseInterfaceAddress } from "../core/utils/host.ts";
import { assertLabels, parseLabels } from "../core/utils/labels.ts";
/* Names only, taken from the driver that writes them so the two can never
   drift: what an operator may not hand a runtime process is decided by what the
   driver derives for itself, and a copy here would go stale the first time that
   list grew. */
import { IDLE_EVICT_ENV, RESERVED_ENV, TELEMETRY_ENV } from "../drivers/runtime/celld.ts";
import { DEFAULT_RUNTIME_CREDIT_MB } from "./_credit-controller.ts";
import { DEFAULT_JSON_BYTES } from "./_json.ts";
import {
  DEFAULT_ACTIVE_TASKS,
  DEFAULT_DEPLOY_CREDIT_MB,
  DEFAULT_OUTPUT_BYTES,
  DEFAULT_PROJECT_ACTIVE_TASKS,
  DEFAULT_PROJECT_QUEUED_TASKS,
  DEFAULT_PROJECT_STAGED_BYTES,
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
    /**
     * Id this node registers under, when the operator pins one. Absent leaves it
     * to the node's persistent state, which generates an id on first boot and
     * keeps it thereafter — pinning a different one replaces that identity.
     */
    id?: string;
    /** `host:port` the node API binds to. */
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
    /**
     * What this node IS, as the operator describes it: `region=eu-west-1`,
     * `tier=fast`, `gpu=a100`. An environment's node selector is matched against
     * these, and nothing else reads them.
     *
     * BOOT CONFIGURATION: they are written into the node's record on every
     * registration, which replaces that record wholesale, so this file is the
     * single source of truth for them and a label taken out of it is gone from
     * the fleet's view of this node on the next start.
     */
    labels?: Record<string, string>;
  };
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /** How this node derives the allocatable memory-credit pool it owns. */
  capacity?: CapacityConfig;
  /** How this node runs and gates the processes that serve its environments. */
  runtime: RuntimeConfig;
  /** Resource bounds applied independently while receiving and expanding deploys. */
  deploy?: DeployConfig;
  /** Whether this node reports on itself at all. Off unless it was turned on. */
  observability: ObservabilityConfig;
  /** Whether the fleet's API answers at the platform domains' own apexes. */
  api: ApiConfig;
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
   * The tokens this node admits on its storage surface, when the operator chose
   * them. Absent leaves the node minting one and keeping it in its state
   * directory, which is what every installation did before this existed.
   */
  storage?: StorageConfig;
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
  /** Whole MiB one active deploy reserves until artifact cleanup succeeds. */
  creditMb?: number;
  /** Maximum received compressed bytes and, independently, expanded bytes. */
  artifactBytes: number;
  /** Maximum entries in one tar archive. */
  archiveEntries: number;
  activeTasks: number;
  projectActiveTasks: number;
  queuedTasks: number;
  projectQueuedTasks: number;
  stagedBytes: number;
  projectStagedBytes: number;
  receiveTimeoutMs: number;
  queueTimeoutMs: number;
  taskTimeoutMs: number;
  outputBytes: number;
}

/** Tunables of the node-wide memory-credit pool. */
export interface CapacityConfig {
  /** Share of probed memory allocatable to runtime and deploy credit. */
  memoryFraction: number;
  /** Whole MiB held back for the daemon before allocating credit. */
  daemonOverheadMb: number;
}

/**
 * What an operator stated about this node's WireGuard interface.
 *
 * `address` and `endpoint` are both required of a node whose transport is
 * `wireguard` — the first is what the interface is given and what peers route
 * to, the second is what peers send its traffic to — but they are optional here
 * because a half-written pair must be reported as the missing setting it is,
 * naming the flag and the variable, rather than as a parse failure.
 */
export interface WireguardConfig {
  /** The node's own address on the tunnel, with its prefix length: `10.83.0.1/24`. */
  address?: string;
  /** `host:port` peers reach this node's tunnel at: `203.0.113.7:51820`. */
  endpoint?: string;
  /** UDP port the interface listens on; {@link DEFAULT_WIREGUARD_PORT} by default. */
  port: number;
}

/**
 * Whether this node reports on itself, which is ONE switch and not a set of
 * them.
 *
 * OFF BY DEFAULT, and turning it on does exactly two things. The daemon starts
 * emitting the events its own seams are instrumented with, into a bounded
 * in-memory ring (`src/daemon/observe.ts`); and every runtime process this node
 * spawns is given {@link TELEMETRY_ENV}`=1` as a DEFAULT UNDER
 * {@link RuntimeConfig.celldEnv}, so a node that is observing itself is also
 * running a runtime that is. An operator who states that variable themselves
 * wins in both directions — theirs is what the process gets, `0` included.
 *
 * Nothing else changes: no listener, no route, no bucket write. The one cost of
 * leaving it off is that the ring is never allocated and the emission sites are
 * never even evaluated.
 */
export interface ObservabilityConfig {
  enabled: boolean;
  /**
   * File the operator's ingress writes its JSON access log to, when the node
   * should count the requests it records.
   *
   * A SEPARATE SWITCH, AND IT IS OPT-IN BY PRESENCE. Application traffic goes
   * ingress → process and never touches the node API, so per-request numbers can only come off the
   * ingress's own log, and only an operator knows where their ingress writes it
   * or whether it writes one at all. Absent means no adapter, no error and no
   * warning: bringing your own ingress is simply never naming this.
   *
   * ONLY MEANINGFUL WHILE {@link ObservabilityConfig.enabled} IS ON, and naming
   * one with observability off is REFUSED rather than ignored — a file nothing
   * would ever read is a misreading of the surface worth telling the operator
   * about while they are still looking at what they wrote.
   */
  ingressAccessLog?: string;
}

/**
 * Whether each platform domain's BARE APEX serves the fleet's API, which is ONE
 * switch and it is ON.
 *
 * `dev.example.com` is the name every `<project>.dev.example.com` hangs off and
 * nothing has ever served it — the wildcard does not cover it, so it is refused
 * a certificate too. Turning this on makes it the installation's front door: the
 * ingress routes it to the node's own daemon, and because the registry lives in
 * the bucket, ANY node answers ANY call — so a CI job, a CLI or a dashboard has
 * one well-known name to reach the fleet at, whichever machine picks the request
 * up. `/v1/ingress/ask` approves the apex while this is on, which is what lets
 * on-demand issuance mint the certificate the wildcard never covered.
 *
 * NOTHING IS OPENED BY IT. Every route keeps the token gating it already had,
 * and the two surfaces that are unauthenticated because they are COLOCATED —
 * `/v1/storage`, which carries private keys, and `/v1/ingress/traefik`, which is
 * the node's whole routing map — are excluded from the apex AT THE INGRESS, by
 * both drivers, and never reach the daemon through it. Health and the on-demand
 * ask stay reachable: they answer yes or no about names that are already public.
 *
 * Off, the apex is refused a certificate and routed nowhere, exactly as before
 * this existed.
 */
export interface ApiConfig {
  public: boolean;
  /** Maximum bytes accepted by any JSON control request. */
  jsonBytes: number;
}

/** How this node gets at the variables its environments are configured with. */
export interface VarsetsConfig {
  /** File holding the 32-byte AES-256 key, raw or as base64url or hex text. */
  keyFile: string;
}

/**
 * The tokens an operator chose for this node's `/v1/storage` surface, in place
 * of the one the node would mint for itself.
 *
 * SUPPLYING ANY REPLACES MINTING ENTIRELY: nothing random is generated, every
 * listed value is admitted, and the FIRST is written to the state directory's
 * token file at the permissions a minted one gets — so every consumer that reads
 * that file goes on working unchanged, and one value an operator holds can
 * configure both the node and whatever stores through it.
 *
 * IT IS A LIST BECAUSE ROTATION IS EXPAND-CONTRACT, driven by the operator in
 * two deliberate steps: set `[new, old]` and restart the daemon, which admits
 * both; move the callers onto the new one at whatever pace suits them; then
 * contract to `[new]` and restart again, which is the moment the old one stops
 * working. Nothing is remembered between boots and no grace period runs down —
 * the set in the configuration is the set that is admitted, and the file holds
 * whichever token is first in it.
 *
 * THE DAEMON MOVES FIRST AND THE CALLERS FOLLOW, in both phases. An ingress
 * reloaded onto a token this node does not admit yet cannot refill its
 * certificate cache from storage, which is exactly what a reload makes it do;
 * the other order costs nothing, because a token that is still listed still
 * works.
 *
 * A SOLO INSTALLATION MAY SIMPLY SWAP ONE VALUE. This surface is off the TLS
 * handshake path — a running ingress serves from the certificate cache in its
 * own memory — so the gap between restarting the node and reloading what stores
 * through it costs background renewals, OCSP refreshes and the issuance of names
 * being seen for the first time, all of which are retried.
 */
export interface StorageConfig {
  /** Every token admitted, primary first. Never empty. */
  token: [string, ...string[]];
}

/**
 * Which ingress a node drives, and how it is reached.
 *
 * The two implemented ingresses are reached in opposite directions, which is why
 * only one of them has settings here. `caddy` is PUSHED: the node calls its admin
 * API, so it must be told where that is. `traefik` PULLS: the node renders its
 * routing and serves it at `/v1/ingress/traefik`, and it is the operator's
 * Traefik that is configured with the address — in Traefik's own static
 * configuration, which scafo neither writes nor reads.
 */
export interface IngressConfig {
  /** Which ingress this node drives; anything else fails the boot. */
  driver: IngressDriverName;
  /** Base URL of the Caddy admin API; the driver's own default applies when absent. */
  adminUrl?: string;
  /** Caddy server this node writes its routes into. */
  serverName?: string;
  /**
   * Traefik entryPoints the rendered routers attach to — `["web", "websecure"]`
   * for a Traefik terminating TLS on the second one. The driver's own default
   * applies when absent, and naming any is only meaningful with that driver.
   *
   * The list is never empty: Traefik reads an absent `entryPoints` as "every
   * entryPoint there is", which includes the ones scafo has no business on.
   */
  entryPoints?: string[];
}

/** Every ingress a node can drive. */
export type IngressDriverName = "caddy" | "traefik";

/** The ingresses that can be configured, in the order a refusal lists them. */
const INGRESS_DRIVERS: IngressDriverName[] = ["caddy", "traefik"];

/** Every runtime setting, with the defaults already applied. */
export interface RuntimeConfig {
  /** Executable that runs one environment; resolved against `PATH` unless it is a path. */
  binPath: string;
  /** First port of the range runtime processes are given pairs from. */
  portRangeStart: number;
  /**
   * Address runtime processes bind their listeners to. Loopback by default,
   * which is everything a single node needs.
   *
   * A fleet spread over several nodes needs more: one process owns each cell,
   * and the others reach it at the address this node advertises — which nothing
   * answers on while the listeners are on loopback. Widening it exposes a peer
   * listener that carries no authentication of its own, so a non-loopback value
   * refuses to boot until `transport` says what network that is.
   */
  bindHost: string;
  /**
   * When the runtime calls a write durable. `"bucket"` acknowledges a write
   * once it is in the bucket, so losing every node at once loses nothing.
   * `"fleet"` acknowledges at follower fsync and uploads behind — much faster
   * writes and far fewer storage operations on a fleet of two or more nodes,
   * paid for by needing at least one holder of the log to survive; on a single
   * node the two behave identically. A per-installation trade, so it is
   * configuration here rather than a default anywhere else.
   */
  durability: DurabilityMode;
  /**
   * Seconds a cell may sit idle before the runtime evicts it from memory,
   * `0` to never evict. Eviction is transparent to the application — the
   * cell's state is in the bucket and the next request restores it — so this
   * is a RAM-density dial, paid for with a sub-second restore on the first
   * request after a quiet spell. The runtime's own default is "never", a
   * default set when eviction was still unsafe; here it is on.
   */
  cellIdleEvictS: number;
  /** Whole MiB one serving runtime reserves once runtime wiring lands. */
  creditMb?: number;
  /**
   * Variables handed to every runtime process this node spawns, on top of the
   * ones the settings above are turned into. The escape hatch for what has no
   * typed setting of its own — the runtime's own telemetry switches above all
   * (`CELLD_OTEL`, and the `CELLD_OTEL_*` tuning beside it), which nothing else
   * can reach a process with: the environment the daemon was started from is
   * passed on as a narrow allowlist, and none of these are on it.
   *
   * Absent when the operator handed over none. A name the runtime driver writes
   * ITSELF is refused here rather than dropped at the process: those are derived
   * from this node's configuration and from the ports its processes bound, so a
   * value set here would never take effect, and an operator who set one is owed
   * the refusal while they are still reading their own configuration.
   */
  celldEnv?: Record<string, string>;
}

/**
 * Names no `runtime.celldEnv` may carry, taken from the driver that writes them.
 *
 * Idle eviction is listed apart from the rest only because it is the driver's
 * for a different reason — it is a node policy with a setting of its own — and
 * the refusal below points at that setting by name.
 */
const DRIVER_ENV: string[] = [IDLE_EVICT_ENV, ...RESERVED_ENV];

/** The two answers to "when is a write durable", in the order a refusal lists them. */
export type DurabilityMode = "bucket" | "fleet";
const DURABILITY_MODES: DurabilityMode[] = ["bucket", "fleet"];

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
export const DEFAULT_CONFIG_PATHS: string[] = ["./scafo.config.jsonc", "./scafo.config.json"];

/** Signing region used when none is configured; harmless for stores that ignore it. */
export const DEFAULT_REGION: string = "us-east-1";

/** Loopback by default: the node API is only safe on a trusted network. */
export const DEFAULT_LISTEN: string = "127.0.0.1:7400";

/** Command that runs an environment when none is configured. */
export const DEFAULT_RUNTIME_BIN: string = "celld";

/** Address runtime processes bind to when none is configured: loopback only. */
export const DEFAULT_BIND_HOST: string = "127.0.0.1";

/** Bind addresses that answer on every address of the host, loopback included. */
const WILDCARD_BIND_HOSTS: string[] = ["0.0.0.0", "::"];

/** Durability when none is configured: a write acknowledged is a write in the bucket. */
export const DEFAULT_DURABILITY: DurabilityMode = "bucket";

/** Idle-cell eviction age when none is configured: fifteen minutes. */
export const DEFAULT_CELL_IDLE_EVICT_S: number = 900;

/** UDP port a WireGuard interface listens on when none is configured. */
export const DEFAULT_WIREGUARD_PORT: number = 51_820;

/**
 * Whether the platform apexes serve the fleet's API when nobody said: yes.
 *
 * ON is the default because the apex answered NOTHING before this — no route, no
 * certificate — so there is no behaviour to preserve and every installation
 * gains one name its tooling can reach it at. What the switch is FOR is the
 * operator who wants that name for something else, or who keeps their API off
 * the public internet entirely.
 */
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
  const internalListen = resolve("internalListen", sources);
  const configuredAdvertise = resolve("advertise", sources);
  const id = resolve("nodeId", sources);
  const stateDir = resolve("stateDir", sources);
  const labels = resolveNodeLabels(sources);

  /* Parsed for their side effect: an unusable address must fail the boot, not
     the first request that tries to use it. */
  if (configuredListen !== undefined) parseHostPort(configuredListen, ORIGINS.listen.file);
  const internalAddress =
    internalListen === undefined
      ? undefined
      : parseHostPort(internalListen, ORIGINS.internalListen.file);
  if (configuredAdvertise !== undefined) {
    parseHostPort(configuredAdvertise, ORIGINS.advertise.file);
  }
  if (id !== undefined) assertNodeId(id);

  const ingress = resolveIngress(sources);
  const observing = resolveBoolean("observability", sources, false);
  const ingressAccessLog = resolveIngressAccessLog(sources, observing);
  /* Composed HERE rather than in the driver: the runtime's telemetry switch is
     one more variable an operator may state, so the node's own switch has to
     meet it where the variables are resolved and lose to it if it is there. */
  const celldEnv = withTelemetry(resolveCelldEnv(sources), observing);
  const keyFile = resolve("varsetKeyFile", sources);
  const storageTokens = resolveStorageTokens(sources);
  const transport = resolveTransport(sources);
  const wireguard = resolveWireguard(sources);

  /*
   * Inside a tunnel, the only address that means anything is the tunnel's. A
   * node told to run WireGuard therefore puts its whole surface there — the
   * daemon listener, the address it advertises, and the runtime processes —
   * rather than on loopback no peer can reach or on a wildcard that names no
   * interface a peer could dial.
   *
   * All three remain plain defaults: anything the operator wrote wins. They
   * move together on purpose, because advertising an address the listener never
   * bound is a node whose peers are refused by it and told nothing.
   */
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
    (tunnelHost === undefined
      ? undefined
      : formatHostPort(tunnelHost, (internalAddress ?? listenAddress).port));

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
      internalListen,
      advertise,
      stateDir,
      ...(labels === undefined ? {} : { labels }),
    },
    platformDomains: resolvePlatformDomains(sources),
    capacity: {
      memoryFraction: resolveFraction("memoryFraction", sources, DEFAULT_MEMORY_FRACTION),
      daemonOverheadMb: resolvePositiveSafeInteger(
        "daemonOverheadMb",
        sources,
        DEFAULT_DAEMON_OVERHEAD_MB,
      ),
    },
    runtime: {
      binPath: resolve("celldBin", sources) ?? DEFAULT_RUNTIME_BIN,
      portRangeStart: resolvePort("portRangeStart", sources, DEFAULT_PORT_RANGE_START),
      bindHost: resolveBindHost(sources) ?? tunnelHost ?? DEFAULT_BIND_HOST,
      durability: resolveDurability(sources) ?? DEFAULT_DURABILITY,
      cellIdleEvictS: resolveCellIdleEvict(sources),
      creditMb: resolvePositiveSafeInteger("runtimeCreditMb", sources, DEFAULT_RUNTIME_CREDIT_MB),
      ...(celldEnv === undefined ? {} : { celldEnv }),
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
    ...(keyFile === undefined ? {} : { varsets: { keyFile } }),
    ...(storageTokens === undefined ? {} : { storage: { token: storageTokens } }),
    ...(transport === undefined ? {} : { transport }),
    ...(wireguard === undefined ? {} : { wireguard }),
  };
}

/** Writes `host:port`, bracketing an IPv6 literal the way a URL authority does. */
export function formatHostPort(host: string, port: number): string {
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${literal}:${String(port)}`;
}

/**
 * Where other nodes should reach this one: the advertised address wins, then the
 * internal listener, then the daemon's own.
 */
export function advertisedAddress(node: DaemonConfig["node"]): HostPort {
  if (node.advertise !== undefined) return parseHostPort(node.advertise, "node.advertise");
  if (node.internalListen !== undefined) {
    return parseHostPort(node.internalListen, "node.internalListen");
  }
  return parseHostPort(node.listen, "node.listen");
}

/**
 * Where THIS NODE dials a runtime process it started, which is wherever that
 * process BINDS: loopback while the listeners are on a wildcard (loopback is
 * among what a wildcard answers on), and the EXACT configured address otherwise
 * — a process bound to a tunnel address alone answers nothing on `127.0.0.1`,
 * however local the caller is.
 *
 * The ingress routes are rendered against this address (`upstreamHost` on both
 * ingress drivers).
 */
export function runtimeDialHost(runtime: DaemonConfig["runtime"]): string {
  return WILDCARD_BIND_HOSTS.includes(runtime.bindHost) ? DEFAULT_BIND_HOST : runtime.bindHost;
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
  /* A bracketed literal is taken as given; anything else must be a DNS name or
     an IPv4 address, both of which are plain lowercase labels. */
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

/**
 * Every configurable setting and the sources that can carry it. The `AWS_*` and
 * `S3_*` names are accepted below the `SCAFO_*` ones so a shell already set up
 * for the bucket works, without letting it override an explicit scafo setting.
 */
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
  internalListen: {
    flag: "internal-listen",
    env: ["SCAFO_INTERNAL_LISTEN"],
    file: "node.internalListen",
  },
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
  bindHost: { flag: "bind-host", env: ["SCAFO_BIND_HOST"], file: "runtime.bindHost" },
  durability: { flag: "durability", env: ["SCAFO_DURABILITY"], file: "runtime.durability" },
  cellIdleEvictS: {
    flag: "cell-idle-evict",
    env: ["SCAFO_CELL_IDLE_EVICT"],
    file: "runtime.cellIdleEvictS",
  },
  memoryFraction: {
    flag: "memory-fraction",
    env: ["SCAFO_MEMORY_FRACTION"],
    file: "capacity.memoryFraction",
  },
  daemonOverheadMb: {
    flag: "daemon-overhead-mb",
    env: ["SCAFO_DAEMON_OVERHEAD_MB"],
    file: "capacity.daemonOverheadMb",
  },
  runtimeCreditMb: {
    flag: "runtime-credit-mb",
    env: ["SCAFO_RUNTIME_CREDIT_MB"],
    file: "runtime.creditMb",
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
  deployCreditMb: {
    flag: "deploy-credit-mb",
    env: ["SCAFO_DEPLOY_CREDIT_MB"],
    file: "deploy.creditMb",
  },
  projectActiveTasks: {
    flag: "project-active-tasks",
    env: ["SCAFO_PROJECT_ACTIVE_TASKS"],
    file: "deploy.projectActiveTasks",
  },
  queuedTasks: { flag: "queued-tasks", env: ["SCAFO_QUEUED_TASKS"], file: "deploy.queuedTasks" },
  projectQueuedTasks: {
    flag: "project-queued-tasks",
    env: ["SCAFO_PROJECT_QUEUED_TASKS"],
    file: "deploy.projectQueuedTasks",
  },
  stagedBytes: { flag: "staged-bytes", env: ["SCAFO_STAGED_BYTES"], file: "deploy.stagedBytes" },
  projectStagedBytes: {
    flag: "project-staged-bytes",
    env: ["SCAFO_PROJECT_STAGED_BYTES"],
    file: "deploy.projectStagedBytes",
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
  ingressDriver: {
    flag: "ingress-driver",
    env: ["SCAFO_INGRESS_DRIVER"],
    file: "ingress.driver",
  },
  caddyAdmin: { flag: "caddy-admin", env: ["SCAFO_CADDY_ADMIN"], file: "ingress.adminUrl" },
  caddyServer: { flag: "caddy-server", env: ["SCAFO_CADDY_SERVER"], file: "ingress.serverName" },
  traefikEntryPoints: {
    flag: "traefik-entrypoints",
    env: ["SCAFO_TRAEFIK_ENTRYPOINTS"],
    file: "ingress.entryPoints",
  },
  varsetKeyFile: {
    flag: "varset-key-file",
    env: ["SCAFO_VARSET_KEY_FILE"],
    file: "varsets.keyFile",
  },
  storageToken: { flag: "storage-token", env: ["SCAFO_STORAGE_TOKEN"], file: "storage.token" },
  transport: { flag: "transport", env: ["SCAFO_TRANSPORT"], file: "transport.driver" },
  wgAddress: { flag: "wg-address", env: ["SCAFO_WG_ADDRESS"], file: "wireguard.address" },
  wgEndpoint: { flag: "wg-endpoint", env: ["SCAFO_WG_ENDPOINT"], file: "wireguard.endpoint" },
  wgPort: { flag: "wg-port", env: ["SCAFO_WG_PORT"], file: "wireguard.port" },
} satisfies Record<string, Origin>;

/**
 * How one WireGuard setting is asked for, spelled out in every way it can be
 * given. What the refusal for a missing one is written from, so an operator
 * reading it does not have to find the documentation first.
 */
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
  throw new ScafoError("invalid-input", "Missing required configuration", {
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
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail: `"${origin.file}" must be a port in 1-65535, got ${JSON.stringify(raw)}`,
    });
  }
  return value;
}

function resolvePositiveSafeInteger(setting: Setting, sources: Sources, fallback: number): number {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  assertPositiveSafeInteger(value, origin.file);
  return value;
}

function resolveFraction(setting: Setting, sources: Sources, fallback: number): number {
  const origin: Origin = ORIGINS[setting];
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail: `"${origin.file}" must be greater than 0 and at most 1, got ${JSON.stringify(raw)}`,
    });
  }
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
    creditMb: resolvePositiveSafeInteger("deployCreditMb", sources, DEFAULT_DEPLOY_CREDIT_MB),
    artifactBytes: resolvePositiveSafeInteger("artifactBytes", sources, DEFAULT_ARTIFACT_BYTES),
    archiveEntries: resolvePositiveSafeInteger("archiveEntries", sources, DEFAULT_ARCHIVE_ENTRIES),
    activeTasks: resolvePositiveSafeInteger("activeTasks", sources, DEFAULT_ACTIVE_TASKS),
    projectActiveTasks: resolvePositiveSafeInteger(
      "projectActiveTasks",
      sources,
      DEFAULT_PROJECT_ACTIVE_TASKS,
    ),
    queuedTasks: resolveNonNegativeSafeInteger("queuedTasks", sources, DEFAULT_QUEUED_TASKS),
    projectQueuedTasks: resolveNonNegativeSafeInteger(
      "projectQueuedTasks",
      sources,
      DEFAULT_PROJECT_QUEUED_TASKS,
    ),
    stagedBytes: resolvePositiveSafeInteger("stagedBytes", sources, DEFAULT_STAGED_BYTES),
    projectStagedBytes: resolvePositiveSafeInteger(
      "projectStagedBytes",
      sources,
      DEFAULT_PROJECT_STAGED_BYTES,
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

  for (const [project, global] of [
    ["projectActiveTasks", "activeTasks"],
    ["projectQueuedTasks", "queuedTasks"],
    ["projectStagedBytes", "stagedBytes"],
  ] as const) {
    if (deploy[project] > deploy[global]) {
      throw new ScafoError("invalid-input", "Invalid deploy limits", {
        detail: `"deploy.${project}" must not exceed "deploy.${global}"`,
      });
    }
  }
  for (const field of ["stagedBytes", "projectStagedBytes"] as const) {
    if (deploy[field] < deploy.artifactBytes) {
      throw new ScafoError("invalid-input", "Invalid deploy byte limits", {
        detail: `"deploy.${field}" must be at least "deploy.artifactBytes"`,
      });
    }
  }
  return deploy;
}

/**
 * A switch, in every spelling the sources can carry it.
 *
 * The config file holds the JSON boolean; a flag and an environment variable can
 * only carry text, so `"1"`, `"true"`, `"0"` and `"false"` are accepted for it,
 * in any case. Anything else is REFUSED rather than read as false: a switch
 * silently off is the failure mode this whole surface exists to avoid, and
 * `SCAFO_OBSERVABILITY=yes` is a node the operator believes is reporting.
 */
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

/**
 * The variables every runtime process gets, with the runtime's own telemetry
 * switch turned on UNDER them when this node is observing itself.
 *
 * The escape hatch stays the escape hatch: a `runtime.celldEnv` that names
 * {@link TELEMETRY_ENV} is left exactly as it was written, whichever value it
 * holds, because an operator who turned the runtime's telemetry OFF while the
 * daemon reports on itself has stated something the node has no business
 * overruling. The default only ever fills a gap.
 */
function withTelemetry(
  configured: Record<string, string> | undefined,
  observing: boolean,
): Record<string, string> | undefined {
  if (!observing) return configured;
  if (configured?.[TELEMETRY_ENV] !== undefined) return configured;
  return { ...configured, [TELEMETRY_ENV]: "1" };
}

/**
 * The ingress access log this node counts requests off, or undefined when the
 * operator named none — which is the ordinary case and not a warning.
 *
 * NAMING ONE WITH OBSERVABILITY OFF IS REFUSED. The two are separate switches on
 * purpose: observability is what this node reports about ITSELF, and the access
 * log is the only complete account of what its ingress served. But the second
 * only ever feeds the first, so a file named while the first is off is a file
 * nothing opens — an operator who wrote it believes they are counting requests
 * and is not, which is exactly the silent-off failure this surface refuses
 * everywhere else.
 */
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

/**
 * The address runtime processes bind to, or undefined when the operator named
 * none. A bare host rather than `host:port`: the ports come from the allocator,
 * and only the interface is configurable.
 *
 * Undefined rather than the default, because the caller has one more thing to
 * consider first — a node inside a tunnel binds to the tunnel.
 */
function resolveBindHost(sources: Sources): string | undefined {
  const value = resolve("bindHost", sources);
  if (value === undefined) return undefined;

  /* `0.0.0.0` and `::` are not DNS names, but they are the whole point of this
     setting — the wildcards that make a process reachable from another node. */
  if (value !== "0.0.0.0" && value !== "::" && !isHost(value)) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.bindHost.file}" must be an address runtime processes can bind, ` +
        `such as "127.0.0.1" or "0.0.0.0", got ${JSON.stringify(value)}`,
    });
  }
  return value;
}

/** The idle-cell eviction age in seconds, `0` for never, defaulted when unnamed. */
function resolveCellIdleEvict(sources: Sources): number {
  const origin: Origin = ORIGINS.cellIdleEvictS;
  const raw = flagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CELL_IDLE_EVICT_S;

  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(value) || value < 0) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${origin.file}" must be a whole number of seconds, ` +
        `with 0 meaning cells are never evicted for being idle, got ${JSON.stringify(raw)}`,
    });
  }
  return value;
}

/** The configured durability mode, or undefined when the operator named none. */
function resolveDurability(sources: Sources): DurabilityMode | undefined {
  const value = resolve("durability", sources);
  if (value === undefined) return undefined;

  if (!(DURABILITY_MODES as string[]).includes(value)) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.durability.file}" must be one of ` +
        `${DURABILITY_MODES.map((mode) => JSON.stringify(mode)).join(", ")}, ` +
        `got ${JSON.stringify(value)}`,
    });
  }
  return value as DurabilityMode;
}

/**
 * What this node says it is, or undefined when the operator said nothing.
 *
 * Two spellings, because the sources can carry two shapes: a flag and an
 * environment variable can only hold text, so they are written `k=v,k2=v2`,
 * while the config file holds the object that text parses into. The inline form
 * wins whole rather than merging with the file's — labels describe one machine,
 * and a set half-stated in two places is one nobody can read off either.
 */
function resolveNodeLabels(sources: Sources): Record<string, string> | undefined {
  const origin: Origin = ORIGINS.nodeLabels;

  const inline = flagOrEnv(origin, sources);
  if (inline !== undefined) return parseLabels(inline, `"${origin.file}"`);

  const value = fileValue(sources.file, origin.file);
  if (value === undefined || value === null) return undefined;

  assertLabels(value, `"${origin.file}"`);
  return { ...value };
}

/**
 * The variables an operator hands every runtime process, or undefined when they
 * handed over none.
 *
 * Two spellings, as the node labels have: a flag and an environment variable can
 * only carry text, written `NAME=value,NAME2=value2`, while the config file
 * carries the object that text parses into. A VALUE MAY NOT CONTAIN A COMMA in
 * the inline form — the separator wins — so a value that needs one is written in
 * the config file, which has no such limit. The inline form replaces the file's
 * whole set rather than merging into it, for the reason labels do: a set
 * half-stated in two places is one nobody can read off either.
 *
 * A name the runtime driver derives for itself is refused here, naming the
 * variable, because this is the last moment an operator is still looking at
 * what they wrote — the process would simply overwrite it and say nothing.
 */
function resolveCelldEnv(sources: Sources): Record<string, string> | undefined {
  const origin: Origin = ORIGINS.celldEnv;
  const inline = flagOrEnv(origin, sources);

  let vars: Record<string, string>;
  if (inline === undefined) {
    const value = fileValue(sources.file, origin.file);
    if (value === undefined || value === null) return undefined;

    assertEnvVars(value, `"${origin.file}"`);
    vars = { ...value };
  } else {
    vars = parseEnvVars(inline, `"${origin.file}"`);
  }

  for (const name of Object.keys(vars)) {
    if (!DRIVER_ENV.includes(name)) continue;

    throw new ScafoError("invalid-input", "Reserved environment variable", {
      detail:
        `"${origin.file}" sets "${name}", which the runtime driver writes itself from this ` +
        `node's configuration and from the listeners its processes bind — a value set here ` +
        `is overwritten and never reaches the application. Drop it, or state it through the ` +
        `setting that owns it, such as "${ORIGINS.durability.file}" or ` +
        `"${ORIGINS.cellIdleEvictS.file}"`,
    });
  }
  return Object.keys(vars).length === 0 ? undefined : vars;
}

/**
 * The tokens an operator supplied for the storage surface, or undefined when
 * they supplied none and this node is to mint its own.
 *
 * Two spellings, as the Traefik entryPoints have: a flag and an environment
 * variable can only carry text, written `new,old`, while the config file carries
 * that same text or the array it parses into. AN ARRAY ENTRY IS TAKEN WHOLE,
 * which is how a value carrying the separator is written; anywhere a string
 * appears, a comma separates one token from the next.
 *
 * A VALUE THAT IS THERE AND HOLDS NOTHING IS REFUSED rather than read as unset.
 * An empty spelling is what an unnamed variable expands to, and minting over it
 * would leave the node admitting a token nothing else on the host has ever seen
 * — every call the operator's own caller makes refused, for a reason neither of
 * them states anywhere.
 */
function resolveStorageTokens(sources: Sources): [string, ...string[]] | undefined {
  const origin: Origin = ORIGINS.storageToken;
  const written = suppliedFlagOrEnv(origin, sources) ?? fileValue(sources.file, origin.file);
  if (written === undefined || written === null) return undefined;

  const spellings: unknown = typeof written === "string" ? written.split(",") : written;
  if (!Array.isArray(spellings) || spellings.some((entry) => typeof entry !== "string")) {
    throw refuseStorageTokens(written, "must be a token, or a list of them");
  }

  const tokens = (spellings as string[]).map((entry) => entry.trim());
  const [primary, ...rest] = tokens;
  if (tokens.length === 0 || tokens.some((token) => token === "")) {
    throw refuseStorageTokens(
      written,
      "names no token, and an entry holding nothing would admit a caller presenting nothing",
    );
  }
  return [primary, ...rest];
}

/** The one refusal the storage tokens get, whichever source carried the value. */
function refuseStorageTokens(written: unknown, why: string): ScafoError {
  const origin: Origin = ORIGINS.storageToken;
  return new ScafoError("invalid-input", "Invalid configuration value", {
    detail:
      `"${origin.file}" (--${origin.flag}, or ${origin.env.join(" or ")}) ${why}, got ` +
      `${JSON.stringify(written)}. Write one token, several separated by commas, or an array of ` +
      `them with the one in use first; leave the setting out altogether to have this node mint ` +
      `its own instead`,
  });
}

/**
 * The first flag or variable that CARRIES a setting at all, blank or not.
 *
 * {@link flagOrEnv} reads a blank value as unset, which is right for a setting
 * that has a default and wrong for one whose absence changes what the node does:
 * that difference has to reach the resolver rather than being flattened here.
 */
function suppliedFlagOrEnv(origin: Origin, sources: Sources): string | undefined {
  const flag = sources.flags[origin.flag];
  if (flag !== undefined) return flag;

  for (const variable of origin.env) {
    const value = sources.env[variable];
    if (value !== undefined) return value;
  }
  return undefined;
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
 * Naming a Caddy admin API is enough to ask for Caddy: it was the only driver
 * when the setting was introduced, and a configuration that already worked must
 * go on working. Every other ingress is asked for by name. Configuring nothing
 * but a server name leaves the ingress off, because nothing says where to reach
 * it.
 *
 * A setting belonging to the OTHER ingress is REFUSED rather than ignored, in
 * both directions. The two are configured from opposite ends — Caddy is told
 * where its admin API is, Traefik is told which of ITS entryPoints the routers
 * this node publishes should attach to — so an operator who wrote one against
 * the other has misread which of them applies, and silently dropping half of
 * what they wrote leaves a node routing through an ingress they did not think
 * they had selected.
 */
function resolveIngress(sources: Sources): IngressConfig | undefined {
  const driver = resolve("ingressDriver", sources);
  const adminUrl = resolve("caddyAdmin", sources);
  const serverName = resolve("caddyServer", sources);
  const entryPoints = resolveEntryPoints(sources);

  /* An entryPoint list turns the ingress on for the same reason an admin URL
     does — so that naming one under the wrong driver is refused below rather
     than dropped on the floor. */
  if (driver === undefined && adminUrl === undefined && entryPoints === undefined) return undefined;
  if (driver !== undefined && !(INGRESS_DRIVERS as string[]).includes(driver)) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.ingressDriver.file}" must be one of ` +
        `${INGRESS_DRIVERS.map((name) => `"${name}"`).join(", ")}, got ${JSON.stringify(driver)}`,
    });
  }

  const selected: IngressDriverName = (driver as IngressDriverName | undefined) ?? "caddy";
  if (selected === "caddy") {
    refuseForeign(
      [[ORIGINS.traefikEntryPoints, entryPoints]],
      (named) =>
        `${named} configures Traefik, but "${ORIGINS.ingressDriver.file}" selects "caddy", ` +
        `which this node pushes its routing to through the admin API and which has no ` +
        `entryPoints — those belong to Traefik, whose routers attach to them. Drop the ` +
        `Traefik setting, or select "traefik"`,
    );
  } else {
    refuseForeign(
      [
        [ORIGINS.caddyAdmin, adminUrl],
        [ORIGINS.caddyServer, serverName],
      ],
      (named) =>
        `${named} configures Caddy, but "${ORIGINS.ingressDriver.file}" selects ` +
        `"${selected}", which has no admin API this node calls — it reads the routing the ` +
        `node publishes instead. Drop the Caddy setting, or select "caddy"`,
    );
  }

  return {
    driver: selected,
    ...(adminUrl === undefined ? {} : { adminUrl }),
    ...(serverName === undefined ? {} : { serverName }),
    ...(entryPoints === undefined ? {} : { entryPoints }),
  };
}

/**
 * The Traefik entryPoints this node's routers attach to, or undefined when the
 * operator named none.
 *
 * Two spellings, as the node labels have: a flag and an environment variable can
 * only carry text, written `web,websecure`, while the config file carries the
 * array that text parses into.
 *
 * A list that parses to nothing is REFUSED rather than left empty, because empty
 * does not mean empty here: Traefik reads routers with no entryPoints as
 * attached to EVERY entryPoint it has — a TLS listener scafo holds no
 * certificate for, the port the dashboard is on — so the quiet reading of a
 * mistyped list claims far more surface than was offered.
 */
function resolveEntryPoints(sources: Sources): string[] | undefined {
  const origin: Origin = ORIGINS.traefikEntryPoints;
  const inline = flagOrEnv(origin, sources);

  if (inline === undefined) {
    const written = fileValue(sources.file, origin.file);
    if (written === undefined || written === null) return undefined;
  }

  const names = (
    inline === undefined ? fileStringList(sources.file, origin.file) : inline.split(",")
  )
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (names.length === 0) {
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${origin.file}" must name at least one Traefik entryPoint, such as "web" or ` +
        `"web,websecure": routers attached to none are attached to all of them`,
    });
  }
  return names;
}

/** Refuses the settings that belong to the ingress this node is NOT driving. */
function refuseForeign(
  settings: Array<[Origin, string | string[] | undefined]>,
  detail: (named: string) => string,
): void {
  const written = settings.filter(([, value]) => value !== undefined);
  if (written.length === 0) return;

  const named = written
    .map(([origin, value]) => `"${origin.file}" (--${origin.flag}) = ${JSON.stringify(value)}`)
    .join(" and ");
  throw new ScafoError("invalid-input", "Conflicting ingress configuration", {
    detail: detail(named),
  });
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
    throw new ScafoError("invalid-input", "Invalid configuration value", {
      detail:
        `"${ORIGINS.transport.file}" must be one of ${modes.map((m) => `"${m}"`).join(", ")}, ` +
        `got ${JSON.stringify(driver)}`,
    });
  }
  return { driver: driver as TransportMode };
}

/**
 * Where this node sits on the tunnel, or undefined when nothing was configured.
 *
 * A missing half is left missing rather than refused here: whether it is
 * required at all depends on the transport, and the refusal that knows the
 * answer is the one that boots the node. What IS refused is a value that could
 * never work — an address without a prefix length, an endpoint that is not
 * `host:port` — because those are typos wherever they were written.
 */
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
      throw new ScafoError("invalid-input", "Config file is not valid JSONC", {
        detail: `"${path}" has a syntax error at character ${String(failure.offset)}`,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ScafoError("invalid-input", "Config file is not a JSON object", {
        detail: `"${path}" must hold an object of settings`,
      });
    }
    return parsed as Record<string, unknown>;
  }

  /* A named file that is not there is a typo worth reporting; the defaults are
     only defaults, so their absence means "everything comes from elsewhere". */
  if (explicit !== undefined) {
    throw new ScafoError("invalid-input", "Config file not found", {
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
