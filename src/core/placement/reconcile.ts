/*
 * Turns desired state — what the registry says each environment should serve —
 * into the actions that get this node there.
 *
 * Pure: every input is supplied by the caller, including the port pairs, so the
 * same inputs always plan the same actions in the same order.
 */

import type { BuildRecord, EnvironmentRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";

/** One build an environment should have a process for, and why. */
export interface DesiredBuild {
  build: BuildRecord;
  /**
   * `alias` for the environment's primary pointer, `split` for a weighted leg,
   * `recalled` for a superseded build a wake has brought back — one that takes
   * no share of the environment's own hosts and is reachable at its build-hash
   * host alone.
   */
  role: "alias" | "split" | "recalled";
}

/** One environment as the registry wants it served, with its builds resolved. */
export interface DesiredEnvironment {
  project: string;
  env: EnvironmentRecord;
  /**
   * Every build this environment needs a process for, in the order the registry
   * states them: WHILE THE ENVIRONMENT IS AWAKE the alias build FIRST — it stays
   * the primary pointer whether or not a split is active — then each split leg
   * the alias does not already name, then every recalled build.
   *
   * A PARKED EPHEMERAL ENVIRONMENT MAY BE DESIRED WITH RECALLED LEGS ALONE, and
   * therefore with no alias leg at all: its production host is deliberately not
   * served while it is parked, and only the woken builds' hash hosts are. So the
   * alias-first rule is a rule about an awake environment, not about the array.
   *
   * Recalled legs always come LAST, after the alias and split legs, so the legs
   * that carry the environment's own traffic are rolled out before the ones a
   * single request asked for.
   *
   * Never empty: an environment with neither a flipped alias nor a recalled
   * build has nothing to serve and is not desired at all.
   */
  builds: DesiredBuild[];
  /**
   * Build ids of legs whose record could not be read, when there are any.
   *
   * A leg nothing could be resolved for is still a leg the registry asked for,
   * so it counts as UNPROVEN and holds back the stops of its environment — see
   * {@link planReconcile}. It cannot be started, and the reader that failed to
   * resolve it records why.
   */
  unresolved?: string[];
  varsetId?: string;
}

/** Hands out the loopback port pair a new process listens on. */
export interface PortView {
  nextPorts(): { public: number; internal: number };
}

export interface ReconcileInput {
  desired: DesiredEnvironment[];
  /** Processes running on this node right now. */
  actual: RuntimeProcess[];
  ports: PortView;
}

/** One step towards desired state. */
export type ReconcileAction =
  /**
   * Bring one build into service: point the fleet at it, start a process, and
   * gate that process — as ONE indivisible, ordered step. See
   * {@link planReconcile} for why it may not be taken apart.
   */
  | {
      type: "rollout";
      project: string;
      env: string;
      build: string;
      ports: { public: number; internal: number };
    }
  | { type: "await-ready"; processId: string }
  | { type: "stop"; processId: string; reason: string };

/**
 * Plans this node's next move.
 *
 * THE FLEET POINTER IS ONE POINTER, AND A PROCESS READS IT ONCE — AT STARTUP.
 * An environment serving two builds at once (a traffic split) therefore needs
 * its activations and its starts STRICTLY PAIRED AND SEQUENCED, one build at a
 * time: activate A, start A, gate A, only then activate B. A plan that activated
 * every build first and started them afterwards would leave the pointer naming
 * whichever build was activated LAST, and every process started under it — all
 * of them, including the one meant to serve A — would load that one build. The
 * split would exist in the registry and in the routing, and both legs would run
 * the same code.
 *
 * That is what {@link ReconcileAction} `rollout` is: the pairing, expressed as a
 * single action the executor cannot interleave. A restart of a crashed leg goes
 * through the same action, so the pointer flips to that leg for the length of
 * its start and lands wherever the last rollout of the pass left it — which is
 * correct, because nothing reads it again until the next process starts. Single
 * build or twelve, an environment is rolled out the same way: one code path, and
 * no case where the phasing is only correct by accident. The same holds for a
 * RECALLED build, whose rollout can leave the pointer naming a build the alias
 * moved off long ago: safe for exactly that reason, and undone by the next
 * rollout, which re-activates whatever it is starting before it starts it.
 *
 * THE OTHER RULE, unchanged in substance and generalized in reach: a process
 * that still serves an environment is never planned for a stop until EVERY build
 * that environment is wanted at has a process that has passed its readiness
 * gate. Never reduce serving capacity while any desired leg is still proving
 * itself. A blue-green flip that stopped the old process first would drop every
 * request the new one cannot answer yet; a split that retired the outgoing build
 * before its incoming leg was ready would do the same to that leg's share.
 *
 * Actions come back in execution order: each environment's legs in registry
 * order (alias first, then the split as it is written), then every stop.
 */
export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const moves: ReconcileAction[] = [];
  const stops: ReconcileAction[] = [];

  const running = byEnvironment(input.actual);
  const desired = [...input.desired].sort((a, b) =>
    compare(placementKey(a.project, a.env.name), placementKey(b.project, b.env.name)),
  );

  for (const wanted of desired) {
    const project = wanted.project;
    const env = wanted.env.name;

    /* Taken out of the map as it is handled: what is left over at the end runs
       for an environment the registry no longer lists. */
    const key = placementKey(project, env);
    const processes = running.get(key) ?? [];
    running.delete(key);

    const legs = wanted.builds.map((entry) => entry.build.id);
    let proven = (wanted.unresolved ?? []).length === 0;

    for (const build of legs) {
      const serving = processes.filter((process) => process.build === build);

      if (serving.length === 0) {
        /* Nothing runs this build yet. Pointing the fleet at it and starting the
           process that loads it are one action, for the reason above. Anything
           serving another build keeps running until every leg is ready. */
        moves.push({ type: "rollout", project, env, build, ports: input.ports.nextPorts() });
        proven = false;
        continue;
      }

      if (!serving.some((process) => process.ready)) {
        /* The leg exists but has not proven itself. Gate it, and leave every
           other process alone for now. */
        for (const process of serving) {
          moves.push({ type: "await-ready", processId: process.processId });
        }
        proven = false;
      }
    }

    if (!proven) continue;

    /* Every build the environment is wanted at is served and ready: retire the
       rest. This is what completes a blue-green flip, a rollback, and the
       removal of a split leg alike. */
    for (const process of processes) {
      if (legs.includes(process.build)) continue;
      stops.push({ type: "stop", processId: process.processId, reason: supersededBy(legs) });
    }
  }

  for (const key of [...running.keys()].sort(compare)) {
    for (const process of running.get(key) ?? []) {
      stops.push({
        type: "stop",
        processId: process.processId,
        /* Two things reach here and the wording covers both: an environment that
           was undeployed, and one that is still deployed but has been placed on
           other nodes. The planner cannot tell them apart — desired state is
           already filtered to this node when it arrives — and claiming the first
           would send an operator looking for a deletion that never happened. */
        reason: "environment is no longer served by this node",
      });
    }
  }

  return [...moves, ...stops];
}

/** Why a process was retired, naming what serves its environment instead. */
function supersededBy(legs: string[]): string {
  const names = legs.map((build) => `"${build}"`).join(", ");
  return legs.length === 1 ? `superseded by build ${names}` : `superseded by builds ${names}`;
}

/** Groups running processes by the environment they serve, each group sorted by id. */
function byEnvironment(actual: RuntimeProcess[]): Map<string, RuntimeProcess[]> {
  const grouped = new Map<string, RuntimeProcess[]>();

  for (const process of [...actual].sort((a, b) => compare(a.processId, b.processId))) {
    const key = placementKey(process.project, process.env);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [process]);
    else group.push(process);
  }
  return grouped;
}

function placementKey(project: string, env: string): string {
  return `${project}/${env}`;
}

/* Code-unit ordering, so a plan does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
