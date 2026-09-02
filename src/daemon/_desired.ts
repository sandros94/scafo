/* Internal: what the registry says THIS node should be serving. */

import { ScafoError } from "../core/error.ts";
import type { DesiredEnvironment } from "../core/placement/reconcile.ts";
import { deploymentRevision } from "../core/registry/_deployment.ts";
import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { listEnvironments } from "../core/registry/environments.ts";
import { environmentKey } from "../core/registry/paths.ts";
import { listPlacements } from "../core/registry/placement.ts";
import { isProjectBlocked, listProjects } from "../core/registry/projects.ts";
import { getVarsetEnvelope, openVarset } from "../core/registry/varsets.ts";
import {
  type ConcurrencyGate,
  createConcurrencyGate,
  mapConcurrent,
} from "../core/utils/concurrency.ts";
import type {
  EnvironmentRecord,
  NodeSelector,
  PlacementRecord,
  PlainVarset,
} from "../core/types/registry.ts";

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

/** Something one read could not resolve, recorded against the environment it concerns. */
export interface DesiredFailure {
  /** `project/environment`. */
  subject: string;
  detail: string;
}

/** What one read of the registry told this node. */
export interface DesiredState {
  /** Deployed environments this node should serve. */
  environments: DesiredEnvironment[];
  /** Placement decisions read. Missing placement is pending for production mode. */
  placements: PlacementView[];
  /** Resolution failures for environments that remain otherwise desired. */
  failures: DesiredFailure[];
}

/** The caller states whether it is a new daemon or the rolling-upgrade reader. */
export type PlacementReadMode = "required" | "legacy-fallback";

/** Reads desired environments for one node. Production requires explicit
 * placement; legacy fallback applies only to unconstrained environments. All
 * registry reads share one concurrency gate and retain listing order. */
export async function readDesired(
  registry: RegistryContext,
  opts: { nodeId: string; mode: PlacementReadMode; concurrency?: number },
): Promise<DesiredState> {
  const projects = await listProjects(registry);
  const gate = createConcurrencyGate(opts.concurrency);

  /* Gate only store reads: gating project tasks themselves could deadlock. */
  const perProject = await Promise.all(
    projects.map(async (project) =>
      readProject(registry, project, opts.nodeId, gate, opts.mode === "required"),
    ),
  );
  return {
    environments: perProject.flatMap((entry) => entry.environments),
    placements: perProject.flatMap((entry) => entry.placements),
    failures: perProject.flatMap((entry) => entry.failures),
  };
}

/** Opens an environment varset. A configured but unreadable varset throws so
 * the caller records the failure instead of starting with missing variables. */
export async function openEnvironmentVars(
  registry: RegistryContext,
  wanted: DesiredEnvironment,
  key?: CryptoKey,
): Promise<PlainVarset | null> {
  const varsetId = wanted.varsetId;
  if (varsetId === undefined) return null;

  if (key === undefined) {
    throw new ScafoError("invalid-varset", "No key for this environment's variables", {
      detail:
        `"${wanted.project}/${wanted.env.name}" is configured with varset "${varsetId}", ` +
        `which this node holds no key for: point "varsets.keyFile" at the key file, ` +
        `set SCAFO_VARSET_KEY_FILE, or pass --varset-key-file`,
    });
  }

  const envelope = await getVarsetEnvelope(registry, wanted.project, varsetId);
  return openVarset(envelope, key);
}

/** One project's environments, filtered to this node, and what placed them. */
async function readProject(
  registry: RegistryContext,
  project: string,
  nodeId: string,
  gate: ConcurrencyGate,
  requirePlacement: boolean,
): Promise<DesiredState> {
  /* Blocked projects contribute no desired state and avoid further listings. */
  if (await gate.run(() => isProjectBlocked(registry, project))) {
    return { environments: [], placements: [], failures: [] };
  }

  /* List environments and placements once per project. */
  const [names, placements] = await Promise.all([
    listEnvironments(registry, project),
    listPlacements(registry, project, { concurrency: gate }),
  ]);

  /* Resolve environments concurrently, preserving listed order in `parts`. */
  const parts = await mapConcurrent(names, gate, async (name) =>
    readEnvironment(registry, project, name, nodeId, placements.get(name), requirePlacement),
  );

  const state: DesiredState = { environments: [], placements: [], failures: [] };
  for (const part of parts) {
    state.environments.push(...part.environments);
    state.placements.push(...part.placements);
    state.failures.push(...part.failures);
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
  requirePlacement: boolean,
): Promise<DesiredState> {
  const state: DesiredState = { environments: [], placements: [], failures: [] };

  /* One record answers placement view, selector, and deployment state. */
  const found = await readJson<EnvironmentRecord>(registry, environmentKey(project, name));
  /* A record deleted after listing is absent on the next pass. */
  if (found === null) return state;
  const environment = found.value;

  if (placement !== undefined) {
    state.placements.push({
      project,
      env: name,
      nodes: [...placement.nodes],
      self: placement.nodes.includes(nodeId),
      ...(environment.nodeSelector === undefined
        ? {}
        : { selector: { ...environment.nodeSelector } }),
    });
  }
  if (!servedHere(placement, environment, nodeId, requirePlacement)) return state;

  const wanted = resolveEnvironmentDeployment(project, environment);
  if (wanted !== null) state.environments.push(wanted);
  return state;
}

/** Placement decisions override fallback. Legacy fallback never bypasses a selector. */
function servedHere(
  placement: PlacementRecord | undefined,
  environment: EnvironmentRecord,
  nodeId: string,
  requirePlacement: boolean,
): boolean {
  if (placement !== undefined) return placement.nodes.includes(nodeId);
  if (requirePlacement) return false;
  return environment.nodeSelector === undefined;
}

/** Resolves a deployable, non-retired environment from its deployment notice. */
export function resolveEnvironmentDeployment(
  project: string,
  env: EnvironmentRecord,
): DesiredEnvironment | null {
  /* Retirement overrides both explicit placement and legacy fallback. */
  if (env.retiredAt !== undefined) return null;
  const revision = deploymentRevision(env);
  if (revision === null) return null;

  return {
    project,
    env,
    varsetId: env.varset,
  };
}
