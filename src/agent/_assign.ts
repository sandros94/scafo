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
import type { EnvironmentRecord } from "../core/types/registry.ts";

/** What one assignment pass decided. */
export interface AssignmentResult {
  /** Ids of the nodes every decision in this pass was made over. */
  live: string[];
  /** Environments whose placement was rewritten. */
  changed: Array<{ target: string; nodes: string[] }>;
  /** Placement objects removed because the environment they name is gone. */
  removed: string[];
  /** Environments whose placement was left exactly as it was, and why. */
  skipped: Array<{ target: string; reason: PlacementOutcome }>;
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
  const live = (await listNodeRecords(ctx))
    .filter((record) => isNodeLive(record, now, window === undefined ? {} : { windowMs: window }))
    .map((record) => record.id);

  if (live.length === 0) {
    throw new ScaloError("placement-unavailable", "No node is live", {
      detail:
        `no registered node has reported in recently enough to be given work, so every ` +
        `placement is left exactly as it stands: deciding that nothing is served anywhere ` +
        `would stop every process in the installation over what is far more likely a ` +
        `registry or clock problem than an empty fleet`,
    });
  }

  const result: AssignmentResult = { live, changed: [], removed: [], skipped: [] };

  for (const project of await listProjects(ctx)) {
    const [names, placements] = await Promise.all([
      listEnvironments(ctx, project),
      listPlacements(ctx, project),
    ]);

    for (const name of names) {
      const found = await readJson<EnvironmentRecord>(ctx, environmentKey(project, name));
      /* Deleted between the listing and the read: the pass that deleted it takes
         its placement with it, and the next tick sees neither. */
      if (found === null) continue;

      const target = `${project}/${name}`;
      const nodes = await assignNodes({
        project,
        env: name,
        nodes: live,
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

    /* What is left in the map has no environment to belong to. Deleting it here
       covers the environment that went away without anyone asking — a reap this
       coordinator did not run, an operator deleting through another node — while
       an explicit deletion has already cleaned up after itself. */
    const known = new Set(names);
    for (const env of [...placements.keys()].sort()) {
      if (known.has(env)) continue;
      const removed = await deletePlacement(ctx, project, env, lease);
      if (removed !== null) result.removed.push(removed);
    }
  }

  return result;
}

/** Both are sorted — `assignNodes` sorts what it chooses and the record stores it sorted. */
function equalNodes(recorded: string[] | undefined, decided: string[]): boolean {
  return (
    recorded !== undefined &&
    recorded.length === decided.length &&
    recorded.every((id, index) => id === decided[index])
  );
}
