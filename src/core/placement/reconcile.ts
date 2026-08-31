/* Pure planning for one environment-owned runtime process per assigned node. */

import type { EnvironmentRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";

/** One environment as the registry wants it served. */
export interface DesiredEnvironment {
  project: string;
  env: EnvironmentRecord;
  varsetId?: string;
}

export interface PortView {
  nextPorts(): { public: number; internal: number };
}

export interface ReconcileInput {
  desired: DesiredEnvironment[];
  actual: RuntimeProcess[];
  ports: PortView;
}

export type ReconcileAction =
  | {
      type: "start";
      project: string;
      env: string;
      ports: { public: number; internal: number };
    }
  | {
      type: "restart";
      processId: string;
      project: string;
      env: string;
      ports: { public: number; internal: number };
    }
  | { type: "stop"; processId: string; reason: string };

/** Plans starts and configuration restarts before unrelated placement stops. */
export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const moves: ReconcileAction[] = [];
  const stops: ReconcileAction[] = [];
  const running = new Map(
    [...input.actual]
      .sort((a, b) => compare(a.processId, b.processId))
      .map((process) => [placementKey(process.project, process.env), process]),
  );
  const desired = [...input.desired].sort((a, b) =>
    compare(placementKey(a.project, a.env.name), placementKey(b.project, b.env.name)),
  );

  for (const wanted of desired) {
    const project = wanted.project;
    const env = wanted.env.name;
    if (wanted.env.deployment === null) continue;

    const key = placementKey(project, env);
    const process = running.get(key);
    running.delete(key);

    if (process === undefined) {
      moves.push({ type: "start", project, env, ports: input.ports.nextPorts() });
    } else if (process.teardownPending === true) {
      moves.push({
        type: "stop",
        processId: process.processId,
        reason: "runtime teardown is pending",
      });
    } else if (process.configuredVarset !== (wanted.varsetId ?? null)) {
      moves.push({
        type: "restart",
        processId: process.processId,
        project,
        env,
        ports:
          process.port > 0 && process.internalPort > 0
            ? { public: process.port, internal: process.internalPort }
            : input.ports.nextPorts(),
      });
    }
  }

  for (const key of [...running.keys()].sort(compare)) {
    const process = running.get(key) as RuntimeProcess;
    stops.push({
      type: "stop",
      processId: process.processId,
      reason: "environment is no longer served by this node",
    });
  }
  return [...moves, ...stops];
}

function placementKey(project: string, env: string): string {
  return `${project}/${env}`;
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
