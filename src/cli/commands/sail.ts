/*
 * `scafo sail`: register this machine as a node of the fleet and serve the node
 * API.
 *
 * The machine sets sail — it joins the fleet and starts carrying work. Every
 * other command here acts on an installation from outside it; this is the one
 * that makes the machine it runs on part of one.
 */

import { join } from "node:path";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { createIngressCounters } from "../../daemon/access-counters.ts";
import type { DaemonContext } from "../../daemon/app.ts";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { createCoordinator } from "../../daemon/coordinator.ts";
import { createHeartbeat } from "../../daemon/heartbeat.ts";
import { createProcessHealth } from "../../daemon/_process-health.ts";
import { createObservability, OBSERVED_RING_SIZE } from "../../daemon/observe.ts";
import {
  createObserveFlusher,
  OBSERVE_FLUSH_INTERVAL_MS,
  OBSERVE_RETENTION_DAYS,
  type ObserveFlusher,
} from "../../daemon/observe-flush.ts";
import { parquetReadHint } from "../../daemon/observe-parquet.ts";
import { observeNodePrefix } from "../../core/registry/paths.ts";
import { createReconciler, runtimeBaseEnv } from "../../daemon/reconcile.ts";
import { startDaemon } from "../../daemon/serve.ts";
import { createStorageService } from "../../daemon/storage.ts";
import { DEFAULT_ARCHIVE_ENTRIES, DEFAULT_ARTIFACT_BYTES } from "../../core/types/deploy.ts";
import type { NodeVersions } from "../../core/types/registry.ts";
import { initRegistry, readMeta } from "../../core/registry/meta.ts";
import { createDeployService } from "../../daemon/deploys.ts";
import { createCelldDeployRunner } from "../../drivers/deploy/celld.ts";
import { createFileArtifactStager } from "../../drivers/artifact/file.ts";
import { type AccessLogTailer, createAccessLogTailer } from "../../drivers/observe/access-log.ts";
import { DEFAULT_ENTRY_POINT, renderTraefikConfig } from "../../drivers/ingress/traefik.ts";
import {
  createCelldDriver,
  probeCelldVersion,
  TELEMETRY_ENV,
} from "../../drivers/runtime/celld.ts";
import { createChildSupervisor } from "../../drivers/supervisor/child.ts";
import {
  assertTransportConfigured,
  createRegistry,
  drainThisNode,
  loadNodeIdentity,
  loadIngressTokens,
  loadWireguardRecord,
  nodeStateDir,
  registerThisNode,
} from "../_bootstrap.ts";
import { configFlags } from "../_flags.ts";
import { INGRESS_TOKEN_FILE, ingressTokenNotice } from "../_ingress-token.ts";
import { deprecatedAlias, readPackageVersion, readTextFile, reportFailure } from "../_utils.ts";

