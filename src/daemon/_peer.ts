/* Internal: the one hop a node makes to another node's daemon, and what marks it. */

import type { NodeRecord } from "../core/types/registry.ts";

/**
 * Marks a request one node has already forwarded to another. A request carrying
 * it is never forwarded again: the mesh is one hop between peers, and a ring of
 * nodes each convinced the next one should take it would forward forever.
 *
 * A deletion may be handed to whichever node holds the coordinator lease. This
 * header says the request has already crossed that one allowed hop.
 */
export const PROXIED_HEADER: string = "x-scafo-proxied";

/** The only value {@link PROXIED_HEADER} is ever sent or read with. */
export const PROXIED_VALUE: string = "1";

/** Whether this request reached this node through another node of the installation. */
export function isProxiedHop(headers: Headers): boolean {
  return headers.get(PROXIED_HEADER) === PROXIED_VALUE;
}

/**
 * Where a peer's daemon is reached for one target — a path, and the query with
 * it, because a hop that dropped the query would carry out a different request
 * than the one that was made.
 *
 * The address is the one the node registered as its internal one: peers reach
 * each other over the installation's own network, never over the name an
 * operator or an ingress uses.
 */
export function peerUrl(record: NodeRecord, target: string): string {
  const host = record.addresses.internal;
  /* An IPv6 literal is only a URL authority once it is bracketed. */
  const authority = host.includes(":") ? `[${host}]` : host;
  return `http://${authority}:${String(record.addresses.apiPort)}${target}`;
}
