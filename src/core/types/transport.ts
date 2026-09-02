/* The transport seam: what carries traffic between the nodes of an installation. */

/** Peer transport: WireGuard, or an explicitly trusted private network. No
    default exists for non-loopback binds. */
export type TransportMode = "wireguard" | "none";

/** What an operator configured about this node's transport. */
export interface TransportConfig {
  driver: TransportMode;
}
