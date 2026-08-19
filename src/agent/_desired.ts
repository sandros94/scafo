/* Internal: what the registry says THIS node should be serving. */

import { ScaloError } from "../core/error.ts";
import type { DesiredEnvironment } from "../core/placement/reconcile.ts";
import { getBuild } from "../core/registry/builds.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { getEnvironment, listEnvironments } from "../core/registry/environments.ts";
import { listPlacements } from "../core/registry/placement.ts";
import { listProjects } from "../core/registry/projects.ts";
import { getVarsetEnvelope, openVarset } from "../core/registry/varsets.ts";
import type { PlacementRecord, PlainVarset } from "../core/types/registry.ts";

/** One environment's placement as this node reads it. */
export interface PlacementView {
  project: string;
  env: string;
  /** Nodes the coordinator gave it. */
  nodes: string[];
  /** True when this node is one of them. */
  self: boolean;
}

/** What one read of the registry told this node. */
export interface DesiredState {
  /** Environments this node should serve, with their alias build resolved. */
  environments: DesiredEnvironment[];
  /**
   * The placement decisions this node read, one per environment that HAS one.
   * An environment missing from this list has not been placed by any
   * coordinator yet, and is served everywhere.
   */
  placements: PlacementView[];
}

/**
 * Every environment this node has something to serve for, with the build its
 * alias points at already resolved.
 *
 * An environment whose alias was never flipped is left out — it has no build
 * yet, so there is nothing to run for it. So is one whose placement record names
 * other nodes: that is a reassignment taking effect, and the caller stops
 * whatever it still runs for it while the nodes named pick it up on their own
 * passes.
 *
 * MISSING PLACEMENT RECORD → THE ENVIRONMENT IS INCLUDED. This fallback is the
 * safety line the whole feature hangs from, and it is deliberate rather than
 * lenient. No coordinator has decided anything yet during a bootstrap, on a
 * single-node installation, and throughout a rolling upgrade from a build that
 * never wrote these records — and in every one of those the right answer is the
 * one scalo gave before placement existed: serve it here. Reading a missing
 * record as "not mine" instead would take an entire installation off the air the
 * first time it upgraded, and would leave a fresh one serving nothing at all
 * until its first coordinator tick.
 */
export async function readDesired(
  registry: RegistryContext,
  opts: { nodeId: string },
): Promise<DesiredState> {
  const projects = await listProjects(registry);

  const perProject = await Promise.all(
    projects.map(async (project) => readProject(registry, project, opts.nodeId)),
  );
  return {
    environments: perProject.flatMap((entry) => entry.environments),
    placements: perProject.flatMap((entry) => entry.placements),
  };
}

/**
 * Opens the varset an environment points at, or null when it points at none.
 *
 * Throws rather than answering null when the environment has one this node
 * cannot open — no key at all, the wrong key, or an envelope that will not
 * decrypt. A process started without the variables its environment is
 * configured with is a silent misconfiguration: it would come up, pass its
 * readiness gate and serve requests against whatever defaults its code falls
 * back to. The caller records the failure against that one environment and
 * leaves whatever already serves it running.
 */
export async function openEnvironmentVars(
  registry: RegistryContext,
  wanted: DesiredEnvironment,
  key?: CryptoKey,
): Promise<PlainVarset | null> {
  const varsetId = wanted.varsetId;
  if (varsetId === undefined) return null;

  if (key === undefined) {
    throw new ScaloError("invalid-varset", "No key for this environment's variables", {
      detail:
        `"${wanted.project}/${wanted.env.name}" is configured with varset "${varsetId}", ` +
        `which this node holds no key for: point "varsets.keyFile" at the key file, ` +
        `set SCALO_VARSET_KEY_FILE, or pass --varset-key-file`,
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
): Promise<DesiredState> {
  /* One listing for the whole project rather than a read per environment: the
     environments nobody has decided about cost nothing, and the ones that have
     been decided are read once each. */
  const [names, placements] = await Promise.all([
    listEnvironments(registry, project),
    listPlacements(registry, project),
  ]);

  const state: DesiredState = { environments: [], placements: [] };

  for (const name of names) {
    const placement = placements.get(name);
    if (placement !== undefined) {
      state.placements.push({
        project,
        env: name,
        nodes: [...placement.nodes],
        self: placement.nodes.includes(nodeId),
      });
    }
    if (!servedHere(placement, nodeId)) continue;

    const wanted = await resolveEnvironment(registry, project, name);
    if (wanted !== null) state.environments.push(wanted);
  }
  return state;
}

/** See {@link readDesired}: no record at all means every node serves it. */
function servedHere(placement: PlacementRecord | undefined, nodeId: string): boolean {
  return placement === undefined || placement.nodes.includes(nodeId);
}

async function resolveEnvironment(
  registry: RegistryContext,
  project: string,
  name: string,
): Promise<DesiredEnvironment | null> {
  const env = await getEnvironment(registry, project, name);
  const aliased = env.alias?.build;
  if (aliased === undefined) return null;

  return {
    project,
    env,
    build: await getBuild(registry, project, aliased),
    varsetId: env.varset,
  };
}
