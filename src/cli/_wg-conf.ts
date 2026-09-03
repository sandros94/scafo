/*
 * Internal: the `wg-quick` interface configuration a node renders for itself,
 * and the peers it renders from.
 *
 * The registry is the whole peer list. Every node writes its own tunnel details
 * into its record when it comes up, so rendering is a read of that list minus
 * this node — no node ever has to be told about another one by hand, and a
 * re-render after a new node joins is the only step left to the operator.
 *
 * Nothing here applies the configuration. Bringing an interface up needs a
 * kernel module and NET_ADMIN, which is the operator's to give: scafo writes the
 * file and prints the command.
 */

import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { listNodes } from "../core/registry/nodes.ts";
import { nodeKey } from "../core/registry/paths.ts";
import type { NodeRecord, NodeWireguard } from "../core/types/registry.ts";
import { parseInterfaceAddress } from "../core/utils/host.ts";
import type { WireguardSettings } from "./_wireguard.ts";

/** One other node of the installation, as a `[Peer]` section states it. */
export interface WireguardPeer {
  /** Node id, written above the section so the file can be read at a glance. */
  id: string;
  wireguard: NodeWireguard;
}

export interface RenderConfOptions {
  /** Where this node sits on the tunnel. */
  settings: WireguardSettings;
  /** The private half of this node's keypair; the only secret in the file. */
  privateKey: string;
  /** Every other node that has published a tunnel address. */
  peers: WireguardPeer[];
}

/**
 * Renders the `wg0.conf` an operator hands to `wg-quick`.
 *
 * A peer's `AllowedIPs` is its own address alone — `/32` for IPv4, `/128` for
 * IPv6 — never the subnet its record happens to name. A peer allowed the whole
 * subnet would claim the routes of every other node on it, and which peer won
 * would depend on the order the sections were written in.
 */
export function renderWireguardConf(opts: RenderConfOptions): string {
  const lines = [
    "[Interface]",
    `Address = ${opts.settings.address}`,
    `ListenPort = ${String(opts.settings.port)}`,
    `PrivateKey = ${opts.privateKey}`,
  ];

  for (const peer of opts.peers) {
    lines.push(
      "",
      `# ${peer.id}`,
      "[Peer]",
      `PublicKey = ${peer.wireguard.publicKey}`,
      `Endpoint = ${peer.wireguard.endpoint}`,
      `AllowedIPs = ${allowedIps(peer.wireguard.address)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Every node of the installation but `self` that has published a tunnel address,
 * in node-id order so that re-rendering an unchanged fleet produces an unchanged
 * file.
 *
 * A node without a `wireguard` record is skipped rather than refused: a fleet is
 * migrated one node at a time, and the ones already on the tunnel have to keep
 * reaching each other while the rest catch up.
 *
 * So is a node whose record has gone missing between the listing and the read.
 * Nothing in scafo deregisters a node — a node on its way out marks itself
 * draining and its record stays — so the only way that happens is an operator
 * emptying the key by hand; taking the whole fleet's configuration down over one
 * absent entry would be the worse answer.
 */
export async function collectWireguardPeers(
  registry: RegistryContext,
  self: string,
): Promise<WireguardPeer[]> {
  const ids = (await listNodes(registry)).filter((id) => id !== self).sort();

  const peers: WireguardPeer[] = [];
  for (const id of ids) {
    const found = await readJson<NodeRecord>(registry, nodeKey(id));
    const wireguard = found?.value.wireguard;
    if (wireguard === undefined) continue;
    peers.push({ id, wireguard });
  }
  return peers;
}

/** The one address a peer is routed, with the prefix that covers it and nothing else. */
function allowedIps(address: string): string {
  const parsed = parseInterfaceAddress(address);
  /* A record written by an older node could carry a bare address; routing it as
     a single host is the same answer, and refusing here would take the whole
     fleet's configuration down over one entry. */
  if (parsed === null) return address;
  return `${parsed.host}/${String(parsed.hostPrefix)}`;
}
