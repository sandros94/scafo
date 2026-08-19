/*
 * Internal: the coordinator's assignment duty — deciding which nodes serve which
 * environment, and writing that decision down.
 *
 * Runs on the coordinator alone, on every tick it holds the lease. Everything it
 * decides is a pure function of the environments and the live nodes, so a
 * coordinator that has just taken over reaches the same answers its predecessor
 * did without inheriting any state from it.
 */

import { ScaloError } from "../core/error.ts";
import { assignNodes } from "../core/placement/rendezvous.ts";
import { resolveReplicas } from "../core/placement/replicas.ts";
import { describeSelector, eligibleNodes } from "../core/placement/selector.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { listEnvironments } from "../core/registry/environments.ts";
import type { LeaseHandle } from "../core/registry/lease.ts";
import { isNodeLive, listNodeRecords } from "../core/registry/nodes.ts";
import { environmentKey } from "../core/registry/paths.ts";
import {
  deletePlacement,
  listPlacements,
  type PlacementOutcome,
  writePlacement,
} from "../core/registry/placement.ts";
import { listProjects } from "../core/registry/projects.ts";
import type { EnvironmentRecord, NodeRecord, NodeSelector } from "../core/types/registry.ts";

/**
 * Why one environment could not be placed on a pass, as a stable code.
 *
 * `placement-unavailable` — no live node was eligible to run it. Today that is
 * always a selector no live node satisfies: an empty FLEET refuses the whole
 * pass instead, before any environment is considered.
 */
export type AssignmentFailureReason = "placement-unavailable";

/** One environment a pass could decide nothing for, and why. */
export interface AssignmentFailure {
  /** `<project>/<env>`. */
  target: string;
  reason: AssignmentFailureReason;
  /** What an operator has to act on, naming the constraint that went unsatisfied. */
  detail: string;
}

/** What one assignment pass decided. */
export interface AssignmentResult {
  /** Ids of the nodes every decision in this pass was made over. */
  live: string[];
  /** Environments whose placement was rewritten. */
  changed: Array<{ target: string; nodes: string[] }>;
  /**
   * Placement objects removed because nothing should be serving what they name:
   * the environment is gone, or it has been retired.
   */
  removed: string[];
  /** Environments whose placement was left exactly as it was, and why. */
  skipped: Array<{ target: string; reason: PlacementOutcome }>;
  /**
   * Environments the pass could NOT place, whose previous placement — if they
   * had one — is left standing untouched. This is the operator's only sign that
   * a constraint has gone unsatisfiable, so it is reported rather than logged.
   */
  unplaced: AssignmentFailure[];
}

export interface AssignmentOptions {
  /** How long a node counts as live after its last heartbeat; see `isNodeLive`. */
  livenessWindowMs?: number;
}

/**
 * Decides and records the placement of every environment in the installation.
 *
 * Throws `ScaloError("placement-unavailable")` when NO node is live, having
 * written nothing. That refusal is the point: a bucket that briefly cannot be
 * reached, a clock that jumped, a fleet mid-restart — each of them reads as an
 * empty node list, and the decision that follows from an empty node list is
 * "nothing is served anywhere". Every node would then stop every process it
 * runs, and the installation would take itself down over a hiccup. Leaving the
 * last decision standing keeps whatever is running, running.
 *
 * The same reasoning applies one environment at a time to a node SELECTOR no
 * live node satisfies, and there it is reported rather than thrown: that
 * environment is left with the placement it already had, every other environment
 * in the pass is decided normally, and the failure is answered in
 * {@link AssignmentResult.unplaced}.
 *
 * Throws `ScaloError("lease-lost")` when the lease goes while it works; the
 * caller stops being the coordinator at that point.
 */
