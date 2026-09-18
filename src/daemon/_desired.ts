/* Internal: what the registry says THIS node should be serving. */

import { deploymentRevision } from "../core/registry/_revision.ts";
import { findApplication, listApplications } from "../core/registry/applications.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { listPlacements } from "../core/registry/placement.ts";
import { createConcurrencyGate, mapConcurrent } from "../core/utils/concurrency.ts";
import type { ApplicationRecord, NodeSelector, PlacementRecord } from "../core/types/registry.ts";

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

/** Reads desired applications for one node. Nothing is served without an
 * explicit placement naming it. The record reads share one concurrency gate and
 * retain listing order. */
export async function readDesired(
  registry: RegistryContext,
  opts: { nodeId: string; concurrency?: number },
): Promise<DesiredState> {
  const gate = createConcurrencyGate(opts.concurrency);
  const [names, placements] = await Promise.all([
    listApplications(registry),
    listPlacements(registry, { concurrency: gate }),
  ]);

  /* The gate bounds these tasks from the outside, and each of them holds its
     slot for the one read it makes: a task that took a slot and then awaited the
     same gate from inside would deadlock as soon as every slot was taken. */
  const parts = await mapConcurrent(names, gate, async (name) =>
    readApplication(registry, name, opts.nodeId, placements.get(name)),
  );

  const state: DesiredState = { applications: [], fleet: [], placements: [] };
  for (const part of parts) {
    state.applications.push(...part.applications);
    state.fleet.push(...part.fleet);
    state.placements.push(...part.placements);
  }
  return state;
}

/** What one application contributes to this node's state, and nothing else's. */
async function readApplication(
  registry: RegistryContext,
  name: string,
  nodeId: string,
  placement: PlacementRecord | undefined,
): Promise<DesiredState> {
  const state: DesiredState = { applications: [], fleet: [], placements: [] };
  /* Unplaced is not a state this node may resolve on its own: only the
     coordinator says where an application runs. */
  if (placement === undefined) return state;

  /* One record answers placement view, selector, blocking and deployment state. */
  const record = await findApplication(registry, name);
  /* A record deleted after listing is absent on the next pass. */
  if (record === null) return state;

  state.placements.push({
    application: name,
    nodes: [...placement.nodes],
    self: placement.nodes.includes(nodeId),
    ...(record.nodeSelector === undefined ? {} : { selector: { ...record.nodeSelector } }),
  });

  /* A blocked application is served nowhere; its placement stays for unblocking. */
  if (record.blocked === true) return state;
  if (!isServable(record)) return state;

  state.fleet.push(record);
  if (placement.nodes.includes(nodeId)) state.applications.push(record);
  return state;
}

/** Whether an application is deployed and not retired, so something may serve it. */
export function isServable(application: ApplicationRecord): boolean {
  /* Retirement outranks the placement that still names this node. */
  if (application.retiredAt !== undefined) return false;
  return deploymentRevision(application) !== null;
}