/* Flag names are kebab-case, matching the keys `loadDaemonConfig` reads them under. */
export const sailArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
  "node-id": { type: "string", description: "Id this node registers under" },
  "state-dir": { type: "string", description: "Directory this node keeps its identity in" },
  "node-labels": {
    type: "string",
    multiple: true,
    valueHint: "key=value",
    description: "What this node is, for applications to select on; one pair per flag",
  },
  "listen": { type: "string", description: "host:port the node API binds to" },
  "advertise": { type: "string", description: "host:port other nodes reach this one at" },
  "transport": { type: "string", description: "What carries peer traffic (wireguard, none)" },
  "wg-address": {
    type: "string",
    description: "This node's tunnel address with its prefix length (10.83.0.1/24)",
  },
  "wg-endpoint": {
    type: "string",
    description: "host:port peers send this node's tunnel traffic to",
  },
  "wg-port": { type: "string", description: "UDP port the tunnel interface listens on (51820)" },
  "platform-domains": {
    type: "string",
    multiple: true,
    valueHint: "domain",
    description: "Apex domain to serve; repeat the flag for several",
  },
  "ingress-token": {
    type: "string",
    multiple: true,
    valueHint: "token",
    description:
      "Token admitted on /v1/ingress and /v1/storage, instead of one this node mints: " +
      "repeat the flag to admit the previous one as well while a rotation is in flight, and " +
      "the first is written to the state directory's ingress-token file. Restart the daemon " +
      "before reloading the ingress",
  },
  "celld-bin": { type: "string", description: "Executable that runs an application" },
  "celld-env": {
    type: "string",
    multiple: true,
    valueHint: "NAME=value",
    description:
      "Upstream Celld variable for every runtime process; one pair per flag, and a value " +
      "written here may hold anything, commas included",
  },
  "port-range-start": { type: "string", description: "First port runtime processes use" },
  "port-range-end": {
    type: "string",
    description:
      "Last port runtime processes use; with --network host these are the HOST's ports, so " +
      "fit the range to the machine (24998)",
  },
  "port-quarantine-ms": {
    type: "string",
    description:
      "How long a port released on this node is kept from a different application, in " +
      "milliseconds, so nothing still routing there reaches another application (600000)",
  },
  "bind-host": { type: "string", description: "Address runtime processes bind their listeners to" },
  "registry-resync-ms": {
    type: "string",
    description:
      "How often this node re-reads the whole registry regardless of the change hint, " +
      "in milliseconds: the bound on a hint that never arrived (60000)",
  },
  "registry-node-refresh-ms": {
    type: "string",
    description:
      "How often this node re-reads the fleet's node records, in milliseconds; liveness is " +
      "the age of a heartbeat and no write announces a death (30000)",
  },
  "coordinator-lease-ttl-ms": {
    type: "string",
    description:
      "Lifetime written into the coordinator lease, in milliseconds; it is renewed at a " +
      "third of it (45000)",
  },
  "coordinator-reap-interval-ms": {
    type: "string",
    description: "Time between two reap passes while this node coordinates (600000)",
  },
  "artifact-bytes": {
    type: "string",
    description: "Maximum compressed and expanded bytes per deploy artifact",
  },
  "archive-entries": {
    type: "string",
    description: "Maximum entries per deploy archive",
  },
  "active-tasks": { type: "string", description: "Maximum active deploy tasks on this node" },
  "application-active-tasks": {
    type: "string",
    description: "Maximum active deploy tasks for one application",
  },
  "queued-tasks": { type: "string", description: "Maximum receiving and queued deploys" },
  "application-queued-tasks": {
    type: "string",
    description: "Maximum receiving and queued deploys for one application",
  },
  "staged-bytes": { type: "string", description: "Maximum staged deploy bytes on this node" },
  "application-staged-bytes": {
    type: "string",
    description: "Maximum staged deploy bytes for one application",
  },
  "receive-timeout-ms": {
    type: "string",
    description: "Artifact receive deadline in milliseconds",
  },
  "queue-timeout-ms": { type: "string", description: "Queued deploy deadline in milliseconds" },
  "task-timeout-ms": { type: "string", description: "Active deploy deadline in milliseconds" },
  "output-bytes": { type: "string", description: "Subprocess output tail retained in memory" },
  "observability": {
    type: "boolean",
    description:
      "Report what this node does: emit its own events, and give every runtime " +
      "process CELLD_OTEL=1 unless runtime.celldEnv already states it",
  },
  "ingress-access-log": {
    type: "string",
    description:
      "File the ingress writes its JSON access log to; the node follows it and counts " +
      "requests, bytes, statuses and latencies per application. Needs --observability",
  },
  "api-public": {
    type: "boolean",
    description:
      "Serve the fleet's API at each platform domain's own apex, so any node is reachable " +
      "at one well-known name (default on; --no-api-public leaves the apex unrouted and " +
      "without a certificate). /v1/storage and /v1/ingress/routes are never reachable there",
  },
  "json-bytes": {
    type: "string",
    description: "Maximum bytes accepted by a JSON API control request",
  },
  "traefik-entrypoints": {
    type: "string",
    multiple: true,
    valueHint: "name",
    description: "Traefik entryPoint the published routers attach to; repeat the flag for several",
  },
  "traefik-cert-resolver": {
    type: "string",
    valueHint: "name",
    description:
      "Certificate resolver from Traefik's own static configuration; the published routers " +
      "ask it for their certificates, one wildcard per base rather than one per host",
  },
  "ingress-acme-delegation": {
    type: "string",
    valueHint: "host",
    description:
      "Host this installation's ingress answers DNS-01 at, so whoever claims a domain " +
      'delegates "_acme-challenge.<domain>" to it with a CNAME; scafo only says it',
  },
};

