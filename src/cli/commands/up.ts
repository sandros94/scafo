/* `scafo up`: register this machine as a node and serve the agent API. */

import { join } from "node:path";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { AgentContext } from "../../agent/app.ts";
import { loadAgentConfig } from "../../agent/config.ts";
import { createCoordinator } from "../../agent/coordinator.ts";
import { createHeartbeat } from "../../agent/heartbeat.ts";
import { createReconciler, runtimeBaseEnv } from "../../agent/reconcile.ts";
import { startAgent } from "../../agent/serve.ts";
import { createStorageService } from "../../agent/storage.ts";
import { probeCapacity } from "../../core/capacity/reader.ts";
import { initRegistry, readMeta } from "../../core/registry/meta.ts";
import { wakeActivity } from "../../core/registry/wake.ts";
import { createDeployService } from "../../agent/deploys.ts";
import { createCelldDeployRunner } from "../../drivers/deploy/celld.ts";
import { createNodeHostReader } from "../../drivers/host/node.ts";
import { createCaddyDriver } from "../../drivers/ingress/caddy.ts";
import { createTraefikDriver, DEFAULT_ENTRY_POINT } from "../../drivers/ingress/traefik.ts";
import { createCelldDriver } from "../../drivers/runtime/celld.ts";
import { createChildSupervisor } from "../../drivers/supervisor/child.ts";
import {
  assertTransportConfigured,
  createRegistry,
  drainThisNode,
  loadNodeIdentity,
  loadStorageToken,
  loadVarsetKey,
  loadWireguardRecord,
  nodeStateDir,
  registerThisNode,
} from "../_bootstrap.ts";
import { STORAGE_TOKEN_FILE } from "../_storage-token.ts";
import { readPackageVersion, readTextFile, reportFailure } from "../_utils.ts";

/* Flag names are kebab-case, matching the keys `loadAgentConfig` reads them under. */
const upArgs: ArgsDef = {
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
  "listen": { type: "string", description: "host:port the agent API binds to" },
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
  "celld-bin": { type: "string", description: "Executable that runs an environment" },
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
  "pointer-hold-ms": {
    type: "string",
    description:
      "Milliseconds a rollout holds the deployment pointer past the spawn; " +
      "size it to the store's worst request stall (0 = release at the spawn)",
  },
  "probe-path": { type: "string", description: "Path the application readiness probe requests" },
  "ingress-driver": { type: "string", description: "Ingress this node drives (caddy, traefik)" },
  "caddy-admin": { type: "string", description: "Base URL of the Caddy admin API" },
  "caddy-server": { type: "string", description: "Caddy server the node writes its routes into" },
  "traefik-entrypoints": {
    type: "string",
    description: "Traefik entryPoints the published routers attach to (web,websecure)",
  },
};

