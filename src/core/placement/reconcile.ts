/* Pure planning for one application-owned runtime process per assigned node. */

import type { ApplicationRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";

export interface ReconcileInput {
  /** Applications this node should serve, as their records stand. */
  desired: ApplicationRecord[];
  actual: RuntimeProcess[];
}

/**
 * What a pass does about one application.
 *
 * A START CARRIES NO PORTS. The ports an application is served on here belong to
 * that application for as long as this node knows it, and they are kept on disk
 * beside the rest of its local state — so they are read, probed and if need be
 * re-chosen by the runtime driver at the moment the process is started, not
 * handed out by whatever plans the pass.
 */
export type ReconcileAction =
  | { type: "start"; application: string }
  | { type: "stop"; application: string; reason: string };

/** Plans starts before unrelated placement stops. */
export function planReconcile(input: ReconcileInput): ReconcileAction[] {
  const moves: ReconcileAction[] = [];
  const stops: ReconcileAction[] = [];
  const running = new Map(
    [...input.actual]
      .sort((a, b) => compare(a.application, b.application))
      .map((process) => [process.application, process]),
  );
  const desired = [...input.desired].sort((a, b) => compare(a.name, b.name));

  for (const wanted of desired) {
    if (wanted.deployment === null) continue;

    const application = wanted.name;
    const process = running.get(application);
    running.delete(application);

    if (process === undefined) {
      moves.push({ type: "start", application });
    } else if (process.teardownPending === true) {
      moves.push({
        type: "stop",
        application,
        reason: "runtime teardown is pending",
      });
    }
  }

  for (const application of [...running.keys()].sort(compare)) {
    stops.push({
      type: "stop",
      application,
      reason: "application is no longer served by this node",
    });
  }
  return [...moves, ...stops];
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
