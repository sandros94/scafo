/* Internal: the one hop a node makes to another node's daemon, and what marks it. */

import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { isNodeLive } from "../core/registry/nodes.ts";
import { nodeKey } from "../core/registry/paths.ts";
import type { NodeRecord } from "../core/types/registry.ts";

/**
 * Marks a request one node has already forwarded to another. A request carrying
 * it is never forwarded again: the mesh is one hop between peers, and a ring of
 * nodes each convinced the next one should take it would forward forever.
 *
 * ONE HEADER FOR EVERY HOP THE DAEMON MAKES — the deletion handed to whichever
 * node holds the coordinator lease, and the wake handed to a node the placement
 * assigned — because both say the same thing: this request has been forwarded
 * once already, so answer it here or refuse it, but do not pass it on.
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

/**
 * The nodes a placement names that are live and are not this one, IN THE
 * RECORD'S OWN ORDER.
 *
 * That order is the coordinator's and is the same on every node, so two nodes
 * asking about the same environment reach the same peer first — which is what a
 * wake needs, because a wake is one boot and spreading the requests would make
 * it several.
 *
 * LAZY, AND THAT IS WHY IT IS A GENERATOR: each name costs a read of that node's
 * record, and the two callers want different amounts of the list. A wake takes
 * the FIRST and stops, so a `replicas: all` environment on a twenty-node fleet
 * costs it one read; a deploy watching for its build asks each in turn until one
 * says it is serving, because the build is ready if ANY of them has it ready.
 *
 * A node named in the record but MISSING from the registry is skipped rather
 * than raised: a decision outlives the deregistration of a node it names by up
 * to one coordinator pass, and the next name in the record is the answer. So is
 * a draining one — {@link isNodeLive} counts it out, and a node on its way out
 * will not boot anything.
 */
export async function* liveAssignedNodes(
  registry: RegistryContext,
  nodes: readonly string[],
  selfId: string,
): AsyncGenerator<NodeRecord> {
  const now = nowDate(registry);

  for (const id of nodes) {
    if (id === selfId) continue;
    const found = await readJson<NodeRecord>(registry, nodeKey(id));
    if (found !== null && isNodeLive(found.value, now)) yield found.value;
  }
}