export async function runAssignment(
  ctx: RegistryContext,
  lease: LeaseHandle,
  opts?: AssignmentOptions,
): Promise<AssignmentResult> {
  const now = nowDate(ctx);
  const window = opts?.livenessWindowMs;
  /* Kept as RECORDS rather than reduced to ids here: an environment's selector
     is matched against the labels an operator set on a node, and only the record
     carries them. */
  const fleet: NodeRecord[] = (await listNodeRecords(ctx)).filter((record) =>
    isNodeLive(record, now, window === undefined ? {} : { windowMs: window }),
  );
  const live = fleet.map((record) => record.id);

  if (live.length === 0) {
    throw new ScaloError("placement-unavailable", "No node is live", {
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

  for (const project of await listProjects(ctx)) {
    const [names, placements] = await Promise.all([
      listEnvironments(ctx, project),
      listPlacements(ctx, project),
    ]);

    /* The environments that still ask to be served somewhere. What is NOT in
       here by the end of the loop has its placement removed below, whether it
       was never in the listing or dropped out of contention while reading it. */
    const served = new Set<string>();

    for (const name of names) {
      const found = await readJson<EnvironmentRecord>(ctx, environmentKey(project, name));
      /* Deleted between the listing and the read: the pass that deleted it takes
         its placement with it, and the next tick sees neither. */
      if (found === null) continue;

      /* Retired: an environment on its way out is served by no node, so it is
         given none. Its placement record goes with it — a record naming nodes
         that have all stopped running it is a decision nothing acts on, and
         leaving it behind would have every node re-read it every pass until the
         reap. Unretiring restores it on the next tick, from the same inputs. */
      if (found.value.retiredAt !== undefined) continue;
      served.add(name);

      const target = `${project}/${name}`;
      const selector = found.value.nodeSelector;
      /* The selector narrows the CANDIDATES, and rendezvous then picks replicas
         of those — in that order, so the two compose instead of competing:
         `replicas: "all"` under a selector means every MATCHING node, and a
         count means that many OF the matching ones. */
      const candidates = eligibleNodes(fleet, selector).map((record) => record.id);

      if (candidates.length === 0) {
        /*
         * ZERO ELIGIBLE CANDIDATES: WRITE NOTHING, DELETE NOTHING.
         *
         * The environment stays in `served` above, so the sweep at the end of
         * this project leaves its placement exactly where it is, and no empty
         * decision is written over it either. A STALE-BUT-SERVING placement
         * beats an outage: the two alternatives are an empty node list, which
         * stops the environment on every node still running it, and no record at
         * all, which — because a selector-bearing environment has no
         * run-everywhere fallback — stops it just as dead. Neither is a decision
         * an unsatisfiable constraint has earned the right to make.
         *
         * The far likelier causes are a node that has not come back yet, a
         * typo'd label and a fleet mid-relabelling, none of which should take an
         * application down. So the failure is REPORTED instead: it reaches the
         * operator through the coordinator's status and `/v1/state`, naming the
         * environment and the selector nothing satisfied.
         */
        result.unplaced.push({
          target,
          reason: "placement-unavailable",
          detail:
            `${describeWhy(target, selector)}, so its last placement is left exactly as it ` +
            `stands: writing an empty decision — or removing the record — would stop the ` +
            `environment on every node still serving it, over what is far more likely a node ` +
            `that is missing or mislabelled than an environment that should stop`,
        });
        continue;
      }

      const nodes = await assignNodes({
        project,
        env: name,
        nodes: candidates,
        replicas: resolveReplicas(found.value),
      });

      /* Answered from the listing above rather than by reading the object
         again. This is the settled case — every environment, every tick, on an
         installation where nothing has changed — and a coordinator that re-read
         each placement to conclude it was already right would double the reads
         of its most frequent pass. A listing that has since gone stale costs
         nothing: the write below re-reads before it conditions on anything. */
      if (equalNodes(placements.get(name)?.nodes, nodes)) {
        result.skipped.push({ target, reason: "unchanged" });
        continue;
      }

      const write = await writePlacement(ctx, project, name, nodes, lease);
      if (write.outcome === "written") result.changed.push({ target, nodes });
      else result.skipped.push({ target, reason: write.outcome });
    }

    /* What is left in the map has no environment left to serve. Deleting it here
       covers the environment that went away without anyone asking — a reap this
       coordinator did not run, an operator deleting through another node — and
       the retired one above, while an explicit deletion has already cleaned up
       after itself. */
    for (const env of [...placements.keys()].sort()) {
      if (served.has(env)) continue;
      const removed = await deletePlacement(ctx, project, env, lease);
      if (removed !== null) result.removed.push(removed);
    }
  }

  return result;
}

/**
 * Why nothing could be given an environment, named so the operator can act on
 * it. A selector is the only way to get here — an empty FLEET refuses the whole
 * pass long before — but the unconstrained wording is kept honest rather than
 * assumed away.
 */
function describeWhy(target: string, selector: NodeSelector | undefined): string {
  if (selector === undefined) return `no live node can serve "${target}"`;
  return (
    `no live node carries every label of "${describeSelector(selector)}", ` +
    `which "${target}" selects`
  );
}

/** Both are sorted — `assignNodes` sorts what it chooses and the record stores it sorted. */
function equalNodes(recorded: string[] | undefined, decided: string[]): boolean {
  return (
    recorded !== undefined &&
    recorded.length === decided.length &&
    recorded.every((id, index) => id === decided[index])
  );
}
