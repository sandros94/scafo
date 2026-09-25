/* What a node tells the fleet it is serving, derived from its own processes. */

import { isNodeLive } from "../registry/nodes.ts";
import type { NodeFailing, NodeRecord, NodeServing } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";

/**
 * The `serving` a node publishes for these processes: one entry per
 * application whose process has ANSWERED FOR ITSELF, carrying the port public
 * traffic reaches it on. Keys are in code-unit order, so two nodes describing
 * the same processes write the same bytes and {@link sameServing} can compare
 * cheaply.
 *
 * ONLY A READY PROCESS IS LISTED, because this map is the routing every ingress
 * reads. A process that has been spawned and has not answered its health
 * endpoint yet holds a port that nothing is listening on, and publishing it
 * hands the fleet a route to a refused connection — on every first start, on
 * every restart, and forever for a process that can never become ready. What is
 * running is `reconcile.processes`; what answers is this.
 *
 * A process whose stop failed is still listed, once it was ready: it may well
 * still be answering, and a holder that is wrong for a few seconds beats one
 * that vanishes while its process keeps serving. The reconcile loop retries the
 * stop and the next heartbeat drops it.
 *
 * A CRASH-LOOPING PROCESS IS NOT LISTED, for the same reason read the other way
 * round: it answers for a few seconds at a time between restarts, so `ready`
 * alone would let it back into the routing on the good seconds. The node
 * record's `failing` map is where the application is still accounted for, by
 * name, with what it last said.
 *
 * `ready` is what the node's own health tracker knows, so a node that keeps none
 * publishes nothing: it has no way to tell a listener from a port number, and a
 * route to a process nobody vouched for is the defect this closes.
 */
export function servingOf(
  processes: RuntimeProcess[],
  opts: { ready: ReadonlySet<string>; failing?: ReadonlySet<string> },
): NodeServing {
  const entries = processes
    .filter(
      (process) =>
        opts.ready.has(process.application) && opts.failing?.has(process.application) !== true,
    )
    .map((process) => [process.application, { port: process.port }] as const)
    .sort(([a], [b]) => (a === b ? 0 : a < b ? -1 : 1));
  return Object.fromEntries(entries);
}

/**
 * Whether two `failing` maps say the same thing about the same applications.
 *
 * THE RESTART COUNT IS DELIBERATELY NOT COMPARED. A crash loop that is still a
 * crash loop climbs by one every restart, and a node that beat and hinted on
 * each of those would tell the whole fleet to re-list the registry every few
 * seconds for news that changes nothing anybody routes on. What the fleet has
 * to hear at once is an application starting to fail, stopping, or failing for
 * a different reason.
 */
export function sameFailing(a: NodeFailing | undefined, b: NodeFailing | undefined): boolean {
  const left = Object.entries(a ?? {});
  const right = Object.entries(b ?? {});
  if (left.length !== right.length) return false;
  for (const [name, failure] of left) {
    const other = b?.[name];
    if (other === undefined) return false;
    if (other.since !== failure.since || other.lastError !== failure.lastError) return false;
  }
  return true;
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

/**
 * How much of the fleet is really serving one application.
 *
 * THE COUNT IS WHAT MAKES A HALF-BROKEN APPLICATION VISIBLE. An application
 * placed on three nodes, whose process on one of them exits every few seconds,
 * is "serving" by every record scafo kept before this existed: it is not
 * retired, not blocked, and two nodes are answering for it. This says two of
 * three, and names the third.
 */
export interface ApplicationServing {
  /** Live nodes holding it at all: the ones serving it and the ones failing it. */
  nodes: number;
  /** Of those, the nodes whose own record publishes it as served. */
  serving: number;
  /** The live nodes that report it as failing, in node order. */
  failing: ApplicationFailure[];
}

/** One node's word about an application it cannot keep running. */
export interface ApplicationFailure {
  node: string;
  /** When the run of exits behind it began, ISO-8601. */
  since: string;
  restarts: number;
  /** The first line of what its process last wrote to stderr, truncated. */
  lastError?: string;
}

/**
 * What the fleet's node records say about one application.
 *
 * ONLY LIVE NODES COUNT, and a draining one does not: a machine that stopped
 * answering says nothing about what is running now, and a record it left behind
 * naming a failing process would keep an application looking broken long after
 * the machine was switched off.
 *
 * Pure, so the caller decides what "now" is.
 */
export function applicationServing(
  application: string,
  nodes: readonly NodeRecord[],
  now: Date,
): ApplicationServing {
  const failing: ApplicationFailure[] = [];
  let serving = 0;

  for (const record of nodes) {
    if (!isNodeLive(record, now)) continue;
    if (record.serving?.[application] !== undefined) serving += 1;

    const failure = record.failing?.[application];
    if (failure === undefined) continue;
    failing.push({
      node: record.id,
      since: failure.since,
      restarts: failure.restarts,
      ...(failure.lastError === undefined ? {} : { lastError: failure.lastError }),
    });
  }
  failing.sort((a, b) => (a.node === b.node ? 0 : a.node < b.node ? -1 : 1));

  return { nodes: serving + failing.length, serving, failing };
}
