/*
 * Turns desired state — what the registry says each environment should serve —
 * into the actions that get this node there.
 *
 * Pure: every input is supplied by the caller, including the port pairs, so the
 * same inputs always plan the same actions in the same order.
 */

import type { BuildRecord, EnvironmentRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";
import { formatProcessId } from "./ids.ts";

/** One environment as the registry wants it served, with its alias build resolved. */
export interface DesiredEnvironment {
  project: string;
  env: EnvironmentRecord;
  /** Build the environment's alias points at. */
  build: BuildRecord;
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
  | { type: "activate"; project: string; env: string; build: string }
  | {
      type: "start";
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
 * The one rule worth stating outright: a process that still serves an
 * environment is never planned for a stop until a replacement for that
 * environment is running AND has passed its readiness gate. A blue-green flip
 * that stopped the old process first would drop every request the new one
 * cannot answer yet, and a new process that never becomes ready would leave the
 * environment with nothing serving at all.
 *
 * Actions come back in execution order: activations, then starts, then the
 * readiness gates, then stops.
 */
export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const activations: ReconcileAction[] = [];
  const starts: ReconcileAction[] = [];
  const gates: ReconcileAction[] = [];
  const stops: ReconcileAction[] = [];

  const running = byEnvironment(input.actual);
  const desired = [...input.desired].sort((a, b) =>
    compare(placementKey(a.project, a.env.name), placementKey(b.project, b.env.name)),
  );

  for (const wanted of desired) {
    const project = wanted.project;
    const env = wanted.env.name;
    const build = wanted.build.id;

    /* Taken out of the map as it is handled: what is left over at the end runs
       for an environment the registry no longer lists. */
    const key = placementKey(project, env);
    const processes = running.get(key) ?? [];
    running.delete(key);

    const serving = processes.filter((process) => process.build === build);
    const superseded = processes.filter((process) => process.build !== build);

    if (serving.length === 0) {
      /* Nothing runs this build yet: point the fleet at it, then start a process
         that will load it. Anything serving an older build keeps running until
         the newcomer is ready. */
      activations.push({ type: "activate", project, env, build });
      starts.push({ type: "start", project, env, build, ports: input.ports.nextPorts() });
      gates.push({ type: "await-ready", processId: formatProcessId({ project, env, build }) });
      continue;
    }

    if (!serving.some((process) => process.ready)) {
      /* The replacement exists but has not proven itself. Gate it, and leave
         every other process alone for now. */
      for (const process of serving) {
        gates.push({ type: "await-ready", processId: process.processId });
      }
      continue;
    }

    /* The environment is served by the build it should be: retire the rest.
       This is what completes a blue-green flip, and equally a rollback. */
    for (const process of superseded) {
      stops.push({
        type: "stop",
        processId: process.processId,
        reason: `superseded by build "${build}"`,
      });
    }
  }

  for (const key of [...running.keys()].sort(compare)) {
    for (const process of running.get(key) ?? []) {
      stops.push({
        type: "stop",
        processId: process.processId,
        reason: "environment is no longer deployed",
      });
    }
  }

  return [...activations, ...starts, ...gates, ...stops];
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
