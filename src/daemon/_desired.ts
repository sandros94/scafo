/* Internal: what the registry says THIS node should be serving. */

import { deploymentRevision } from "../core/registry/_revision.ts";
import type { RegistrySnapshot } from "../core/registry/view.ts";
import type { ApplicationRecord, NodeSelector } from "../core/types/registry.ts";

/** One application's placement as this node reads it. */
export interface PlacementView {
  application: string;
  /** Nodes the coordinator gave it. */
  nodes: string[];
  /** True when this node is one of them. */
  self: boolean;
  /** Required node labels, reported with the placement decision. */
  selector?: NodeSelector;
}

/** What one read of the registry told this node. */
export interface DesiredState {
  /** Deployed applications this node should serve. */
  applications: ApplicationRecord[];
  /**
   * Every deployed application the fleet serves somewhere, this node's included:
   * what the fleet's routing is rendered from. Read on the way past — the same
   * record answers whether this node serves it — so the fleet view costs the
   * pass nothing it was not already reading.
   */
  fleet: ApplicationRecord[];
  /** Placement decisions read. An application without one is pending, never implied. */
  placements: PlacementView[];
}

/**
 * Reads this node's desired state off a registry snapshot. Nothing is served
 * without an explicit placement naming it.
 *
 * PURE, and over a snapshot rather than over the bucket: the records it needs
 * are the ones every other loop on this node needs, so they are read once by the
 * view and decided on here. A pass that read them for itself would be the pass
 * that made an idle installation cost its own size several times a minute.
 */
export function desiredFrom(snapshot: RegistrySnapshot, opts: { nodeId: string }): DesiredState {
  const state: DesiredState = { applications: [], fleet: [], placements: [] };

  for (const record of snapshot.applications) {
    /* Unplaced is not a state this node may resolve on its own: only the
       coordinator says where an application runs. */
    const placement = snapshot.placements.get(record.name);
    if (placement === undefined) continue;

    const self = placement.nodes.includes(opts.nodeId);
    state.placements.push({
      application: record.name,
      nodes: [...placement.nodes],
      self,
      ...(record.nodeSelector === undefined ? {} : { selector: { ...record.nodeSelector } }),
    });

    /* A blocked application is served nowhere; its placement stays for unblocking. */
    if (record.blocked === true) continue;
    if (!isServable(record)) continue;

    state.fleet.push(record);
    if (self) state.applications.push(record);
  }
  return state;
}

/** Whether an application is deployed and not retired, so something may serve it. */
export function isServable(application: ApplicationRecord): boolean {
  /* Retirement outranks the placement that still names this node. */
  if (application.retiredAt !== undefined) return false;
  return deploymentRevision(application) !== null;
}
