/* Lease-holding coordinator derives and writes assignments from applications and
   live nodes. */

import { ScafoError } from "../core/error.ts";
import { assignNodes } from "../core/placement/rendezvous.ts";
import { resolveReplicas } from "../core/placement/replicas.ts";
import { describeSelector, eligibleNodes } from "../core/placement/selector.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { listApplicationRecords } from "../core/registry/applications.ts";
import type { KeepAlive, LeaseHandle } from "../core/registry/lease.ts";
import { isNodeLive, listNodeRecords } from "../core/registry/nodes.ts";
import {
  deletePlacement,
  listPlacements,
  type PlacementOutcome,
  writePlacement,
} from "../core/registry/placement.ts";
import type { NodeRecord, NodeSelector } from "../core/types/registry.ts";

/**
 * Why one application could not be placed on a pass, as a stable code.
 *
 * `placement-unavailable` — no live node was eligible to run it. Today that is
 * always a selector no live node satisfies: an empty FLEET refuses the whole
 * pass instead, before any application is considered.
 */
export type AssignmentFailureReason = "placement-unavailable";

/** One application a pass could decide nothing for, and why. */
export interface AssignmentFailure {
  /** The application's name. */
  target: string;
  reason: AssignmentFailureReason;
  /** What an operator has to act on, naming the constraint that went unsatisfied. */
  detail: string;
}

/** What one assignment pass decided. */
export interface AssignmentResult {
  /** Ids of the nodes every decision in this pass was made over. */
  live: string[];
  /** Applications whose placement was rewritten. */
  changed: Array<{ target: string; nodes: string[] }>;
  /**
   * Placement objects removed because nothing should be serving what they name:
   * the application is gone, or it has been retired.
   */
  removed: string[];
  /** Applications whose placement was left exactly as it was, and why. */
  skipped: Array<{ target: string; reason: PlacementOutcome }>;
  /**
   * Applications the pass could NOT place, whose previous placement — if they
   * had one — is left standing untouched. This is the operator's only sign that
   * a constraint has gone unsatisfiable, so it is reported rather than logged.
   */
  unplaced: AssignmentFailure[];
}

export interface AssignmentOptions {
  /** How long a node counts as live after its last heartbeat; see `isNodeLive`. */
  livenessWindowMs?: number;
  /** Called between applications, so a pass longer than the lease TTL keeps it. */
  keepAlive?: KeepAlive;
}

/**
 * Decides and records the placement of every application in the installation.
 *
 * Throws `ScafoError("placement-unavailable")` when NO node is live, having
 * written nothing. That refusal is the point: a bucket that briefly cannot be
 * reached, a clock that jumped, a fleet mid-restart — each of them reads as an
 * empty node list, and the decision that follows from an empty node list is
 * "nothing is served anywhere". Every node would then stop every process it
 * runs, and the installation would take itself down over a hiccup. Leaving the
 * last decision standing keeps whatever is running, running.
 *
 * The same reasoning applies one application at a time to a node SELECTOR no
 * live node satisfies, and there it is reported rather than thrown: that
 * application is left with the placement it already had, every other application
 * in the pass is decided normally, and the failure is answered in
 * {@link AssignmentResult.unplaced}.
 *
 * Throws `ScafoError("lease-lost")` when the lease goes while it works; the
 * caller stops being the coordinator at that point.
 */
export async function runAssignment(
  ctx: RegistryContext,
  lease: LeaseHandle,
  opts?: AssignmentOptions,
): Promise<AssignmentResult> {
  const now = nowDate(ctx);
  const window = opts?.livenessWindowMs;
  /* Kept as RECORDS rather than reduced to ids here: an application's selector
     is matched against the labels an operator set on a node, and only the record
     carries them. */
  const fleet: NodeRecord[] = (await listNodeRecords(ctx)).filter((record) =>
    isNodeLive(record, now, window === undefined ? {} : { windowMs: window }),
  );
  const live = fleet.map((record) => record.id);

  if (live.length === 0) {
    throw new ScafoError("placement-unavailable", "No node is live", {
      detail:
        `no registered node has reported in recently enough to be given work, so every ` +
        `placement is left exactly as it stands: deciding that nothing is served anywhere ` +
        `would stop every process in the installation over what is far more likely a ` +
        `registry or clock problem than an empty fleet`,
    });
  }

  const result: AssignmentResult = {
    live,
    changed: [],
    removed: [],
    skipped: [],
    unplaced: [],
  };

  return runAssignmentOverFleet(ctx, lease, fleet, result, opts?.keepAlive);
}

async function runAssignmentOverFleet(
  ctx: RegistryContext,
  initial: LeaseHandle,
  fleet: NodeRecord[],
  result: AssignmentResult,
  keepAlive?: KeepAlive,
): Promise<AssignmentResult> {
  const [records, placements] = await Promise.all([
    listApplicationRecords(ctx),
    listPlacements(ctx),
  ]);
  /* The handle every write is fenced with, refreshed as the pass goes on. */
  let lease = initial;
  const served = new Set<string>();

  for (const record of records) {
    /* Blocking is the canonical reversible full stop. Runtime desired state
       omits this application, and its placement stays where it is: every record
       must survive for unblocking rather than be mistaken for orphaned state. */
    if (record.blocked === true) {
      served.add(record.name);
      continue;
    }
    if (record.retiredAt !== undefined) continue;

    const target = record.name;
    served.add(target);
    if (keepAlive !== undefined) lease = await keepAlive();

    const candidates = eligibleNodes(fleet, record.nodeSelector);
    if (candidates.length === 0) {
      result.unplaced.push({
        target,
        reason: "placement-unavailable",
        detail:
          `no live node carries every label of ` +
          `"${describeSelector(record.nodeSelector as NodeSelector)}", which "${target}" selects`,
      });
      continue;
    }

    const nodes = await assignNodes({
      application: target,
      nodes: candidates.map((entry) => entry.id),
      replicas: resolveReplicas(record),
    });
    const previous = placements.get(target)?.nodes ?? [];
    if (sameNodes(previous, nodes)) {
      result.skipped.push({ target, reason: "unchanged" });
      continue;
    }

    const write = await writePlacement(ctx, target, nodes, lease);
    if (write.outcome === "written") result.changed.push({ target, nodes });
    else if (write.outcome === "unchanged" || write.outcome === "cas-conflict")
      result.skipped.push({ target, reason: write.outcome });
    else if (write.outcome === "stale") {
      throw new ScafoError("lease-lost", "Coordinator placement fence is stale", {
        detail: `refusing later placement writes after "${target}" was decided at a higher fence`,
      });
    }
  }

  for (const name of [...placements.keys()].filter((key) => !served.has(key)).sort(compare)) {
    if (keepAlive !== undefined) lease = await keepAlive();
    const removed = await deletePlacement(ctx, name, lease);
    if (removed !== null) result.removed.push(removed);
  }
  return result;
}

function sameNodes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
