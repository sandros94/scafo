/* Internal: what the registry says THIS node should be serving. */

import { isScafoError, ScafoError } from "../core/error.ts";
import type { DesiredBuild, DesiredEnvironment } from "../core/placement/reconcile.ts";
import { getBuild } from "../core/registry/builds.ts";
import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { listEnvironments } from "../core/registry/environments.ts";
import { environmentKey } from "../core/registry/paths.ts";
import { listPlacements } from "../core/registry/placement.ts";
import { listProjects } from "../core/registry/projects.ts";
import { getVarsetEnvelope, openVarset } from "../core/registry/varsets.ts";
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
  /**
   * The labels the environment requires of a node, when it requires any.
   *
   * Reported beside the decision rather than instead of it, so an operator
   * looking at a placement that surprises them sees the CONSTRAINT and the
   * outcome together — a decision naming one node reads very differently when
   * the environment asked for exactly one kind of node.
   */
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
  /** Environments this node should serve, with their builds resolved. */
  environments: DesiredEnvironment[];
  /**
   * The placement decisions this node read, one per environment that HAS one.
   *
   * An environment missing from this list has not been placed by any coordinator
   * yet — which means it is served everywhere, unless it carries a node selector
   * and is therefore waiting to be placed. See {@link readDesired}.
   */
  placements: PlacementView[];
  /**
   * Environments that were read but could not be fully resolved, each naming
   * what was missing. The environment is still desired — see
   * {@link readDesired} — so this reports a gap rather than a removal.
   */
  failures: DesiredFailure[];
}

/**
 * Every environment this node has something to serve for, with the builds it
 * should run already resolved: the one its alias points at, plus every leg of
 * its traffic split.
 *
 * An environment whose alias was never flipped is left out — it has no build
 * yet, so there is nothing to run for it. So is one whose placement record names
 * other nodes: that is a reassignment taking effect, and the caller stops
 * whatever it still runs for it while the nodes named pick it up on their own
 * passes. And so is a RETIRED one, which leaves by the same door: it drops out
 * of this state, the next pass stops its processes, and because the routing is
 * rendered from what this node actually runs, its hosts stop resolving with
 * them. Nothing in the route renderer knows what retirement is, and nothing in
 * it needs to.
 *
 * MISSING PLACEMENT RECORD → THE ENVIRONMENT IS INCLUDED, UNLESS IT CARRIES A
 * NODE SELECTOR. Both halves of that are deliberate, and they point in opposite
 * directions on purpose.
 *
 * The FALLBACK is the safety line the whole feature hangs from. No coordinator
 * has decided anything yet during a bootstrap, on a single-node installation, or
 * throughout a rolling upgrade from a build that never wrote these records — and
 * in every one of those the right answer is the one scafo gave before placement
 * existed: serve it here. Reading a missing record as "not mine" instead would
 * take an entire installation off the air the first time it upgraded, and would
 * leave a fresh one serving nothing at all until its first coordinator tick.
 *
 * The EXCEPTION is what a selector means. A selector is an explicit constraint —
 * the operator has said which nodes may run this — and the fallback exists to
 * preserve behaviour nobody ever stated. Running a selector-bearing environment
 * on an arbitrary node just because no coordinator has decided yet would violate
 * exactly what was asked for, and on the widest possible set of nodes: every one
 * of them, including all the ones the selector excludes. So a selector without a
 * decision waits for the coordinator, and the cost of waiting is a few seconds
 * of nothing running — against, in the other reading, an application placed on
 * hardware it was explicitly kept off.
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
    failures: perProject.flatMap((entry) => entry.failures),
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
): Promise<DesiredState> {
  /* One listing of each kind for the whole project, rather than two reads per
     environment: only the environments that HAVE a decision cost a placement
     read at all. */
  const [names, placements] = await Promise.all([
    listEnvironments(registry, project),
    listPlacements(registry, project),
  ]);

  const state: DesiredState = { environments: [], placements: [], failures: [] };

  for (const name of names) {
    /* Read once and used for every question this loop asks: whether the
       environment constrains where it runs, what its placement view should
       report, and what there is to serve. */
    const found = await readJson<EnvironmentRecord>(registry, environmentKey(project, name));
    /* Deleted between the listing and the read: the next pass sees neither it
       nor its placement, and nothing here has to pretend it was there. */
    if (found === null) continue;
    const environment = found.value;

    const placement = placements.get(name);
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
    if (!servedHere(placement, environment, nodeId)) continue;

    const wanted = await resolveEnvironment(registry, project, environment, state.failures);
    if (wanted !== null) state.environments.push(wanted);
  }
  return state;
}

