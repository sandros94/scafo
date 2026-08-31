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
  /** Deployed environments this node should serve. */
  environments: DesiredEnvironment[];
  /**
   * The placement decisions this node read, one per environment that HAS one.
   *
   * An environment missing from this list has not been placed by any coordinator
   * yet. Legacy reads serve an unconstrained environment everywhere; production
   * reconciles require placement and leave it pending. See {@link readDesired}.
   */
  placements: PlacementView[];
  /**
   * Environments that were read but could not be fully resolved, each naming
   * what was missing. The environment is still desired — see
   * {@link readDesired} — so this reports a gap rather than a removal.
   */
  failures: DesiredFailure[];
}

/** The caller states whether it is a new daemon or the rolling-upgrade reader. */
export type PlacementReadMode = "required" | "legacy-fallback";

/**
 * Every deployed environment this node has something to serve for.
 *
 * An environment without a deployment is left out — there is nothing to run
 * for it. So is one whose placement record names
 * other nodes: that is a reassignment taking effect, and the caller stops
 * whatever it still runs for it while the nodes named pick it up on their own
 * passes. And so is a RETIRED one, which leaves by the same door: it drops out
 * of this state, the next pass stops its processes, and because the routing is
 * rendered from what this node actually runs, its hosts stop resolving with
 * them. Nothing in the route renderer knows what retirement is, and nothing in
 * it needs to.
 *
 * MISSING PLACEMENT RECORD → LEGACY READS include an unconstrained environment;
 * production reads opt into `mode: "required"` and include none. The explicit
 * option keeps rolling upgrades compatible without making a new daemon infer
 * service from an absent coordinator decision.
 *
 * Legacy fallback is solely a rolling-upgrade contract: an old daemon does not
 * understand that a missing record is pending, so it retains the behaviour it
 * shipped with. New daemons state `mode: "required"` and wait for the
 * coordinator's explicit decision.
 *
 * The LEGACY EXCEPTION is what a selector means. A selector is an explicit constraint —
 * the operator has said which nodes may run this — and the fallback exists to
 * preserve behaviour nobody ever stated. Running a selector-bearing environment
 * on an arbitrary node just because no coordinator has decided yet would violate
 * exactly what was asked for, and on the widest possible set of nodes: every one
 * of them, including all the ones the selector excludes. So a selector without a
 * decision waits for the coordinator, and the cost of waiting is a few seconds
 * of nothing running — against, in the other reading, an application placed on
 * hardware it was explicitly kept off.
 *
 * EVERY READ THIS DOES IS BOUNDED BY ONE GATE, and the whole pass shares it. A
 * pass is a read per environment plus the reads that resolve it, and on a
 * hundred-millisecond store one after another that is seconds of latency in
 * front of every start. They are independent of each other, so
 * they overlap — but the bound is fleet-wide rather than per project or per
 * environment, because those nest and the product is what would reach the store.
 * What comes back does NOT depend on the order it came back in: results are
 * merged in listing order and a read that throws surfaces exactly as it did when
 * they ran one after another.
 */
export async function readDesired(
  registry: RegistryContext,
  opts: { nodeId: string; mode: PlacementReadMode; concurrency?: number },
): Promise<DesiredState> {
  const projects = await listProjects(registry);
  const gate = createConcurrencyGate(opts.concurrency);

  /* The projects themselves are not gated, and must not be: each one below waits
     on the gate, and a fan-out holding slots while its own work asks for them is
     the one way to deadlock this. Slots are taken at the reads alone. */
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

/**
 * Opens the varset an environment points at, or null when it points at none.
 *
 * Throws rather than answering null when the environment has one this node
 * cannot open — no key at all, the wrong key, or an envelope that will not
 * decrypt. A process started without the variables its environment is
 * configured with is a silent misconfiguration: it would serve requests against
 * whatever defaults its code falls back to. The caller records the failure
 * against that one environment and leaves whatever already serves it running.
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
  gate: ConcurrencyGate,
  requirePlacement: boolean,
): Promise<DesiredState> {
  /*
   * A BLOCKED PROJECT CONTRIBUTES NOTHING, and that emptiness is the whole
   * enforcement. An environment leaves by exactly the door a retired or a
   * reassigned one leaves by — it is absent from the desired state, so the next
   * pass's leftover sweep stops whatever still runs for it, and the routing,
   * which is rendered from what this node serves, stops naming its hosts. There
   * is no second mechanism, and nothing downstream of here knows what a block
   * is.
   *
   * It is read BEFORE the listings rather than beside them: a blocked project
   * costs one read and stops, which is what a fleet carrying a suspended tenant
   * should cost per pass. Absent reads as unblocked — a project deleted between
   * the listing and this read has no environments to find anyway.
   */
  if (await gate.run(() => isProjectBlocked(registry, project))) {
    return { environments: [], placements: [], failures: [] };
  }

  /* One listing of each kind for the whole project, rather than two reads per
     environment: only the environments that HAVE a decision cost a placement
     read at all. */
  const [names, placements] = await Promise.all([
    listEnvironments(registry, project),
    listPlacements(registry, project, { concurrency: gate }),
  ]);

  /* One environment at a time is one slot: the reads that resolve an environment
     depend on each other and stay in sequence, while the environments beside it
     do not and overlap. Each answers with its own part, merged below in the
     order the listing gave rather than the order the store answered in. */
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

  /* Read once and used for every question below: whether the environment
     constrains where it runs, what its placement view should report, and what
     there is to serve. */
  const found = await readJson<EnvironmentRecord>(registry, environmentKey(project, name));
  /* Deleted between the listing and the read: the next pass sees neither it nor
     its placement, and nothing here has to pretend it was there. */
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

/**
 * See {@link readDesired}. A decision, once there is one, is the whole answer.
 * Production callers select `"required"`; the explicit legacy mode retains the old
 * unconstrained fallback while nodes are upgraded one at a time.
 */
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

/**
 * Resolves whether an environment has a current celld deployment.
 *
 * The deployment notice is not treated that way and must not be: it says only
 * whether the environment has something to serve. A missing notice means there
 * is nothing to plan; a malformed one rejects the read rather than becoming a
 * runtime decision.
 *
 */
export function resolveEnvironmentDeployment(
  project: string,
  env: EnvironmentRecord,
): DesiredEnvironment | null {
  /*
   * On its way out: an environment an operator has retired is served nowhere,
   * from the next pass on. It still HAS a build — retirement is reversible, and
   * unretiring it must bring it straight back — so what stops it is this line
   * rather than anything having been taken away from it.
   *
   * LOAD-BEARING independently of placement. The coordinator DELETES the
   * placement record of a retired environment, but a production read already
   * treats that absence as pending. This check states the retirement contract
   * directly and also protects the explicit legacy rolling-upgrade reader from
   * bringing the environment back through its unconstrained fallback.
   */
  if (env.retiredAt !== undefined) return null;
  const revision = deploymentRevision(env);
  if (revision === null) return null;

  return {
    project,
    env,
    varsetId: env.varset,
  };
}
