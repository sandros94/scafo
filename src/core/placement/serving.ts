/* What a node tells the fleet it is serving, derived from its own processes. */

import type { NodeServing } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";

/**
 * The `serving` a node publishes for these processes: one entry per environment,
 * keyed `project/env`, carrying the port public traffic reaches it on. Keys are
 * in code-unit order, so two nodes describing the same processes write the same
 * bytes and {@link sameServing} can compare cheaply.
 *
 * A process whose stop failed is still listed: it may well still be answering,
 * and a holder that is wrong for a few seconds beats one that vanishes while
 * its process keeps serving. The reconcile loop retries the stop and the next
 * heartbeat drops it.
 */
export function servingOf(processes: RuntimeProcess[]): NodeServing {
  const entries = processes
    .map((process) => [`${process.project}/${process.env}`, { port: process.port }] as const)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  return Object.fromEntries(entries);
}

/** Whether two published sets say the same thing, key for key and port for port. */
export function sameServing(a: NodeServing | undefined, b: NodeServing | undefined): boolean {
  const left = Object.entries(a ?? {});
  const right = Object.entries(b ?? {});
  if (left.length !== right.length) return false;
  for (const [key, { port }] of left) {
    if (b?.[key]?.port !== port) return false;
  }
  return true;
}
