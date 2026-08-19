/* `scalo up`: register this machine as a node and serve the agent API. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { S3Client } from "uns3";
import { generateKey } from "unjwt/jwk";
import type { AgentContext } from "../../agent/app.ts";
import { advertisedAddress, loadAgentConfig } from "../../agent/config.ts";
import { createReconciler, runtimeBaseEnv } from "../../agent/reconcile.ts";
import { startAgent } from "../../agent/serve.ts";
import { probeCapacity } from "../../core/capacity/reader.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { initRegistry, readMeta } from "../../core/registry/meta.ts";
import { registerNode } from "../../core/registry/nodes.ts";
import type { NodeRecord } from "../../core/types/registry.ts";
import { createDeployService } from "../../agent/deploys.ts";
import { createCelldDeployRunner } from "../../drivers/deploy/celld.ts";
import { createNodeHostReader } from "../../drivers/host/node.ts";
import { createCaddyDriver } from "../../drivers/ingress/caddy.ts";
import { createCelldDriver } from "../../drivers/runtime/celld.ts";
import { createUns3Store } from "../../drivers/store/uns3.ts";
import { createChildSupervisor } from "../../drivers/supervisor/child.ts";
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
  "listen": { type: "string", description: "host:port the agent API binds to" },
  "internal-listen": { type: "string", description: "host:port for node-to-node traffic" },
  "advertise": { type: "string", description: "host:port other nodes reach this one at" },
  "platform-domains": { type: "string", description: "Comma-separated apex domains to serve" },
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

  const registry: RegistryContext = {
    store: createUns3Store(
      new S3Client({
        endpoint: config.bucket.endpoint,
        region: config.bucket.region,
        credentials: {
          accessKeyId: config.bucket.accessKey,
          secretAccessKey: config.bucket.secretKey,
        },
        /* Self-hosted S3 implementations are addressed by path; virtual-host
           style needs per-bucket DNS that a single store rarely has. */
        bucketStyle: "path",
        defaultBucket: config.bucket.bucket,
      }),
      { bucket: config.bucket.bucket, prefix: config.bucket.prefix },
    ),
  };

  /* The first node to arrive bootstraps the registry, which also proves the
     bucket honours conditional writes before anything is written for real. */
  if ((await readMeta(registry)) === null) {
    await initRegistry(registry, { platformDomains: config.platformDomains });
  }

  const capacity = await probeCapacity(createNodeHostReader());
  const reachable = advertisedAddress(config.node);
  const record: NodeRecord = {
    v: 1,
    id: config.node.id,
    publicKey: await generateNodePublicKey(),
    addresses: { internal: reachable.host, agentPort: reachable.port },
    capacity: {
      cores: capacity.cores,
      memMb: capacity.memMb,
      cgroup: capacity.cgroup,
      probedAt: capacity.probedAt,
    },
  };
  await registerNode(registry, record);

  const supervisor = createChildSupervisor();
  supervisor.onExit((status) => {
    /* Reporting only: deciding what to do about it belongs to the reconcile loop. */
    console.error(`scalo: process "${status.id}" exited with code ${String(status.exitCode)}`);
  });

  const version = await readPackageVersion();
  const agent: AgentContext = { config, registry, supervisor, version, capacity };

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
  console.log(`scalo ${version} listening on ${server.url} as node "${config.node.id}"`);
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

/**
 * The node's signing identity.
 *
 * TODO: this keypair is ephemeral — a fresh one is generated on every boot, so
 * the public key in the registry changes on each restart and any token signed by
 * an earlier boot stops verifying. The private half is discarded here because
 * nothing signs yet. Persisting the key in a state directory written on first
 * boot, and loading it thereafter, lands together with the node join flow.
 */
async function generateNodePublicKey(): Promise<NodeRecord["publicKey"]> {
  const { publicKey } = await generateKey("EdDSA", { toJWK: true });
  return { kty: "OKP", crv: "Ed25519", x: publicKey.x };
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