export const up: CommandDef = defineCommand({
  meta: { name: "up", description: "Start the node agent" },
  args: upArgs,
  async run({ args }): Promise<void> {
    try {
      await runAgent(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

async function runAgent(flags: Record<string, unknown>): Promise<void> {
  const config = await loadAgentConfig({
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

  const state = await loadNodeIdentity(config);
  const storageToken = await loadStorageToken(config);
  const varsetKey = await loadVarsetKey(config);
  const registry = createRegistry(config);

  /* The first node to arrive bootstraps the registry, which also proves the
     bucket honours conditional writes before anything is written for real. */
  if ((await readMeta(registry)) === null) {
    await initRegistry(registry, { platformDomains: config.platformDomains });
  }

  const capacity = await probeCapacity(createNodeHostReader());
  await registerThisNode(registry, {
    config,
    state,
    capacity,
    ...(wireguard === undefined ? {} : { wireguard }),
  });

  const supervisor = createChildSupervisor();
  supervisor.onExit((status) => {
    /* Reporting only: deciding what to do about it belongs to the reconcile loop. */
    console.error(`scafo: process "${status.id}" exited with code ${String(status.exitCode)}`);
  });

  const version = await readPackageVersion();
  const agent: AgentContext = {
    config,
    nodeId: state.id,
    registry,
    supervisor,
    version,
    capacity,
    /* Kept for the node tokens this node will sign for calls to its peers. */
    signingKey: state.privateKey,
  };
  if (varsetKey !== undefined) agent.varsetKey = varsetKey;

  /* What the ingress dials for a process: loopback while processes bind a
     wildcard (loopback is among what a wildcard answers on), and the EXACT
     configured address otherwise — a process bound to a tunnel address alone
     answers nothing on 127.0.0.1, however local the caller is. */
  const upstreamHost = ["0.0.0.0", "::"].includes(config.runtime.bindHost)
    ? "127.0.0.1"
    : config.runtime.bindHost;

  const ingress = config.ingress;
  if (ingress === undefined) {
    /* Said once, at boot: a node with no ingress runs its processes and keeps
       them to itself, which is a legitimate way to run one and not a warning
       worth repeating on every reconcile pass. */
    console.log("scafo: no ingress configured, nothing on this node will be routed to");
  } else if (ingress.driver === "traefik") {
    agent.ingress = createTraefikDriver({
      upstreamHost,
      ...(ingress.entryPoints === undefined ? {} : { entryPoints: ingress.entryPoints }),
    });
    /* Worth saying once, because nothing else on this node will: an ingress that
       polls and was never pointed at the agent stays silent rather than failing,
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
    agent.ingress = createCaddyDriver({
      adminUrl: ingress.adminUrl,
      serverName: ingress.serverName,
      upstreamHost,
    });
  }

  /* What a colocated ingress keeps its certificates, its account key and its
     issuance locks in: this node's bucket, reached through this node, which is
     the only process on the machine holding a credential for it. */
  const storage = createStorageService(agent, { token: storageToken });
  agent.storage = storage;
  /* Said once, because the operator has to go get it: the file is what a
     colocated ingress presents to store its TLS material through this node. */
  console.log(
    `scafo: storage token at ${join(nodeStateDir(config), STORAGE_TOKEN_FILE)}; ` +
      `mount it read-only into the process that terminates TLS`,
  );

  const baseEnv = runtimeBaseEnv(process.env);
  agent.deploys = createDeployService(
    agent,
    createCelldDeployRunner({ binPath: config.runtime.binPath, baseEnv }),
  );

  /* The driver writes deployment pointers through the same store the registry
     uses, so a configured key prefix applies to fleets exactly as it does to
     records. */
  const driver = createCelldDriver({
    binPath: config.runtime.binPath,
    store: registry.store,
    durability: config.runtime.durability,
    cellIdleEvictS: config.runtime.cellIdleEvictS,
    probeHost: upstreamHost,
  });
  /* The hold is the operator's, because it is sized to THEIR store: it is how
     long a rollout keeps the environment's deployment pointer after the spawn,
     for the one read the new process makes of it. */
  const reconciler = createReconciler(agent, driver, {
    baseEnv,
    pointerLock: { holdMs: config.runtime.pointerHoldMs },
  });
  agent.reconciler = reconciler;

  /* Every node runs one and competes for the same lease; all but one of them
     stay candidates, and the loser takes over the moment the holder stops
     renewing. Its reaper reads idleness off the wake stamps, which is the same
     record parking is derived from: one notion of "last asked for", so an
     environment is never reaped as idle while something is still waking it. */
  const coordinator = createCoordinator(agent, { activity: wakeActivity(registry) });
  agent.coordinator = coordinator;

  /* What tells the coordinator this node is still there. Without it the node is
     counted out after three intervals and its environments go elsewhere. */
  const heartbeat = createHeartbeat(agent);

  const server = await startAgent(agent);
  console.log(`scafo ${version} listening on ${server.url} as node "${state.id}"`);
  reconciler.start();
  coordinator.start();
  heartbeat.start();
  storage.start();

  await untilSignalled(async () => {
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
    /* Stopped next: a pass that started while the node was shutting down would
       start processes this shutdown is about to leave behind. */
    reconciler.stop();
    await server.close();
    await Promise.all(
      supervisor
        .list()
        .filter((status) => status.state === "running")
        .map((status) => supervisor.stop(status.id, { graceMs: driver.stopGraceMs })),
    );
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

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
