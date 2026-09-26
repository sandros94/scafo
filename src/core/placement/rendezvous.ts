/*
 * Which nodes serve an application, decided by rendezvous hashing (highest
 * random weight).
 *
 * Every node scores every application with `sha256(<application>\n<nodeId>)`
 * and the highest scores win. Three properties come out of that, and they are
 * the reason this is not a round-robin or a counter in the bucket:
 *
 * - DETERMINISTIC — the same application and the same node set always give the
 *   same answer, on any node, at any time, with no state to keep in sync.
 * - STABLE — adding or removing a node only moves the applications that node
 *   was involved in. The rest keep the nodes they had, so a node joining does
 *   not restart the installation.
 * - BALANCED — the digest spreads applications evenly without anyone counting.
 *
 * Pure: the caller supplies the node ids, having already decided which of them
 * are alive.
 */

import type { ReplicaCount } from "../types/registry.ts";
import { sha256Hex } from "../utils/hash.ts";

export interface AssignmentInput {
  application: string;
  /** Ids of the nodes that may take it; the caller has filtered these to the live ones. */
  nodes: string[];
  replicas: ReplicaCount;
}

/**
 * Every candidate ranked for one application, best first.
 *
 * Ties — two nodes whose digests are equal, which needs a sha256 collision —
 * fall back to the node id, so the order is total and never depends on the
 * order the candidates arrived in.
 */
export async function rendezvousOrder(application: string, nodes: string[]): Promise<string[]> {
  const scored = await Promise.all(
    nodes.map(async (id) => ({ id, score: await sha256Hex(`${application}\n${id}`) })),
  );

  /* Fixed-width lowercase hex, so comparing the strings compares the numbers. */
  scored.sort((a, b) => (a.score === b.score ? compare(a.id, b.id) : compare(b.score, a.score)));
  return scored.map((entry) => entry.id);
}

/**
 * The nodes that should serve one application, lexicographically sorted so that
 * two decisions are comparable without caring which one ranked first.
 *
 * `"all"`, and a count at or above the number of candidates, take every
 * candidate. An empty candidate list gives an empty answer — deciding that
 * NOBODY serves an application is a real outcome of an empty fleet, and it is
 * the caller's job never to write it as though it were a decision.
 */
export async function assignNodes(input: AssignmentInput): Promise<string[]> {
  const wanted =
    input.replicas === "all" ? input.nodes.length : Math.min(input.replicas, input.nodes.length);
  if (wanted >= input.nodes.length) return [...input.nodes].sort(compare);

  const ranked = await rendezvousOrder(input.application, input.nodes);
  return ranked.slice(0, wanted).sort(compare);
}

/* Code-unit ordering, so a decision does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
