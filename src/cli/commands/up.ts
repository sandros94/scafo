/* `scalo up`: register this machine as a node and serve the agent API. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { AgentContext } from "../../agent/app.ts";
import { loadAgentConfig } from "../../agent/config.ts";
import { createCoordinator } from "../../agent/coordinator.ts";
import { createHeartbeat } from "../../agent/heartbeat.ts";
import { createReconciler, runtimeBaseEnv } from "../../agent/reconcile.ts";
import { startAgent } from "../../agent/serve.ts";
import { probeCapacity } from "../../core/capacity/reader.ts";
import { initRegistry, readMeta } from "../../core/registry/meta.ts";
import { createDeployService } from "../../agent/deploys.ts";
import { createCelldDeployRunner } from "../../drivers/deploy/celld.ts";
import { createNodeHostReader } from "../../drivers/host/node.ts";
import { createCaddyDriver } from "../../drivers/ingress/caddy.ts";
import { createCelldDriver } from "../../drivers/runtime/celld.ts";
import { createChildSupervisor } from "../../drivers/supervisor/child.ts";
import {
  assertTransportConfigured,
  createRegistry,
  loadNodeIdentity,
  loadVarsetKey,
  loadWireguardRecord,
  registerThisNode,
} from "../_bootstrap.ts";
import { readPackageVersion, readTextFile, reportFailure } from "../_utils.ts";

/* Flag names are kebab-case, matching the keys `loadAgentConfig` reads them under. */
const upArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scalo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
  "node-id": { type: "string", description: "Id this node registers under" },
  "state-dir": { type: "string", description: "Directory this node keeps its identity in" },
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
  "probe-path": { type: "string", description: "Path the application readiness probe requests" },
  "ingress-driver": { type: "string", description: "Ingress this node drives (caddy)" },
  "caddy-admin": { type: "string", description: "Base URL of the Caddy admin API" },
  "caddy-server": { type: "string", description: "Caddy server the node writes its routes into" },
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
    console.error(`scalo: process "${status.id}" exited with code ${String(status.exitCode)}`);
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

  const ingress = config.ingress;
  if (ingress === undefined) {
    /* Said once, at boot: a node with no ingress runs its processes and keeps
       them to itself, which is a legitimate way to run one and not a warning
       worth repeating on every reconcile pass. */
    console.log("scalo: no ingress configured, nothing on this node will be routed to");
  } else {
    agent.ingress = createCaddyDriver({
      adminUrl: ingress.adminUrl,
      serverName: ingress.serverName,
    });
  }

  const baseEnv = runtimeBaseEnv(process.env);
  agent.deploys = createDeployService(
    agent,
    createCelldDeployRunner({ binPath: config.runtime.binPath, baseEnv }),
  );

  /* The driver writes deployment pointers through the same store the registry
     uses, so a configured key prefix applies to fleets exactly as it does to
     records. */
  const driver = createCelldDriver({ binPath: config.runtime.binPath, store: registry.store });
  const reconciler = createReconciler(agent, driver, { baseEnv });
  agent.reconciler = reconciler;

  /* Every node runs one and competes for the same lease; all but one of them
     stay candidates, and the loser takes over the moment the holder stops
     renewing. */
  const coordinator = createCoordinator(agent);
  agent.coordinator = coordinator;

  /* What tells the coordinator this node is still there. Without it the node is
     counted out after three intervals and its environments go elsewhere. */
  const heartbeat = createHeartbeat(agent);

  const server = await startAgent(agent);
  console.log(`scalo ${version} listening on ${server.url} as node "${state.id}"`);
  reconciler.start();
  coordinator.start();
  heartbeat.start();

  await untilSignalled(async () => {
    /* Stopped first: a node on its way out must stop saying it is available, so
       the coordinator stops counting it among the nodes it hands work to. */
    heartbeat.stop();
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
      console.log(`scalo: ${signal} received, shutting down`);
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