export const sail: CommandDef = defineCommand({
  meta: { name: "sail", description: "Join this machine to the fleet and serve the node API" },
  args: sailArgs,
  async run({ args }): Promise<void> {
    try {
      await runDaemon(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

/** What `scafo sail` was called before the rename. Removed at launch. */
export const up: CommandDef = deprecatedAlias({
  name: "up",
  replacedBy: "scafo sail",
  command: sail,
});

async function runDaemon(flags: Record<string, unknown>): Promise<void> {
  const config = await loadDaemonConfig({
    configPath: typeof flags.config === "string" ? flags.config : undefined,
    flags: configFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  /* Checked before anything is written or bound: a node that should not be on
     this network must not have registered itself on it first. */
  assertTransportConfigured(config);
  /* Same reason, one step further in: a node whose transport is a tunnel it has
     never been set up on must not register an address its peers cannot reach. */
  const wireguard = await loadWireguardRecord(config);

  const state = await loadNodeIdentity(config);
  const ingressTokens = await loadIngressTokens(config);

  /*
   * BEFORE THE BUCKET IS EVEN OPENED. A node whose Celld is older than this
   * build supports must not touch the registry, let alone register itself as a
   * machine work can be placed on: the versions it would publish are the fleet's
   * only account of what is running where.
   */
  const celldBin = config.runtime.binPath;
  const celldVersion = await probeCelldVersion(celldBin);
  const version = await readPackageVersion();
  /* Said once and used twice: the record the fleet reads this node's binaries
     from, and what this node measures every other node's against. */
  const versions: NodeVersions = { scafo: version, celld: celldVersion };
  console.log(`scafo: celld ${celldVersion} at "${celldBin}"`);

  const registry = createRegistry(config);

  /* The first node to arrive bootstraps the registry, which also proves the
     bucket honours conditional writes before anything is written for real. */
  if ((await readMeta(registry)) === null) {
    await initRegistry(registry, { platformDomains: config.platformDomains });
  }

  await registerThisNode(registry, {
    config,
    state,
    versions,
    ...(wireguard === undefined ? {} : { wireguard }),
  });

  const supervisor = createChildSupervisor();
  /* What the node remembers about its own processes: the restarts, the exits and
     the last thing each one said. The supervisor reports an exit and forgets it;
     this is what turns a series of them into something an operator is told. */
  const processHealth = createProcessHealth();
  supervisor.onExit((status) => {
    /* Reporting only: deciding what to do about it belongs to the reconcile loop. */
    processHealth.exited(status);
    console.error(`scafo: process "${status.id}" exited with code ${String(status.exitCode)}`);
  });

  const daemon: DaemonContext = {
    config,
    nodeId: state.id,
    registry,
    supervisor,
    processHealth,
    versions,
    /* Kept for the node tokens this node will sign for calls to its peers. */
    signingKey: state.privateKey,
  };

  /*
   * ATTACHED ONLY WHILE IT IS ON, and that is the whole of what the switch costs
   * a node that leaves it off: every emission site reads `observability?.emit`,
   * so an absent seam means the events are never even built. The other half of
   * the switch — `CELLD_OTEL` under the operator's own `runtime.celldEnv` — was
   * settled by the loader and travels with the rest of that set.
   */
  const observability = createObservability({ enabled: config.observability.enabled });
  let accessLog: AccessLogTailer | undefined;
  let flusher: ObserveFlusher | undefined;
  if (observability.enabled) {
    daemon.observability = observability;
    /* Said once: the ring is a buffer rather than the record, and where the
       record actually ends up is the next line. */
    console.log(
      `scafo: observability on; this node records its own events in a ring of ` +
        `${String(OBSERVED_RING_SIZE)} and runs its processes with ${TELEMETRY_ENV}=1 unless ` +
        `"runtime.celldEnv" says otherwise`,
    );
    accessLog = attachIngressCounters(daemon, config.observability.ingressAccessLog);
    /* Built AFTER the counters, because it flushes them alongside the events and
       an adapter attached later would never be read. */
    flusher = createObserveFlusher(registry, {
      nodeId: state.id,
      observability,
      ...(daemon.ingressCounters === undefined ? {} : { counters: daemon.ingressCounters }),
    });
    /* Said once, because it is the only thing here that costs the operator
       money: this is what the node writes, where, and for how long it keeps it. */
    console.log(
      `scafo: flushing them to "${observeNodePrefix(state.id)}" every ` +
        `${String(OBSERVE_FLUSH_INTERVAL_MS / 1000)}s, keeping ` +
        `${String(OBSERVE_RETENTION_DAYS)} days; read them back with "scafo metrics" and ` +
        `"scafo traces", or ${parquetReadHint(observeNodePrefix(state.id))}`,
    );
  }

  /* Served by every node, because every ingress pulls: whatever stands in front
     of the fleet reads the fleet's routing from whichever node answers, and the
     entryPoints are the one thing about it a node has to be told. */
  const entryPoints = config.ingress?.entryPoints ?? [DEFAULT_ENTRY_POINT];
  const certResolver = config.ingress?.traefikCertResolver;
  daemon.ingressFormats = {
    traefik: (routing, { prefer }) =>
      renderTraefikConfig(routing, {
        entryPoints,
        prefer,
        ...(certResolver === undefined ? {} : { certResolver }),
      }),
  };

  /* Said once, at boot, because nothing else on this node ever will: an ingress
     that polls and was never pointed at the node API stays silent rather than
     failing, and the node looks like it is routing when nothing is reading it.
     The entryPoints come along because a Traefik router attached to one the
     operator does not define is a route that exists and matches nothing. */
  console.log(
    `scafo: this node serves the fleet's routing at /v1/ingress/routes (Caddy's ` +
      `"dynamic scafo") and /v1/ingress/routes/traefik?prefer=self (Traefik's http provider) ` +
      `on ${config.node.listen}, behind the ingress token; point your ingress there. Traefik ` +
      `routers attach to entryPoint(s) ${entryPoints.join(", ")}` +
      /* The resolver is Traefik's own, so the node says which name it wrote
         rather than anything about what that name does. */
      (certResolver === undefined
        ? ""
        : `, and ask the "${certResolver}" certificate resolver for their certificates`),
  );

  /* What a colocated ingress keeps its certificates, its account key and its
     issuance locks in: this node's bucket, reached through this node, which is
     the only process on the machine holding a credential for it. */
  const storage = createStorageService(daemon, { tokens: ingressTokens });
  daemon.storage = storage;
  /* Said once, because the operator has to act on it — and what they have to do
     depends on where the token came from: a minted one is distributed by the
     file, a supplied one arrived through their own configuration and the file is
     only there for whatever reads a path. */
  for (const line of ingressTokenNotice({
    path: join(nodeStateDir(config), INGRESS_TOKEN_FILE),
    supplied: config.ingress?.token?.length ?? 0,
  })) {
    console.log(line);
  }

  const baseEnv = runtimeBaseEnv(process.env);
  daemon.deploys = createDeployService(
    daemon,
    createCelldDeployRunner({
      binPath: celldBin,
      baseEnv: deployBaseEnv(process.env),
      artifactBytes: config.deploy?.artifactBytes ?? DEFAULT_ARTIFACT_BYTES,
      archiveEntries: config.deploy?.archiveEntries ?? DEFAULT_ARCHIVE_ENTRIES,
      outputBytes: config.deploy?.outputBytes,
    }),
    config.deploy === undefined
      ? undefined
      : {
          scheduler: {
            artifactBytes: config.deploy.artifactBytes,
            activeTasks: config.deploy.activeTasks,
            applicationActiveTasks: config.deploy.applicationActiveTasks,
            queuedTasks: config.deploy.queuedTasks,
            applicationQueuedTasks: config.deploy.applicationQueuedTasks,
            stagedBytes: config.deploy.stagedBytes,
            applicationStagedBytes: config.deploy.applicationStagedBytes,
            receiveTimeoutMs: config.deploy.receiveTimeoutMs,
            queueTimeoutMs: config.deploy.queueTimeoutMs,
            taskTimeoutMs: config.deploy.taskTimeoutMs,
          },
        },
  );
  daemon.artifactStager = createFileArtifactStager();

  const driver = createCelldDriver({
    binPath: celldBin,
    /* The same directory this node's identity and ingress token live in: what a
       supervised process works out of has to come back with the node. */
    stateDir: nodeStateDir(config),
    /* Where the ports each application holds are kept and probed: the range is
       this node's by convention only, and on a host network it is the host's. */
    portRange: { start: config.runtime.portRangeStart, end: config.runtime.portRangeEnd },
    portQuarantineMs: config.runtime.portQuarantineMs,
    bindHost: config.runtime.bindHost,
    ...(config.runtime.celldEnv === undefined ? {} : { operatorEnv: config.runtime.celldEnv }),
  });
  const reconciler = createReconciler(daemon, driver, {
    baseEnv,
  });
  daemon.reconciler = reconciler;

  /* Every node runs one and competes for the same lease; all but one stay
     candidates, and the loser takes over when the holder stops renewing. */
  const coordinator = createCoordinator(daemon);
  daemon.coordinator = coordinator;

  /* What tells the coordinator this node is still there. Without it the node is
     counted out after three intervals and its applications go elsewhere. */
  const heartbeat = createHeartbeat(daemon);
  daemon.heartbeat = heartbeat;

  const server = await startDaemon(daemon);
  console.log(`scafo ${version} listening on ${server.url} as node "${state.id}"`);
  /* Started AFTER the daemon, and at the log's current end: whatever the ingress
     served before this node came up was already served, and re-counting it on
     every restart would invent traffic. */
  await accessLog?.start();
  reconciler.start();
  coordinator.start();
  heartbeat.start();
  storage.start();
  /* Last of the loops to start and first to stop: everything above it is a
     source of what it writes, so it has nothing to do until they are running. */
  flusher?.start();

  await untilSignalled(async () => {
    /* CLOSED SYNCHRONOUSLY, before the first shutdown await below. The bucket
       and lease work can take time, and no timer may start a process while this
       node is already leaving. */
    const reconcilerShutdown = reconciler.shutdown();
    /*
     * Written FIRST, before anything is stopped: this is what tells placement
     * the node is leaving rather than dying, and every millisecond it is late is
     * a millisecond an application is still assigned to a node that is going
     * away. A heartbeat that lands between this write and the stop below cannot
     * undo it — a beat touches its own field and nothing else.
     *
     * Best effort by construction: it never throws, so a bucket that cannot be
     * reached delays the shutdown briefly and changes nothing else.
     */
    await drainThisNode(registry, state.id);
    await daemon.deploys?.stop(new Error("node is shutting down"));
    /* Stopped first among the loops: everything below still emits, and one
       final flush at the end writes what they emitted on the way out. */
    flusher?.stop();
    /* Stopped next: a node on its way out must stop saying it is available, so
       nothing keeps refreshing the record placement is about to stop reading. */
    heartbeat.stop();
    /* Same reason, for the locks: anything still held stops being restamped and
       is taken over by the next caller once it goes stale. */
    storage.stop();
    /* Given up next, and awaited: releasing the lease lets the next node take
       it at once instead of waiting out the TTL, and a coordinator still running
       would keep deleting on behalf of a node that is leaving. */
    await coordinator.stop();
    /* A pass that was active when shutdown closed intake may still be between
       activation and spawn, so it must quiesce before the final supervisor
       snapshot drains every runtime. */
    await reconcilerShutdown;
    /* Read to the end and closed before the listener goes, so the requests the
       ingress served while this node was shutting down are still counted. */
    await accessLog?.stop();
    /* AFTER the log has been read to its end and after every loop above has
       stopped emitting, so the last thing written is the whole of what this node
       saw — including the shutdown itself. Never throws. */
    await flusher?.flush();
    await server.close();
    await Promise.all(
      supervisor
        .list()
        .filter((status) => status.state === "running")
        .map((status) => supervisor.stop(status.id, { graceMs: driver.stopGraceMs })),
    );
  });
}

/**
 * The environment a publish runs with: the runtime's, plus Celld's own build
 * settings, each handed through unread when the daemon has it.
 *
 * `CELLD_ESBUILD`, `CELLD_DOCKER` and `CELLD_CONTAINER_PLATFORM` ARE BUILD-TIME
 * KNOBS OF CELLD'S, and the node that accepts the deploy is the machine they
 * describe: the bundler to run, the engine client that builds and pulls a
 * container class's image in place of `docker` on `PATH`, and the platform that
 * image is built for in place of `linux/amd64`. An operator who set them for the
 * daemon set them for the publish. Celld reads the last two in `celld deploy`
 * alone — a runtime process reaches its engine through the socket, never the
 * client — so they travel here and not with {@link runtimeBaseEnv}.
 * `CELLD_PYTHON_RUNTIME_DIR` is where a Python Worker's build keeps the Pyodide
 * files it downloads, and `CELLD_MAX_ASSET_FILE_BYTES` the per-file asset limit
 * the build enforces; Celld reads that limit on serving nodes too, which take it
 * through `runtime.celldEnv` like any other runtime policy.
 */
export function deployBaseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base = runtimeBaseEnv(env);
  for (const name of [
    "CELLD_ESBUILD",
    "CELLD_DOCKER",
    "CELLD_CONTAINER_PLATFORM",
    "CELLD_PYTHON_RUNTIME_DIR",
    "CELLD_MAX_ASSET_FILE_BYTES",
  ]) {
    const value = env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

/**
 * Attaches the per-request counters when an operator named the access log their
 * ingress writes, and returns the tailer that feeds them.
 *
 * ABSENT IS NOT A WARNING, IT IS THE ORDINARY CASE — an operator running their
 * own Caddy or Traefik simply never names one, and there is no default path
 * worth guessing. It is said ONCE, at boot, beside the switch that would have
 * used it, so a node that is observing itself and counting nothing is not a
 * mystery; nothing is said again on any pass.
 */
function attachIngressCounters(
  daemon: DaemonContext,
  path: string | undefined,
): AccessLogTailer | undefined {
  if (path === undefined) {
    console.log(
      `scafo: no ingress access log configured ("observability.ingressAccessLog", ` +
        `--ingress-access-log, or SCAFO_INGRESS_ACCESS_LOG), so this node counts no requests`,
    );
    return undefined;
  }

  const counters = createIngressCounters({ platformDomains: daemon.config.platformDomains });
  daemon.ingressCounters = counters;
  console.log(
    `scafo: counting what the ingress serves from "${path}"; requests, bytes, statuses ` +
      `and latencies are kept per application, in memory, since this boot`,
  );

  return createAccessLogTailer({
    path,
    onLine: (line) => {
      counters.ingest(line);
    },
    /* Said once per distinct failure rather than once per poll: a log this node
       may not read would otherwise print every second for as long as it runs. */
    onError: (error) => {
      console.error(
        `scafo: ingress access log "${path}" could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
}

/** Runs until the operator or the init system asks the node to stop, then shuts it down once. */
function untilSignalled(shutdown: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`scafo: ${signal} received, shutting down`);
      shutdown().then(resolve, reject);
    };

    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
  });
}
