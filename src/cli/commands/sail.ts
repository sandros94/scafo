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
import { loadDaemonConfig, runtimeDialHost } from "../../daemon/config.ts";
import { createCoordinator } from "../../daemon/coordinator.ts";
import { createHeartbeat } from "../../daemon/heartbeat.ts";
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
import { initRegistry, readMeta } from "../../core/registry/meta.ts";
import { wakeActivity } from "../../core/registry/wake.ts";
import { createDeployService } from "../../daemon/deploys.ts";
import { assertCreditAdmission, createCreditController } from "../../daemon/_credit-controller.ts";
import { createCelldDeployRunner } from "../../drivers/deploy/celld.ts";
import { createFileArtifactStager } from "../../drivers/artifact/file.ts";
import { createNodeHostReader } from "../../drivers/host/node.ts";
import { type AccessLogTailer, createAccessLogTailer } from "../../drivers/observe/access-log.ts";
import { createCaddyDriver } from "../../drivers/ingress/caddy.ts";
import { createTraefikDriver, DEFAULT_ENTRY_POINT } from "../../drivers/ingress/traefik.ts";
import { createCelldDriver, TELEMETRY_ENV } from "../../drivers/runtime/celld.ts";
import { createChildSupervisor } from "../../drivers/supervisor/child.ts";
import {
  assertTransportConfigured,
  createRegistry,
  drainThisNode,
  loadNodeIdentity,
  loadStorageTokens,
  loadVarsetKey,
  loadWireguardRecord,
  nodeStateDir,
  probeNodeCredits,
  registerThisNode,
} from "../_bootstrap.ts";
import { creditArgs } from "../_credit-args.ts";
import { STORAGE_TOKEN_FILE, storageTokenNotice } from "../_storage-token.ts";
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
    description: "What this node is, for environments to select on (region=eu-west-1,tier=fast)",
  },
  "listen": { type: "string", description: "host:port the node API binds to" },
  "internal-listen": { type: "string", description: "host:port for node-to-node traffic" },
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
  "platform-domains": { type: "string", description: "Comma-separated apex domains to serve" },
  "varset-key-file": { type: "string", description: "File holding the varset encryption key" },
  "storage-token": {
    type: "string",
    description:
      "Token(s) admitted on /v1/storage, instead of one this node mints: new,old admits both " +
      "while a rotation is in flight, and the first is written to the state directory's " +
      "storage-token file. Restart the daemon before reloading what stores through it",
  },
  "celld-bin": { type: "string", description: "Executable that runs an environment" },
  "celld-env": {
    type: "string",
    description:
      "Extra variables for every runtime process, NAME=value,NAME2=value2 (CELLD_OTEL=1); " +
      "a value cannot contain a comma here — write those as runtime.celldEnv in the config file",
  },
  "port-range-start": { type: "string", description: "First port runtime processes use" },
  "bind-host": { type: "string", description: "Address runtime processes bind their listeners to" },
  "durability": {
    type: "string",
    description: 'When a write is durable: "bucket" (default) or "fleet" (ack at follower fsync)',
  },
  "cell-idle-evict": {
    type: "string",
    description: "Seconds a cell may sit idle before eviction frees its memory (0 = never)",
  },
  ...creditArgs,
  "artifact-bytes": {
    type: "string",
    description: "Maximum compressed and expanded bytes per deploy artifact",
  },
  "archive-entries": {
    type: "string",
    description: "Maximum entries per deploy archive",
  },
  "active-tasks": { type: "string", description: "Maximum active deploy tasks on this node" },
  "project-active-tasks": {
    type: "string",
    description: "Maximum active deploy tasks for one project",
  },
  "queued-tasks": { type: "string", description: "Maximum receiving and queued deploys" },
  "project-queued-tasks": {
    type: "string",
    description: "Maximum receiving and queued deploys for one project",
  },
  "staged-bytes": { type: "string", description: "Maximum staged deploy bytes on this node" },
  "project-staged-bytes": {
    type: "string",
    description: "Maximum staged deploy bytes for one project",
  },
  "receive-timeout-ms": {
    type: "string",
    description: "Artifact receive deadline in milliseconds",
  },
  "queue-timeout-ms": { type: "string", description: "Queued deploy deadline in milliseconds" },
  "task-timeout-ms": { type: "string", description: "Active deploy deadline in milliseconds" },
  "output-bytes": { type: "string", description: "Subprocess output tail retained in memory" },
  "probe-path": { type: "string", description: "Path the application readiness probe requests" },
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
      "requests, bytes, statuses and latencies per environment. Needs --observability",
  },
  "api-public": {
    type: "boolean",
    description:
      "Serve the fleet's API at each platform domain's own apex, so any node is reachable " +
      "at one well-known name (default on; --no-api-public leaves the apex unrouted and " +
      "without a certificate). /v1/storage and /v1/ingress/traefik are never reachable there",
  },
  "json-bytes": {
    type: "string",
    description: "Maximum bytes accepted by a JSON API control request",
  },
  "ingress-driver": { type: "string", description: "Ingress this node drives (caddy, traefik)" },
  "caddy-admin": { type: "string", description: "Base URL of the Caddy admin API" },
  "caddy-server": { type: "string", description: "Caddy server the node writes its routes into" },
  "traefik-entrypoints": {
    type: "string",
    description: "Traefik entryPoints the published routers attach to (web,websecure)",
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
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  /* Checked before anything is written or bound: a node that should not be on
     this network must not have registered itself on it first. */
  assertTransportConfigured(config);
  /* Same reason, one step further in: a node whose transport is a tunnel it has
     never been set up on must not register an address its peers cannot reach. */
  const wireguard = await loadWireguardRecord(config);

  /* Capacity is local boot configuration. Refuse an unusable node before the
     registry bootstrap can mutate the shared bucket. */
  const { capacity, credits: creditProfile } = await probeNodeCredits(
    config,
    createNodeHostReader(),
  );
  const runtimeCreditMb = creditProfile.runtimeMb;
  const credits = createCreditController({
    allocatableMb: creditProfile.allocatableMb,
    surgeMb: runtimeCreditMb,
  });
  const deployCreditMb = creditProfile.deployMb;
  assertCreditAdmission(credits, runtimeCreditMb, deployCreditMb);

  const state = await loadNodeIdentity(config);
  const storageTokens = await loadStorageTokens(config);
  const varsetKey = await loadVarsetKey(config);
  const registry = createRegistry(config);

  /* The first node to arrive bootstraps the registry, which also proves the
     bucket honours conditional writes before anything is written for real. */
  if ((await readMeta(registry)) === null) {
    await initRegistry(registry, { platformDomains: config.platformDomains });
  }

  await registerThisNode(registry, {
    config,
    state,
    capacity,
    credits: creditProfile,
    ...(wireguard === undefined ? {} : { wireguard }),
  });

  const supervisor = createChildSupervisor();
  supervisor.onExit((status) => {
    /* Reporting only: deciding what to do about it belongs to the reconcile loop. */
    console.error(`scafo: process "${status.id}" exited with code ${String(status.exitCode)}`);
  });

  const version = await readPackageVersion();
  const daemon: DaemonContext = {
    config,
    nodeId: state.id,
    registry,
    supervisor,
    version,
    capacity,
    credits,
    /* Kept for the node tokens this node will sign for calls to its peers. */
    signingKey: state.privateKey,
  };
  if (varsetKey !== undefined) daemon.varsetKey = varsetKey;

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

  /* What every dialer of a process this node starts uses — the ingress here, the
     readiness gate below, and the wake surface's own hop, which reads it off the
     same configuration. */
  const upstreamHost = runtimeDialHost(config.runtime);

  const ingress = config.ingress;
  if (ingress === undefined) {
    /* Said once, at boot: a node with no ingress runs its processes and keeps
       them to itself, which is a legitimate way to run one and not a warning
       worth repeating on every reconcile pass. */
    console.log("scafo: no ingress configured, nothing on this node will be routed to");
  } else if (ingress.driver === "traefik") {
    daemon.ingress = createTraefikDriver({
      upstreamHost,
      ...(ingress.entryPoints === undefined ? {} : { entryPoints: ingress.entryPoints }),
    });
    /* Worth saying once, because nothing else on this node will: an ingress that
       polls and was never pointed at the node API stays silent rather than failing,
       and the node looks like it is routing when nothing is reading it. The
       entryPoints are said too, because a router attached to one the operator's
       Traefik does not define is a route that exists and matches nothing. */
    console.log(
      `scafo: ingress "traefik" reads this node's routing from ` +
        `/v1/ingress/traefik on ${config.node.listen}; point its http provider there. ` +
        `Routers attach to entryPoint(s) ` +
        `${(ingress.entryPoints ?? [DEFAULT_ENTRY_POINT]).join(", ")}`,
    );
  } else {
    daemon.ingress = createCaddyDriver({
      adminUrl: ingress.adminUrl,
      serverName: ingress.serverName,
      upstreamHost,
    });
  }

  /* What a colocated ingress keeps its certificates, its account key and its
     issuance locks in: this node's bucket, reached through this node, which is
     the only process on the machine holding a credential for it. */
  const storage = createStorageService(daemon, { tokens: storageTokens });
  daemon.storage = storage;
  /* Said once, because the operator has to act on it — and what they have to do
     depends on where the token came from: a minted one is distributed by the
     file, a supplied one arrived through their own configuration and the file is
     only there for whatever reads a path. */
  for (const line of storageTokenNotice({
    path: join(nodeStateDir(config), STORAGE_TOKEN_FILE),
    supplied: config.storage?.token?.length ?? 0,
  })) {
    console.log(line);
  }

  const baseEnv = runtimeBaseEnv(process.env);
  daemon.deploys = createDeployService(
    daemon,
    createCelldDeployRunner({
      binPath: config.runtime.binPath,
      baseEnv,
      artifactBytes: config.deploy?.artifactBytes ?? DEFAULT_ARTIFACT_BYTES,
      archiveEntries: config.deploy?.archiveEntries ?? DEFAULT_ARCHIVE_ENTRIES,
      outputBytes: config.deploy?.outputBytes,
    }),
    config.deploy === undefined
      ? undefined
      : {
          scheduler: {
            credits,
            creditMb: config.deploy.creditMb,
            artifactBytes: config.deploy.artifactBytes,
            activeTasks: config.deploy.activeTasks,
            projectActiveTasks: config.deploy.projectActiveTasks,
            queuedTasks: config.deploy.queuedTasks,
            projectQueuedTasks: config.deploy.projectQueuedTasks,
            stagedBytes: config.deploy.stagedBytes,
            projectStagedBytes: config.deploy.projectStagedBytes,
            receiveTimeoutMs: config.deploy.receiveTimeoutMs,
            queueTimeoutMs: config.deploy.queueTimeoutMs,
            taskTimeoutMs: config.deploy.taskTimeoutMs,
          },
        },
  );
  daemon.artifactStager = createFileArtifactStager();

  const driver = createCelldDriver({
    binPath: config.runtime.binPath,
    durability: config.runtime.durability,
    cellIdleEvictS: config.runtime.cellIdleEvictS,
    probeHost: upstreamHost,
    ...(config.runtime.celldEnv === undefined ? {} : { operatorEnv: config.runtime.celldEnv }),
  });
  const reconciler = createReconciler(daemon, driver, {
    baseEnv,
  });
  daemon.reconciler = reconciler;

  /* Every node runs one and competes for the same lease; all but one of them
     stay candidates, and the loser takes over the moment the holder stops
     renewing. Its reaper reads idleness off the wake stamps, which is the same
     record parking is derived from: one notion of "last asked for", so an
     environment is never reaped as idle while something is still waking it. */
  const coordinator = createCoordinator(daemon, { activity: wakeActivity(registry) });
  daemon.coordinator = coordinator;

  /* What tells the coordinator this node is still there. Without it the node is
     counted out after three intervals and its environments go elsewhere. */
  const heartbeat = createHeartbeat(daemon);

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
       and lease work can take time, and no timer, wake or credit release may
       start a process while this node is already leaving. */
    const reconcilerShutdown = reconciler.shutdown();
    /*
     * Written FIRST, before anything is stopped: this is what tells placement
     * the node is leaving rather than dying, and every millisecond it is late is
     * a millisecond an environment is still assigned to a node that is going
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
      `and latencies are kept per environment, in memory, since this boot`,
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

/**
 * The declared flags that were actually given; anything else the parser adds is
 * not configuration.
 *
 * A switch reaches the loader as the text that loader accepts for one. Only a
 * flag the operator actually WROTE gets here — an unpassed boolean is undefined
 * rather than false — so a `--flag` says on, a `--no-flag` says off, and a flag
 * nobody wrote leaves the environment and the config file to answer.
 */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
    else if (typeof value === "boolean") given[name] = value ? "true" : "false";
  }
  return given;
}
