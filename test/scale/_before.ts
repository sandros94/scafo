/*
 * What every periodic pass cost the bucket BEFORE the registry view, the change
 * hint and the cached sweep — as exact formulas of the installation's size.
 *
 * FROZEN NUMBERS, NOT MEASURED ONES. Nothing here drives any code: these are the
 * formulas the characterization suite asserted against the build that read the
 * whole installation on every pass, captured so the report can put the two
 * columns side by side and so nobody has to take "much cheaper" on trust.
 *
 * They are quoted in the report and nowhere else. The BUDGETS the code is held
 * to live in `baseline.test.ts`, where a regression fails CI.
 */

import { LIST_PAGE_KEYS } from "./_meter.ts";

/** What one pass cost, in the units a bill is written in. */
export interface PastCost {
  gets: number;
  listPages: number;
  puts: number;
}

/** The shape of an installation every formula below is a function of. */
export interface PastShape {
  /** Applications. */
  applications: number;
  /** Nodes. */
  nodes: number;
  /** Deploy records per application, inside their retention. */
  deployRecords: number;
}

/** Requests one listing of `keys` keys costs, a thousand keys to the page. */
export function pages(keys: number): number {
  return Math.max(1, Math.ceil(keys / LIST_PAGE_KEYS));
}

/** The cadences the loops ran at before. */
export const PAST_CADENCES = {
  /** Unchanged; it is what "a change is seen within one interval" means. */
  reconcileIntervalMs: 5000,
  /** Unchanged: a node says it is still there on its own clock. */
  heartbeatIntervalMs: 30_000,
  /** A 15s lease, renewed at a third of it. */
  coordinatorTickMs: 5000,
  reapIntervalMs: 60_000,
} as const;

/** Deploys one node admitted at once before; every one past that was refused. */
export const PAST_QUEUED_TASKS: number = 4;

/** One reconcile pass: both listings, then every application and every node. */
export function pastReconcilePass(shape: PastShape): PastCost {
  return {
    gets: 2 * shape.applications + shape.nodes,
    listPages: 2 * pages(shape.applications) + pages(shape.nodes),
    puts: 0,
  };
}

/** One assignment pass: the same reads again, from the coordinator's side. */
export function pastAssignPass(shape: PastShape): PastCost {
  return {
    gets: 2 * shape.applications + shape.nodes,
    listPages: pages(shape.nodes) + 2 * pages(shape.applications),
    puts: 0,
  };
}

/** One reap pass: the applications, then a listing and a read PER application. */
export function pastReapPass(shape: PastShape): PastCost {
  return {
    gets: shape.applications + shape.applications * shape.deployRecords,
    listPages: pages(shape.applications) + shape.applications * pages(shape.deployRecords),
    puts: 0,
  };
}

/** One heartbeat: the read-modify-write of this node's own record. */
export function pastHeartbeat(): PastCost {
  return { gets: 1, listPages: 0, puts: 1 };
}

/** What one minute of an idle installation of `shape` cost the bucket. */
export function pastIdleCost(shape: PastShape): { classA: number; classB: number } {
  const perMinute = (intervalMs: number): number => 60_000 / intervalMs;
  const classA = (cost: PastCost): number => cost.puts + cost.listPages;
  const classB = (cost: PastCost): number => cost.gets;

  const reconcile = pastReconcilePass(shape);
  const beat = pastHeartbeat();
  const assign = pastAssignPass(shape);
  const reap = pastReapPass(shape);

  const node =
    perMinute(PAST_CADENCES.reconcileIntervalMs) * classA(reconcile) +
    perMinute(PAST_CADENCES.heartbeatIntervalMs) * classA(beat);
  const nodeReads =
    perMinute(PAST_CADENCES.reconcileIntervalMs) * classB(reconcile) +
    perMinute(PAST_CADENCES.heartbeatIntervalMs) * classB(beat);
  /* The lease renewal is the one write a coordinator tick made on its own. */
  const coordinator =
    perMinute(PAST_CADENCES.coordinatorTickMs) * (classA(assign) + 1) +
    perMinute(PAST_CADENCES.reapIntervalMs) * classA(reap);
  const coordinatorReads =
    perMinute(PAST_CADENCES.coordinatorTickMs) * classB(assign) +
    perMinute(PAST_CADENCES.reapIntervalMs) * classB(reap);

  return {
    classA: node * shape.nodes + coordinator,
    classB: nodeReads * shape.nodes + coordinatorReads,
  };
}
