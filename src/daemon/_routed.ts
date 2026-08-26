/*
 * Internal: whether a build is being served, asked of the node that was actually
 * given the environment.
 *
 * A deploy is accepted by whichever node the caller happened to reach, and
 * placement is the COORDINATOR's decision, taken after that deploy has landed.
 * So the node watching for the build to come up is very often not the node that
 * brings it up — and a watch that only ever looked at its OWN processes reported
 * `deploy-not-routed` after the full two-minute budget while the build had been
 * serving on a peer for seconds. Measured on a two-node fleet: 2s through the
 * node placement chose, 124s through the other one, same build.
 *
 * THE FACT IS A PROCESS'S READINESS, AND ONLY THE NODE RUNNING IT HOLDS IT.
 * Nothing in the registry says a node has a ready process for a build: placement
 * records INTENT, wake stamps record DEMAND, and a node's record says where it is
 * and what hardware it has. So this is a peer hop rather than a bucket read —
 * `GET /v1/state` on the assigned node, signed with a fresh node token this node
 * makes for itself, and the answer is that node's own `reconcile.processes`,
 * which is the very thing the local check reads. The contract `routed` carries is
 * unchanged; only where the fact is fetched from is.
 *
 * EVERY WAY OF NOT GETTING AN ANSWER READS AS "NOT YET". Unreachable, refused,
 * mid-restart, or simply not ready are all reasons to look again, and the caller
 * is already on a deadline that ends in a warning rather than a failure — so
 * nothing here raises, and a deploy is never failed over a peer that was busy.
 *
 * NO LOOP GUARD, because there is no loop to guard: `/v1/state` answers from the
 * node's own memory and forwards nothing, so a hop can never become two.
 */

import { signNodeToken } from "../core/auth/node-token.ts";
import { readPlacement } from "../core/registry/placement.ts";
import type { NodeRecord } from "../core/types/registry.ts";
import type { RuntimeProcess } from "../core/types/runtime.ts";
import { liveAssignedNodes, peerUrl } from "./_peer.ts";
import type { DaemonContext } from "./app.ts";

/** The one process a watch is waiting for. */
export interface RoutedTarget {
  project: string;
  env: string;
  build: string;
}

/** A repeatable look at whether the build is being served, wherever it was placed. */
export interface RoutedWatch {
  /** Whether a process serving the build has passed its readiness gate. */
  routed(): Promise<boolean>;
  /**
   * The nodes the LAST look asked, in the order it asked them. Empty while the
   * answer came from this node's own processes, or no placement yet names peers
   * to ask. Missing placement keeps the watch local; it does not start work.
   */
  asked(): string[];
}

/**
 * Builds the watch one deploy follows its build with.
 *
 * WHAT ONE LOOK COSTS, and why it is affordable: this node's own processes
 * first, which costs nothing and is the whole answer on a single node and on
 * every environment this node was given. Only when the placement names OTHER
 * nodes does a look reach the bucket — one read for the decision, one per node
 * named to check it is live — and then one call per live peer until one of them
 * says yes. A deploy watch is bounded, operator-initiated and rare, and it stops
 * the moment the build is routed.
 *
 * THE PLACEMENT IS RE-READ ON EVERY LOOK RATHER THAN RESOLVED ONCE. A deploy
 * that CREATED its environment has no placement record at all until the
 * coordinator's next pass, and the decision that pass writes is exactly the one
 * this has to follow; a watch that had settled on "nowhere in particular" at the
 * start would spend its whole budget looking at the wrong node.
 */
export function createRoutedWatch(daemon: DaemonContext, target: RoutedTarget): RoutedWatch {
  let asked: string[] = [];

  /** Whether this node's own reconcile loop reports a ready process for the build. */
  function here(): boolean {
    return (daemon.reconciler?.status().processes ?? []).some((process) => serves(process, target));
  }

  return {
    async routed(): Promise<boolean> {
      if (here()) {
        asked = [];
        return true;
      }

      try {
        const placement = await readPlacement(daemon.registry, target.project, target.env);
        /* No decision yet, or one that names this node: no peer can answer more
           truthfully than the local reconciler, which has just been checked. */
        if (placement === null || placement.nodes.includes(daemon.nodeId)) {
          asked = [];
          return false;
        }

        /* Each in turn until one says yes, because the build is routed if ANY
           node the decision names has it ready. */
        const reached: string[] = [];
        asked = reached;
        for await (const node of liveAssignedNodes(
          daemon.registry,
          placement.nodes,
          daemon.nodeId,
        )) {
          reached.push(node.id);
          if (await routedOn(daemon, node, target)) return true;
        }
      } catch {
        /* A registry that could not be read says nothing about the build, and
           the caller is looking again in a moment. */
      }
      return false;
    },

    asked: (): string[] => [...asked],
  };
}

/* ------------------------------------------------------------------ internal */

/** What one node's `/v1/state` says about the processes its reconcile loop runs. */
interface PeerState {
  reconcile?: { processes?: unknown };
}

/** Whether the process this node started is the one being waited for, and ready. */
function serves(process: RuntimeProcess, target: RoutedTarget): boolean {
  return (
    process.ready &&
    process.project === target.project &&
    process.env === target.env &&
    process.build === target.build
  );
}

/**
 * Whether `node` reports a ready process for the build.
 *
 * False for every way of not finding out — no signing key to present, a peer
 * that refused or could not be reached, an answer that is not the document it
 * should be. None of them says the build is not coming up, and the caller is
 * looking again in a moment either way.
 */
async function routedOn(
  daemon: DaemonContext,
  node: NodeRecord,
  target: RoutedTarget,
): Promise<boolean> {
  const signingKey = daemon.signingKey;
  if (signingKey === undefined) return false;

  try {
    /* A fresh token per look: a node token is single-use, so one signed for an
       earlier look would be refused as a replay. */
    const token = await signNodeToken(signingKey, daemon.nodeId);
    const answer = await (daemon.fetchFn ?? globalThis.fetch)(peerUrl(node, "/v1/state"), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!answer.ok) return false;

    const state = (await answer.json()) as PeerState;
    const processes = state.reconcile?.processes;
    if (!Array.isArray(processes)) return false;

    return processes.some(
      (process: unknown) =>
        typeof process === "object" &&
        process !== null &&
        serves(process as RuntimeProcess, target),
    );
  } catch {
    return false;
  }
}