/**
 * See {@link readDesired}. A decision, once there is one, is the whole answer.
 * Without one the environment runs everywhere — UNLESS it carries a selector, in
 * which case running it here before the coordinator has chosen would break the
 * one thing the operator asked for.
 */
function servedHere(
  placement: PlacementRecord | undefined,
  environment: EnvironmentRecord,
  nodeId: string,
): boolean {
  if (placement !== undefined) return placement.nodes.includes(nodeId);
  return environment.nodeSelector === undefined;
}

/**
 * One environment's builds: the alias, then every split leg it does not already
 * name. Null when the environment has nothing to serve at all.
 *
 * A SPLIT LEG WHOSE BUILD RECORD IS GONE is recorded against the environment and
 * left in {@link DesiredEnvironment.unresolved} rather than dropped quietly. The
 * planner counts it as an unproven leg, which holds back every stop for that
 * environment: whatever it is running now — including the leg that vanished —
 * keeps running. Silently dropping it would instead retire that leg the moment
 * the others were ready, and hand its share of the traffic to them, over a
 * build the operator never withdrew. The reaper refuses to delete a build any
 * split references, so this is a corrupted or raced registry rather than the
 * ordinary way a leg goes away; the ordinary way is `scafo env split --clear`.
 *
 * The ALIAS build is not treated that way and must not be: it is the whole of
 * what the environment serves when there is no split, so a missing one is not a
 * gap in an environment, it is an environment nothing can be planned for. It
 * raises, the pass records it and plans nothing at all, and nothing is stopped.
 */
async function resolveEnvironment(
  registry: RegistryContext,
  project: string,
  env: EnvironmentRecord,
  failures: DesiredFailure[],
): Promise<DesiredEnvironment | null> {
  /*
   * On its way out: an environment an operator has retired is served nowhere,
   * from the next pass on. It still HAS a build — retirement is reversible, and
   * unretiring it must bring it straight back — so what stops it is this line
   * rather than anything having been taken away from it.
   *
   * LOAD-BEARING, and in the opposite direction to how it reads. The coordinator
   * DELETES the placement record of a retired environment, and a missing
   * placement record means "served everywhere" (see {@link readDesired}). Drop
   * this check and retiring an environment would not stop it — it would start it
   * on every node in the installation.
   */
  if (env.retiredAt !== undefined) return null;

  const aliased = env.alias?.build;
  if (aliased === undefined) return null;

  const builds: DesiredBuild[] = [
    { build: await getBuild(registry, project, aliased), role: "alias" },
  ];
  const unresolved: string[] = [];

  for (const entry of env.split ?? []) {
    if (builds.some((leg) => leg.build.id === entry.build)) continue;

    try {
      builds.push({ build: await getBuild(registry, project, entry.build), role: "split" });
    } catch (error) {
      if (!isScafoError(error) || error.code !== "not-found") throw error;
      unresolved.push(entry.build);
      failures.push({
        subject: `${project}/${env.name}`,
        detail:
          `build "${entry.build}" is a leg of this environment's traffic split but has no ` +
          `record in the registry, so it cannot be started; nothing this environment runs ` +
          `is stopped while a leg is unresolved`,
      });
    }
  }

  return {
    project,
    env,
    builds,
    ...(unresolved.length === 0 ? {} : { unresolved }),
    varsetId: env.varset,
  };
}
