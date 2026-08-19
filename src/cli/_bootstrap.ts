/*
 * Internal: the steps a node takes between reading its configuration and serving
 * — the bucket it talks to, the network it is allowed on, the identity it keeps,
 * and the key that opens its environments' variables.
 *
 * Each is its own function so that a node can be brought up piece by piece, and
 * so nothing here needs a socket to be exercised.
 */

import { S3Client } from "uns3";
import type { AgentConfig } from "../agent/config.ts";
import { advertisedAddress, parseHostPort } from "../agent/config.ts";
import type { CapacityPlan } from "../core/capacity/compute.ts";
import { ScaloError } from "../core/error.ts";
import { readJson, updateJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { registerNode } from "../core/registry/nodes.ts";
import { nodeKey } from "../core/registry/paths.ts";
import type { NodeRecord, NodeWireguard } from "../core/types/registry.ts";
import { isLoopbackHost } from "../core/utils/host.ts";
import { createUns3Store } from "../drivers/store/uns3.ts";
import { loadOrCreateNodeState, type NodeState } from "./_node-state.ts";
import { resolveDefaultStateDir } from "./_utils.ts";
import { readVarsetKeyFile } from "./_varset-key.ts";
import {
  readWireguardKeys,
  resolveWireguardSettings,
  WG_CONF_FILE,
  type WireguardOptions,
  wireguardStateDir,
} from "./_wireguard.ts";

/** The registry this node reads and writes, as configured. */
export function createRegistry(config: AgentConfig): RegistryContext {
  return {
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
}

/**
 * Refuses to boot a node that would put node-to-node or operator traffic on a
 * network nobody has classified.
 *
 * Every address a node exposes — the agent API, the internal listener, the
 * address it tells its peers to use, the address its runtime processes bind —
 * carries traffic that commands this node. As soon as one of them reaches past
 * loopback, that traffic crosses a network, and only the operator knows what
 * kind of network it is. `--transport wireguard` puts it in a tunnel;
 * `--transport none` states that the network is already private and trusted, a
 * cloud vRack or a VLAN. There is no default, because the safe-looking one —
 * assume it needs no tunnel — is the one that silently exposes a node, and the
 * other refuses to run perfectly good setups. A node that stays on loopback
 * crosses nothing and needs neither.
 *
 * `runtime.bindHost` counts for the same reason the others do, and more sharply:
 * what it exposes is the runtime's peer listener, which authenticates nobody. It
 * is what a multi-node fleet has to widen for cross-node cell traffic, and that
 * is exactly when the operator must have said what the network is.
 *
 * Throws `ScaloError("invalid-input")` naming the addresses that made it
 * necessary.
 */
export function assertTransportConfigured(config: AgentConfig): void {
  if (config.transport !== undefined) return;

  const addresses: [string, string | undefined][] = [
    ["node.listen", config.node.listen],
    ["node.internalListen", config.node.internalListen],
    ["node.advertise", config.node.advertise],
  ];
  const exposed = addresses.filter(
    ([field, value]) => value !== undefined && !isLoopbackHost(parseHostPort(value, field).host),
  );
  /* A bare host rather than a `host:port`, so it is checked on its own. */
  if (!isLoopbackHost(config.runtime.bindHost)) {
    exposed.push(["runtime.bindHost", config.runtime.bindHost]);
  }
  if (exposed.length === 0) return;

  const named = exposed.map(([field, value]) => `${field} "${String(value)}"`).join(", ");
  throw new ScaloError("invalid-input", "No transport configured", {
    detail:
      `${named} reaches beyond loopback, so node-to-node and operator traffic would cross ` +
      `a network this node has not been told about: set --transport wireguard to tunnel it ` +
      `(then run "scalo wg init" to set the tunnel up), or --transport none to state that ` +
      `the network is already private and trusted, such as a cloud vRack`,
  });
}

/**
 * This node's place on the tunnel as its record publishes it, or undefined when
 * it runs no tunnel.
 *
 * Reads the keys, never makes them: a node whose transport is `wireguard` and
 * whose keys are not on disk has not had `scalo wg init` run on it, and is
 * refused with `ScaloError("invalid-input")` saying so. Booting anyway would put
 * the node on a network the tunnel does not carry, which is the exact thing
 * `--transport wireguard` was asked to prevent.
 */
export async function loadWireguardRecord(
  config: AgentConfig,
  opts?: WireguardOptions,
): Promise<NodeWireguard | undefined> {
  const settings = resolveWireguardSettings(config, opts);
  if (settings === undefined) return undefined;

  const stateDir = wireguardStateDir(config, opts);
  const keys = await readWireguardKeys(stateDir);
  if (keys === null) {
    throw new ScaloError("invalid-input", "WireGuard tunnel is not set up", {
      detail:
        `this node's transport is "wireguard" but "${stateDir}" holds no tunnel keypair: ` +
        `run "scalo wg init" on this node to set one up, register it with its peers and ` +
        `render "${stateDir}/${WG_CONF_FILE}", then bring the interface up before starting ` +
        `the agent`,
    });
  }

  return { publicKey: keys.publicKey, endpoint: settings.endpoint, address: settings.address };
}

export interface NodeIdentityOptions {
  /** Where the identity is kept, when the configuration names no directory. */
  defaultStateDir?: string;
  log?: (message: string) => void;
}

/** Reads this node's persisted identity, generating one on first boot. */
export async function loadNodeIdentity(
  config: AgentConfig,
  opts?: NodeIdentityOptions,
): Promise<NodeState> {
  const stateDir = config.node.stateDir ?? opts?.defaultStateDir ?? resolveDefaultStateDir();
  return loadOrCreateNodeState(stateDir, {
    ...(config.node.id === undefined ? {} : { id: config.node.id }),
    ...(opts?.log === undefined ? {} : { log: opts.log }),
  });
}

export interface RegisterNodeOptions {
  config: AgentConfig;
  state: NodeState;
  capacity?: CapacityPlan;
  /**
   * Where this node sits on the tunnel, when it runs one. It is published here
   * because a peer cannot build a route to a node it has not been told the key,
   * endpoint and address of, and the registry is the only thing the nodes of an
   * installation share.
   */
  wireguard?: NodeWireguard;
}

/**
 * Writes this node's record: who it is, where it is reached and what it can run.
 *
 * Written on every boot rather than only on the first one. The record is derived
 * state — a node that has lost it, or whose address or capacity has changed,
 * must be able to state the truth again — and the identity it is filed under
 * comes from the node's own state directory, so re-registering never takes over
 * another node's entry.
 */
export async function registerThisNode(
  registry: RegistryContext,
  opts: RegisterNodeOptions,
): Promise<NodeRecord> {
  const reachable = advertisedAddress(opts.config.node);
  const record: NodeRecord = {
    v: 1,
    id: opts.state.id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: opts.state.publicKey.x },
    addresses: { internal: reachable.host, agentPort: reachable.port },
    ...(opts.capacity === undefined
      ? {}
      : {
          capacity: {
            cores: opts.capacity.cores,
            memMb: opts.capacity.memMb,
            cgroup: opts.capacity.cgroup,
            probedAt: opts.capacity.probedAt,
          },
        }),
    ...(opts.wireguard === undefined ? {} : { wireguard: opts.wireguard }),
  };

  await registerNode(registry, record);
  return record;
}

/**
 * Publishes where this node sits on the tunnel, leaving the rest of its record
 * exactly as it stands.
 *
 * A narrow update rather than a re-registration, because this is what a command
 * about the tunnel alone is entitled to change. `registerNode` replaces a record
 * wholesale from the configuration it is handed, and `scalo wg init` is run from
 * an operator's shell rather than from the agent's own environment — one run
 * with a config the agent does not use would otherwise move the node's
 * advertised address and capacity along with its tunnel details, and nothing
 * would report it until a peer failed to reach it.
 *
 * A node with no record yet is registered outright: `scalo wg init` before the
 * first `scalo up` is the order the setup instructions ask for.
 */
export async function publishWireguard(
  registry: RegistryContext,
  opts: RegisterNodeOptions & { wireguard: NodeWireguard },
): Promise<NodeRecord> {
  const key = nodeKey(opts.state.id);
  if ((await readJson<NodeRecord>(registry, key)) === null) {
    return registerThisNode(registry, opts);
  }

  const updated = await updateJson<NodeRecord>(registry, key, (current) => ({
    ...current,
    wireguard: opts.wireguard,
  }));
  return updated.value;
}

/**
 * The key this node opens its environments' variables with, or undefined when no
 * key file is configured. A node without one may only serve environments that
 * point at no varset.
 */
export async function loadVarsetKey(config: AgentConfig): Promise<CryptoKey | undefined> {
  const keyFile = config.varsets?.keyFile;
  return keyFile === undefined ? undefined : readVarsetKeyFile(keyFile);
}
