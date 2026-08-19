/* `scalo up`: register this machine as a node and serve the agent API. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { AgentContext } from "../../agent/app.ts";
import { loadAgentConfig } from "../../agent/config.ts";
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
  "platform-domains": { type: "string", description: "Comma-separated apex domains to serve" },
  "varset-key-file": { type: "string", description: "File holding the varset encryption key" },
  "celld-bin": { type: "string", description: "Executable that runs an environment" },
  "port-range-start": { type: "string", description: "First loopback port runtime processes use" },
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

  const state = await loadNodeIdentity(config);
  const varsetKey = await loadVarsetKey(config);
  const registry = createRegistry(config);

  /* The first node to arrive bootstraps the registry, which also proves the
     bucket honours conditional writes before anything is written for real. */
  if ((await readMeta(registry)) === null) {
    await initRegistry(registry, { platformDomains: config.platformDomains });
  }

  const capacity = await probeCapacity(createNodeHostReader());
  await registerThisNode(registry, { config, state, capacity });

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

  const server = await startAgent(agent);
  console.log(`scalo ${version} listening on ${server.url} as node "${state.id}"`);
  reconciler.start();

  await untilSignalled(async () => {
    /* Stopped first: a pass that started while the node was shutting down would
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
