/*
 * `scafo wg`: set this node up on the installation's WireGuard tunnel, and keep
 * its interface configuration current as other nodes join.
 *
 * Assisted, never magical. This command sources a keypair, publishes the public
 * half in the registry and renders a `wg0.conf` from every peer that has done
 * the same — and stops there. Bringing the interface up needs a kernel module
 * and NET_ADMIN, so the operator runs `wg-quick` themselves, on a file they can
 * read first.
 */

import { join } from "node:path";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { DaemonConfig } from "../../daemon/config.ts";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { probeCapacity } from "../../core/capacity/reader.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { createNodeHostReader } from "../../drivers/host/node.ts";
import { createRegistry, loadNodeIdentity, publishWireguard } from "../_bootstrap.ts";
import type { NodeState } from "../_node-state.ts";
import { readTextFile, reportFailure, writeSecretFile } from "../_utils.ts";
import { collectWireguardPeers, renderWireguardConf } from "../_wg-conf.ts";
import {
  ensureWireguardKeys,
  readWireguardKeys,
  resolveWireguardSettings,
  WG_CONF_FILE,
  WG_PRIVATE_KEY_FILE,
  type WireguardKeys,
  type WireguardSettings,
  wireguardStateDir,
} from "../_wireguard.ts";

/* The bucket the registry lives in, exactly as `scafo sail` takes it. */
const bucketArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

/* The tunnel itself, as `scafo sail` takes it too: one node, one description. */
const tunnelArgs: ArgsDef = {
  ...bucketArgs,
  "node-id": { type: "string", description: "Id this node registers under" },
  "state-dir": { type: "string", description: "Directory this node keeps its identity in" },
  "transport": { type: "string", description: "What carries peer traffic (wireguard, none)" },
  "listen": { type: "string", description: "host:port the node API binds to" },
  "internal-listen": { type: "string", description: "host:port for node-to-node traffic" },
  "advertise": { type: "string", description: "host:port other nodes reach this one at" },
  "wg-address": {
    type: "string",
    description: "This node's tunnel address with its prefix length (10.83.0.1/24)",
  },
  "wg-endpoint": {
    type: "string",
    description: "host:port peers send this node's tunnel traffic to",
  },
  "wg-port": { type: "string", description: "UDP port the interface listens on (51820)" },
  "stdout": { type: "boolean", description: "Print the configuration instead of writing it" },
};

const init: CommandDef = defineCommand({
  meta: {
    name: "init",
    description: "Set this node up on the tunnel and render its interface configuration",
  },
  args: tunnelArgs,
  async run({ args }): Promise<void> {
    try {
      await runInit(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const peers: CommandDef = defineCommand({
  meta: {
    name: "peers",
    description: "Re-render the interface configuration from the nodes now registered",
  },
  args: tunnelArgs,
  async run({ args }): Promise<void> {
    try {
      await runPeers(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const wg: CommandDef = defineCommand({
  meta: { name: "wg", description: "Set up and refresh this node's WireGuard tunnel" },
  subCommands: { init, peers },
});

async function runInit(flags: Record<string, unknown>): Promise<void> {
  const tunnel = await resolveTunnel(flags);
  const keys = await ensureWireguardKeys(tunnel.stateDir);
  report(keys, tunnel.stateDir);

  /*
   * Published before the file is rendered, and as a narrow update: everything
   * else in the record is the running daemon's to state. The capacity is probed
   * only for the case where there is no record at all — a node set up before it
   * has ever been started.
   */
  const capacity = await probeCapacity(createNodeHostReader());
  await publishWireguard(tunnel.registry, {
    config: tunnel.config,
    state: tunnel.state,
    capacity,
    wireguard: {
      publicKey: keys.publicKey,
      endpoint: tunnel.settings.endpoint,
      address: tunnel.settings.address,
    },
  });
  console.error(
    `scafo: node "${tunnel.state.id}" is on the tunnel at ${tunnel.settings.address}, ` +
      `reachable at ${tunnel.settings.endpoint}`,
  );

  await render(tunnel, keys, flags.stdout === true);
}

async function runPeers(flags: Record<string, unknown>): Promise<void> {
  const tunnel = await resolveTunnel(flags);

  /* Read, never made: refreshing the peer list must not be able to hand this
     node a new identity that every peer's file would then be missing. */
  const keys = await readWireguardKeys(tunnel.stateDir);
  if (keys === null) {
    throw new ScafoError("invalid-input", "WireGuard tunnel is not set up", {
      detail:
        `"${tunnel.stateDir}" holds no tunnel keypair, so there is nothing to render a ` +
        `configuration from: run "scafo wg init" on this node first`,
    });
  }

  await render(tunnel, keys, flags.stdout === true);
}

/** Everything both subcommands work from: the bucket, the node, and its tunnel. */
interface Tunnel {
  config: DaemonConfig;
  registry: RegistryContext;
  state: NodeState;
  settings: WireguardSettings;
  stateDir: string;
}

async function resolveTunnel(flags: Record<string, unknown>): Promise<Tunnel> {
  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  const settings = resolveWireguardSettings(config);
  if (settings === undefined) {
    throw new ScafoError("invalid-input", "This node runs no WireGuard tunnel", {
      detail:
        `"scafo wg" sets up the tunnel that --transport wireguard puts this node's traffic ` +
        `in, and this node's transport is ` +
        `${config.transport === undefined ? "not configured" : `"${config.transport.driver}"`}: ` +
        `pass --transport wireguard along with --wg-address and --wg-endpoint, or set them ` +
        `in the config file this node boots from`,
    });
  }

  return {
    config,
    registry: createRegistry(config),
    state: await loadNodeIdentity(config),
    settings,
    stateDir: wireguardStateDir(config),
  };
}

/** Renders the interface configuration, to the state directory or to the terminal. */
async function render(tunnel: Tunnel, keys: WireguardKeys, toStdout: boolean): Promise<void> {
  const peerList = await collectWireguardPeers(tunnel.registry, tunnel.state.id);
  const conf = renderWireguardConf({
    settings: tunnel.settings,
    privateKey: keys.privateKey,
    peers: peerList,
  });
  const count = `${String(peerList.length)} peer${peerList.length === 1 ? "" : "s"}`;

  if (toStdout) {
    /* The one artifact this command puts on stdout. Everything else it says is
       commentary and goes to stderr, so `--stdout > wg0.conf` captures a
       configuration wg-quick can parse and nothing it cannot. */
    console.log(conf.trimEnd());
    console.error(`scafo: rendered ${count}; nothing was written`);
    return;
  }

  const path = join(tunnel.stateDir, WG_CONF_FILE);
  /* The file carries the private key, so it is written exactly as the key file
     is: owner-readable, in a directory nobody else can enter. */
  await writeSecretFile(tunnel.stateDir, path, conf);

  console.error(`scafo: wrote ${path} with ${count}`);
  console.error(`scafo: bring the tunnel up with "wg-quick up ${path}"`);
  console.error(
    `scafo: re-run "scafo wg peers" on every node whenever one joins or leaves — a node ` +
      `that is not in this file is a node this one cannot reach`,
  );
}

/** Says where each half of the keypair came from; the operator supplied both. */
function report(keys: WireguardKeys, stateDir: string): void {
  const privatePath = join(stateDir, WG_PRIVATE_KEY_FILE);
  console.error(
    keys.from.privateKey === "state"
      ? `scafo: using the private key already in ${privatePath}`
      : `scafo: generated a private key with "wg genkey" and wrote it to ${privatePath}`,
  );
  if (keys.from.publicKey === "wg") {
    console.error(`scafo: derived the public key with "wg pubkey"`);
  }
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
