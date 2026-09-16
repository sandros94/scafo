/* Internal: what the registry says THIS node should be serving. */

import type { DesiredEnvironment } from "../core/placement/reconcile.ts";
import { deploymentRevision } from "../core/registry/_deployment.ts";
import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { listEnvironments } from "../core/registry/environments.ts";
import { environmentKey } from "../core/registry/paths.ts";
import { listPlacements } from "../core/registry/placement.ts";
import { isProjectBlocked, listProjects } from "../core/registry/projects.ts";
import {
  type ConcurrencyGate,
  createConcurrencyGate,
  mapConcurrent,
} from "../core/utils/concurrency.ts";
import type { EnvironmentRecord, NodeSelector, PlacementRecord } from "../core/types/registry.ts";

/** One environment's placement as this node reads it. */
export interface PlacementView {
  project: string;
  env: string;
  /** Nodes the coordinator gave it. */
  nodes: string[];
  /** True when this node is one of them. */
  self: boolean;
  /** Required node labels, reported with the placement decision. */
  selector?: NodeSelector;
}

/** What one read of the registry told this node. */
export interface DesiredState {
  /** Deployed environments this node should serve. */
  environments: DesiredEnvironment[];
  /**
   * Every deployed environment the fleet serves somewhere, this node's included:
   * what the fleet's routing is rendered from. Read on the way past — the same
   * record answers whether this node serves it — so the fleet view costs the
   * pass nothing it was not already reading.
   */
  fleet: Array<{ project: string; env: EnvironmentRecord }>;
  /** Placement decisions read. An environment without one is pending, never implied. */
  placements: PlacementView[];
}

/** Reads desired environments for one node. Nothing is served without an
 * explicit placement naming it. The record reads share one concurrency gate
 * across every project and retain listing order. */
export async function readDesired(
  registry: RegistryContext,
  opts: { nodeId: string; concurrency?: number },
): Promise<DesiredState> {
  const projects = await listProjects(registry);
  const gate = createConcurrencyGate(opts.concurrency);

  /* The projects run ungated and take slots only for the reads inside them: a
     project task holding a slot while it waits on the same gate would deadlock. */
  const perProject = await Promise.all(
    projects.map(async (project) => readProject(registry, project, opts.nodeId, gate)),
  );
  return {
    environments: perProject.flatMap((entry) => entry.environments),
    fleet: perProject.flatMap((entry) => entry.fleet),
    placements: perProject.flatMap((entry) => entry.placements),
  };
}

/** One project's environments, filtered to this node, and what placed them. */
async function readProject(
  registry: RegistryContext,
  project: string,
  nodeId: string,
  gate: ConcurrencyGate,
): Promise<DesiredState> {
  /* A blocked project is served nowhere, so its listings are never read. */
  if (await gate.run(() => isProjectBlocked(registry, project))) {
    return { environments: [], fleet: [], placements: [] };
  }

  /* List environments and placements once per project. */
  const [names, placements] = await Promise.all([
    listEnvironments(registry, project),
    listPlacements(registry, project, { concurrency: gate }),
  ]);

  /* Resolve environments concurrently, preserving listed order in `parts`. */
  const parts = await mapConcurrent(names, gate, async (name) =>
    readEnvironment(registry, project, name, nodeId, placements.get(name)),
  );

  const state: DesiredState = { environments: [], fleet: [], placements: [] };
  for (const part of parts) {
    state.environments.push(...part.environments);
    state.fleet.push(...part.fleet);
    state.placements.push(...part.placements);
  }
  return state;
}

/** What one environment contributes to its project's state, and nothing else's. */
async function readEnvironment(
  registry: RegistryContext,
  project: string,
  name: string,
  nodeId: string,
  placement: PlacementRecord | undefined,
): Promise<DesiredState> {
  const state: DesiredState = { environments: [], fleet: [], placements: [] };
  /* Unplaced is not a state this node may resolve on its own: only the
     coordinator says where an environment runs. */
  if (placement === undefined) return state;

  /* One record answers placement view, selector, and deployment state. */
  const found = await readJson<EnvironmentRecord>(registry, environmentKey(project, name));
  /* A record deleted after listing is absent on the next pass. */
  if (found === null) return state;
  const environment = found.value;

  state.placements.push({
    project,
    env: name,
    nodes: [...placement.nodes],
    self: placement.nodes.includes(nodeId),
    ...(environment.nodeSelector === undefined
      ? {}
      : { selector: { ...environment.nodeSelector } }),
  });

  const wanted = resolveEnvironmentDeployment(project, environment);
  if (wanted === null) return state;
  state.fleet.push({ project, env: environment });
  if (placement.nodes.includes(nodeId)) state.environments.push(wanted);
  return state;
}

/** Resolves a deployable, non-retired environment from its deployment notice. */
export function resolveEnvironmentDeployment(
  project: string,
  env: EnvironmentRecord,
): DesiredEnvironment | null {
  /* Retirement outranks the placement that still names this node. */
  if (env.retiredAt !== undefined) return null;
  const revision = deploymentRevision(env);
  if (revision === null) return null;

  return { project, env };
}
