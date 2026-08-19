/* The transport seam: what carries traffic between the nodes of an installation. */

/**
 * How a node reaches its peers, and how they reach it.
 *
 * `"wireguard"` puts node-to-node and operator traffic inside a tunnel.
 * `"none"` states that the network the node is on is already private and
 * trusted — a cloud vRack, a VLAN — and needs no tunnel of its own. There is no
 * default: a node whose addresses reach beyond loopback must be told which of
 * the two it is, because the two are indistinguishable from inside the node.
 */
export type TransportMode = "wireguard" | "none";

/** What an operator configured about this node's transport. */
export interface TransportConfig {
  driver: TransportMode;
}
