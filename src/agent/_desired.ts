/* Internal: what the registry says THIS node should be serving. */

import { isScafoError, ScafoError } from "../core/error.ts";
import type { DesiredBuild, DesiredEnvironment } from "../core/placement/reconcile.ts";
import { getBuild } from "../core/registry/builds.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { listEnvironments } from "../core/registry/environments.ts";
import { environmentKey } from "../core/registry/paths.ts";
import { type ResolvedParkPolicy, resolveParkPolicy } from "../core/registry/park.ts";
import { listPlacements } from "../core/registry/placement.ts";
import { listProjects } from "../core/registry/projects.ts";
import { getVarsetEnvelope, openVarset } from "../core/registry/varsets.ts";
import { listBuildWakes, readEnvironmentWake } from "../core/registry/wake.ts";
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

/**
 * One environment a node reads as PARKED, with the whole record rather than its
 * name: the routing claims the environment's hosts for the node's own agent, and
 * the wake surface resolves a request's Host back to it and reads the park
 * policy it is woken under. Neither can be done from a name.
 */
export interface ParkedEnvironment {
  project: string;
  env: EnvironmentRecord;
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
   * Environments this node reads as PARKED: ephemeral ones that have gone longer
   * without a wake than their park policy allows, whether or not a recalled build
   * still runs for them.
   *
   * Reported rather than merely left out of {@link DesiredState.environments},
   * because those two absences are the same absence to `/v1/state` and to an
   * operator otherwise: an environment nothing runs for because it was never
   * deployed looks exactly like one nothing runs for because it is waiting to be
   * woken, and only one of them is answered by sending it a request.
   *
   * Carries the whole record rather than the name — see {@link ParkedEnvironment}.
   */
  parked: ParkedEnvironment[];
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
 * A PARKED environment leaves by that same door and comes back through it: an
 * ephemeral one that has gone without a wake for longer than its policy allows
 * is desired for none of its own builds, and a wake makes it desired again on
 * the next pass. It is named in {@link DesiredState.parked} while it is, because
 * it is otherwise indistinguishable from an environment nothing was ever
 * deployed to.
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
 *
 * EVERY READ THIS DOES IS BOUNDED BY ONE GATE, and the whole pass shares it. A
 * pass is a read per environment plus the reads that resolve it, and on a
 * hundred-millisecond store one after another that is seconds of latency in
 * front of every wake and every rollout. They are independent of each other, so
 * they overlap — but the bound is fleet-wide rather than per project or per
 * environment, because those nest and the product is what would reach the store.
 * What comes back does NOT depend on the order it came back in: results are
 * merged in listing order and a read that throws surfaces exactly as it did when
 * they ran one after another.
 */
export async function readDesired(
  registry: RegistryContext,
  opts: { nodeId: string; concurrency?: number },
): Promise<DesiredState> {
  const projects = await listProjects(registry);
  const gate = createConcurrencyGate(opts.concurrency);

  /* The projects themselves are not gated, and must not be: each one below waits
     on the gate, and a fan-out holding slots while its own work asks for them is
     the one way to deadlock this. Slots are taken at the reads alone. */
  const perProject = await Promise.all(
    projects.map(async (project) => readProject(registry, project, opts.nodeId, gate)),
  );
  return {
    environments: perProject.flatMap((entry) => entry.environments),
    placements: perProject.flatMap((entry) => entry.placements),
    parked: perProject.flatMap((entry) => entry.parked),
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
  gate: ConcurrencyGate,
): Promise<DesiredState> {
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
    readEnvironment(registry, project, name, nodeId, placements.get(name)),
  );

  const state: DesiredState = { environments: [], placements: [], parked: [], failures: [] };
  for (const part of parts) {
    state.environments.push(...part.environments);
    state.placements.push(...part.placements);
    state.parked.push(...part.parked);
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
): Promise<DesiredState> {
  const state: DesiredState = { environments: [], placements: [], parked: [], failures: [] };

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
  if (!servedHere(placement, environment, nodeId)) return state;

  const wanted = await resolveEnvironment(registry, project, environment, state);
  if (wanted !== null) state.environments.push(wanted);
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
 * name, then every build a wake has recalled. Null when the environment has
 * nothing to serve at all.
 *
 * PARKED-NESS IS DERIVED HERE AND STORED NOWHERE. An ephemeral environment that
 * has gone longer than its policy allows without a wake is parked: none of its
 * alias or split builds are desired, so the next pass stops them and its own
 * hosts stop resolving with them. It is reported in {@link DesiredState.parked}
 * rather than merely dropped, and it is NOT undesired by that alone — a build
 * somebody woke keeps running at its build-hash host while the environment
 * around it stays parked, which is what recall is for.
 *
 * A RECALLED BUILD WHOSE RECORD IS GONE IS DROPPED SILENTLY, and this is the one
 * place that reads the opposite way to the split legs below. A build the reaper
 * has taken is a permanent 404 by design — the bucket is the source of truth and
 * nothing brings the record back — so there is nothing an operator could act on,
 * and the stamp that named it is the only thing left pointing at it. Recording
 * it in {@link DesiredEnvironment.unresolved} instead would count it as an
 * unproven leg and hold back every stop of that environment forever.
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
 *
 * ONE ENVIRONMENT'S READS RUN IN SEQUENCE, because each of them decides what the
 * next one is: whether the environment is parked decides whether its alias is
 * wanted at all, and a split leg or a recalled build is skipped when a build
 * already RESOLVED carries its id — a dependency on what came back, not merely
 * on the ids the record names. They are also few, while the environments beside
 * them are many, which is the axis {@link readDesired} overlaps instead.
 */
async function resolveEnvironment(
  registry: RegistryContext,
  project: string,
  env: EnvironmentRecord,
  state: DesiredState,
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

  const policy = resolveParkPolicy(env);
  const parked = policy.afterS > 0 && (await isParked(registry, project, env, policy.afterS));
  /* Reported only when there is something the clock is keeping stopped: an
     environment whose alias was never flipped serves nothing either way, and
     calling it parked would promise that a request wakes something. */
  if (parked && env.alias !== null) state.parked.push({ project, env });

  const builds: DesiredBuild[] = [];
  const unresolved: string[] = [];

  /* An alias that was never flipped is not an early exit: whether a build wake
     is honoured must not depend on the environment around it — recall works the
     same for a parked environment, an awake one, and one that has nothing of
     its own to serve yet. */
  const aliased = parked ? undefined : env.alias?.build;
  if (aliased !== undefined) {
    builds.push({ build: await getBuild(registry, project, aliased), role: "alias" });

    for (const entry of env.split ?? []) {
      if (builds.some((leg) => leg.build.id === entry.build)) continue;

      try {
        builds.push({ build: await getBuild(registry, project, entry.build), role: "split" });
      } catch (error) {
        if (!isScafoError(error) || error.code !== "not-found") throw error;
        unresolved.push(entry.build);
        state.failures.push({
          subject: `${project}/${env.name}`,
          detail:
            `build "${entry.build}" is a leg of this environment's traffic split but has no ` +
            `record in the registry, so it cannot be started; nothing this environment runs ` +
            `is stopped while a leg is unresolved`,
        });
      }
    }
  }

  await recalledBuilds(registry, project, env, policy, builds);
  if (builds.length === 0) return null;

  return {
    project,
    env,
    builds,
    ...(unresolved.length === 0 ? {} : { unresolved }),
    varsetId: env.varset,
  };
}

/**
 * Whether the environment has gone without a wake for longer than `afterS`.
 *
 * The base is its wake stamp, and the FALLBACK for one that has never been
 * stamped is the reaper's — the alias flip, then the creation — so an
 * environment deployed before there were stamps does not read as parked the
 * instant a node that knows about parking picks it up. A base that cannot be
 * read at all keeps the environment awake: nothing here should stop an
 * application over a timestamp it could not parse.
 */
async function isParked(
  registry: RegistryContext,
  project: string,
  env: EnvironmentRecord,
  afterS: number,
): Promise<boolean> {
  const woken = await readEnvironmentWake(registry, project, env.name);
  const since =
    woken === null ? Date.parse(env.alias?.flippedAt ?? env.createdAt) : woken.getTime();
  if (!Number.isFinite(since)) return false;

  return nowDate(registry).getTime() - since >= afterS * 1000;
}

/**
 * Appends the builds a wake has recalled: superseded ones stamped awake less
 * than `buildIdleS` ago, freshest first, minus whatever already has a leg.
 *
 * Appended LAST on purpose — a recalled build serves one caller at its own host,
 * while the alias and the split legs carry the environment's traffic, and the
 * planner rolls a build out in the order it is given.
 */
async function recalledBuilds(
  registry: RegistryContext,
  project: string,
  env: EnvironmentRecord,
  policy: ResolvedParkPolicy,
  builds: DesiredBuild[],
): Promise<void> {
  if (!policy.recallBuilds || policy.buildIdleS <= 0) return;

  const now = nowDate(registry).getTime();
  for (const [id, at] of await listBuildWakes(registry, project, env.name)) {
    if (now - at.getTime() >= policy.buildIdleS * 1000) continue;
    if (builds.some((leg) => leg.build.id === id)) continue;

    try {
      builds.push({ build: await getBuild(registry, project, id), role: "recalled" });
    } catch (error) {
      if (!isScafoError(error) || error.code !== "not-found") throw error;
      /* Reaped: a permanent 404 nobody can act on, so it is not a failure and
         not an unresolved leg — see {@link resolveEnvironment}. */
    }
  }
}
