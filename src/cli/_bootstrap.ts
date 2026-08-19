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
import type { RegistryContext } from "../core/registry/context.ts";
import { registerNode } from "../core/registry/nodes.ts";
import type { NodeRecord } from "../core/types/registry.ts";
import { isLoopbackHost } from "../core/utils/host.ts";
import { createUns3Store } from "../drivers/store/uns3.ts";
import { loadOrCreateNodeState, type NodeState } from "./_node-state.ts";
import { resolveDefaultStateDir } from "./_utils.ts";
import { readVarsetKeyFile } from "./_varset-key.ts";

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
 * address it tells its peers to use — carries traffic that commands this node.
 * As soon as one of them reaches past loopback, that traffic crosses a network,
 * and only the operator knows what kind of network it is. `--transport
 * wireguard` puts it in a tunnel; `--transport none` states that the network is
 * already private and trusted, a cloud vRack or a VLAN. There is no default,
 * because the safe-looking one — assume it needs no tunnel — is the one that
 * silently exposes a node, and the other refuses to run perfectly good setups.
 * A node that stays on loopback crosses nothing and needs neither.
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
  if (exposed.length === 0) return;

  const named = exposed.map(([field, value]) => `${field} "${String(value)}"`).join(", ");
  throw new ScaloError("invalid-input", "No transport configured", {
    detail:
      `${named} reaches beyond loopback, so node-to-node and operator traffic would cross ` +
      `a network this node has not been told about: set --transport wireguard to tunnel it ` +
      `(assisted setup lands in a later release), or --transport none to state that the ` +
      `network is already private and trusted, such as a cloud vRack`,
  });
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
  };

  await registerNode(registry, record);
  return record;
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
