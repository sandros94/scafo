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
import { isScafoError, ScafoError } from "../core/error.ts";
import { readJson, updateJson } from "../core/registry/cas.ts";
import { nowIso, type RegistryContext } from "../core/registry/context.ts";
import { drainNode, registerNode } from "../core/registry/nodes.ts";
import { nodeKey } from "../core/registry/paths.ts";
import type { NodeRecord, NodeWireguard } from "../core/types/registry.ts";
import { withRetry } from "../core/utils/backoff.ts";
import { isLoopbackHost } from "../core/utils/host.ts";
import { createUns3Store } from "../drivers/store/uns3.ts";
import { loadOrCreateNodeState, type NodeState } from "./_node-state.ts";
import { loadOrCreateStorageToken } from "./_storage-token.ts";
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
 * Throws `ScafoError("invalid-input")` naming the addresses that made it
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
  throw new ScafoError("invalid-input", "No transport configured", {
    detail:
      `${named} reaches beyond loopback, so node-to-node and operator traffic would cross ` +
      `a network this node has not been told about: set --transport wireguard to tunnel it ` +
      `(then run "scafo wg init" to set the tunnel up), or --transport none to state that ` +
      `the network is already private and trusted, such as a cloud vRack`,
  });
}

/**
 * This node's place on the tunnel as its record publishes it, or undefined when
 * it runs no tunnel.
 *
 * Reads the keys, never makes them: a node whose transport is `wireguard` and
 * whose keys are not on disk has not had `scafo wg init` run on it, and is
 * refused with `ScafoError("invalid-input")` saying so. Booting anyway would put
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
    throw new ScafoError("invalid-input", "WireGuard tunnel is not set up", {
      detail:
        `this node's transport is "wireguard" but "${stateDir}" holds no tunnel keypair: ` +
        `run "scafo wg init" on this node to set one up, register it with its peers and ` +
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
  return loadOrCreateNodeState(nodeStateDir(config, opts), {
    ...(config.node.id === undefined ? {} : { id: config.node.id }),
    ...(opts?.log === undefined ? {} : { log: opts.log }),
  });
}

/**
 * Reads the token guarding this node's storage surface, writing one on the first
 * boot that has none. It sits beside the node's identity, and is what a
 * colocated process presents to keep its TLS material in the installation's
 * bucket without holding a credential for it.
 */
export async function loadStorageToken(
  config: AgentConfig,
  opts?: NodeIdentityOptions,
): Promise<string> {
  return loadOrCreateStorageToken(nodeStateDir(config, opts));
}

/** Where this node keeps everything it must remember between boots. */
export function nodeStateDir(config: AgentConfig, opts?: NodeIdentityOptions): string {
  return config.node.stateDir ?? opts?.defaultStateDir ?? resolveDefaultStateDir();
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
 *
 * Registering counts as the node's first heartbeat, so it is eligible for work
 * from the moment it exists rather than from its first refresh a heartbeat
 * interval later.
 *
 * The node's LABELS are written here for the same reason, and REPLACED here for
 * a sharper one: they are boot configuration rather than runtime state, so the
 * configuration this node started with is the whole truth about them. A label
 * taken out of that configuration is gone from the record the moment the node
 * restarts, which is what makes relabelling a machine a matter of editing its
 * config and restarting it rather than of finding whatever wrote the old value.
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
    heartbeatAt: nowIso(registry),
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
    ...(opts.config.node.labels === undefined ? {} : { labels: { ...opts.config.node.labels } }),
  };

  await registerNode(registry, record);
  return record;
}

export interface DrainOptions {
  /** Tries, including the first. Defaults to {@link DRAIN_ATTEMPTS}. */
  attempts?: number;
  log?: (message: string) => void;
  /** Injectable for deterministic tests. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Tries a draining node gives the bucket before it stops waiting and leaves anyway. */
export const DRAIN_ATTEMPTS: number = 3;

/**
 * Says this node is on its way out, as the first step of a graceful shutdown.
 *
 * It is worth doing first, and worth doing at all, because of what the
 * alternative costs: an agent that simply stops is indistinguishable from one
 * that crashed, and a crash is only noticed once the node's heartbeat has aged
 * past the liveness window — ninety seconds during which the coordinator still
 * counts it among the nodes it hands work to, and its single-replica
 * environments are placed on a process that is already gone. A node that writes
 * this down is counted out on the coordinator's very next assignment pass.
 *
 * BEST EFFORT, and NEVER throws: the node is leaving either way, and a bucket
 * that cannot be reached must not be able to hold a shutdown open. Retries are
 * bounded and brief for the same reason — what they buy back is a few seconds of
 * misplacement, which is not worth an init system's patience. Failing all of it,
 * the fleet falls back to exactly the behaviour it had before draining existed.
 *
 * Answers the timestamp it wrote, or null when it could not write one.
 */
export async function drainThisNode(
  registry: RegistryContext,
  nodeId: string,
  opts?: DrainOptions,
): Promise<string | null> {
  const log = opts?.log ?? ((message: string): void => console.log(message));

  try {
    const at = await withRetry(() => drainNode(registry, nodeId), {
      attempts: opts?.attempts ?? DRAIN_ATTEMPTS,
      baseMs: 100,
      /* Anything, not just a CAS conflict: a heartbeat racing this write is what
         `updateJson` already retries on its own, and what is left here is the
         unreachable bucket — the case a shutdown gets one or two quick tries at. */
      isRetryable: () => true,
      ...(opts?.sleep === undefined ? {} : { sleep: opts.sleep }),
    });
    log(`scafo: node "${nodeId}" is draining, placement will stop giving it work`);
    return at;
  } catch (error) {
    log(
      `scafo: node "${nodeId}" could not be marked as draining (${describe(error)}); ` +
        `the fleet will count it out after the liveness window instead`,
    );
    return null;
  }
}

/**
 * Publishes where this node sits on the tunnel, leaving the rest of its record
 * exactly as it stands.
 *
 * A narrow update rather than a re-registration, because this is what a command
 * about the tunnel alone is entitled to change. `registerNode` replaces a record
 * wholesale from the configuration it is handed, and `scafo wg init` is run from
 * an operator's shell rather than from the agent's own environment — one run
 * with a config the agent does not use would otherwise move the node's
 * advertised address and capacity along with its tunnel details, and nothing
 * would report it until a peer failed to reach it.
 *
 * A node with no record yet is registered outright: `scafo wg init` before the
 * first `scafo up` is the order the setup instructions ask for.
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

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
