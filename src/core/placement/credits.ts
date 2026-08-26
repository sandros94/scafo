/* Capacity-aware placement over the existing selector and rendezvous rules. */

import { accountCredits, type CreditAccount, type CreditReservation } from "../capacity/credits.ts";
import { ScafoError } from "../error.ts";
import { NODE_ID_RE } from "../registry/paths.ts";
import type { NodeSelector, ReplicaCount } from "../types/registry.ts";
import { assertLabels } from "../utils/labels.ts";
import { assertPositiveSafeInteger } from "../utils/number.ts";
import { isSlug } from "../utils/slug.ts";
import { assignNodes } from "./rendezvous.ts";
import { assertReplicas } from "./replicas.ts";
import { assertSelector, matchesSelector } from "./selector.ts";

/** One live node, including an explicit statement when its local credit profile is unavailable. */
export interface CreditPlacementNode {
  id: string;
  labels?: Record<string, string>;
  /** Null is live but cannot receive new placement until it advertises a valid profile. */
  profile: {
    allocatableMb: number;
    /** Runtime credit charged for every process this node is asked to serve. */
    runtimeMb: number;
  } | null;
}

/** One environment/build demand, its desired replica count and last placement. */
export interface CreditPlacementWorkload {
  project: string;
  env: string;
  replicas: ReplicaCount;
  /** Processes each selected node must keep for this environment (alias, split and recalls). */
  processes: number;
  selector?: NodeSelector;
  /** Last committed node ids. Preserved in the same order if this proposal cannot fit. */
  current: string[];
}

/** Why a placement proposal is pending instead of replacing its last placement. */
export type CreditPlacementFailureReason =
  | "over-capacity"
  | "insufficient-capacity"
  | "insufficient-candidates"
  | "profile-unavailable";

/** Ordinary capacity failure data, safe for later state/API rendering without parsing text. */
export interface CreditPlacementPending {
  reason: CreditPlacementFailureReason;
  requiredReplicas: number | "all";
  eligibleNodes: number;
  capacityNodes: number;
}

/** The result for one target. A pending result retains the exact `current` array. */
export interface CreditPlacement {
  target: string;
  nodes: string[];
  pending?: CreditPlacementPending;
}

/** The deterministic output of a credit-aware coordinator placement pass. */
export interface CreditPlacementPlan {
  placements: CreditPlacement[];
  /** Per-node present and post-transition accounts, so neither demand is inferred from text. */
  accounts: CreditPlacementAccount[];
  /** Existing placement was already beyond total or protected steady capacity. */
  overcommitted: boolean;
}

/** One node's current actual-union-desired and eventual steady credit states. */
export interface CreditPlacementAccount {
  id: string;
  transient: CreditAccount;
  steady: CreditAccount;
}

/** Inputs to {@link planCreditPlacement}. Collections are treated as unordered. */
export interface CreditPlacementInput {
  nodes: CreditPlacementNode[];
  workloads: CreditPlacementWorkload[];
}

/**
 * Plans exact, capacity-aware placements without mutating the registry.
 *
 * Current reservations are charged before every proposal. A successful move
 * reserves actual union desired runtime until the old process can stop; a
 * failed proposal returns ordinary data and leaves its prior array untouched.
 */
export async function planCreditPlacement(
  input: CreditPlacementInput,
): Promise<CreditPlacementPlan> {
  if (typeof input !== "object" || input === null) {
    throw new ScafoError("invalid-input", "Invalid placement input", {
      detail: `a placement input must be an object`,
    });
  }
  const nodes = validateNodes(input.nodes);
  const workloads = validateWorkloads(input.workloads);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const current = new Map<string, number>();
  const future = new Map<string, number>();
  const transition = new Map<string, number>();

  for (const node of nodes) {
    current.set(node.id, 0);
    future.set(node.id, 0);
    transition.set(node.id, 0);
  }
  for (const workload of workloads) {
    for (const id of workload.current) {
      const node = nodeById.get(id);
      if (node?.profile === undefined || node.profile === null) continue;
      change(current, id, demand(node, workload));
      change(future, id, demand(node, workload));
    }
  }

  const existing = accounts(nodes, current, transition, future);
  const existingById = new Map(existing.map((account) => [account.id, account]));
  const overcommitted = existing.some(
    (account) => !account.transient.fits || !account.steady.steadyFits,
  );
  const placements: CreditPlacement[] = [];

  for (const workload of workloads) {
    const currentIds = new Set(workload.current);
    const currentOverCapacity = workload.current.some((id) => {
      const account = existingById.get(id);
      return account !== undefined && (!account.transient.fits || !account.steady.steadyFits);
    });

    const eligible = nodes.filter((node) => matchesSelector(node.labels, workload.selector));
    const capacity = eligible.filter(hasProfile);
    const currentUnavailable = workload.current.some((id) => nodeById.get(id)?.profile === null);
    const viable = capacity.filter((node) =>
      canPlace(node, workload, currentIds, current, future, transition),
    );
    const candidates = workload.replicas === "all" ? capacity : viable;
    const wanted = workload.replicas === "all" ? eligible.length : workload.replicas;

    if (eligible.length === 0 || eligible.length < wanted) {
      placements.push(pending(workload, "insufficient-candidates", eligible.length, viable.length));
      continue;
    }
    if (currentUnavailable) {
      placements.push(pending(workload, "profile-unavailable", eligible.length, viable.length));
      continue;
    }
    if (viable.length < wanted || capacity.length < wanted) {
      placements.push(
        pending(
          workload,
          currentOverCapacity ? "over-capacity" : "insufficient-capacity",
          eligible.length,
          viable.length,
        ),
      );
      continue;
    }

    const selected = await assignNodes({
      project: workload.project,
      env: workload.env,
      nodes: candidates.map((node) => node.id),
      replicas: workload.replicas,
    });
    /* `assignNodes` clamps numeric counts; the pre-check above makes that impossible here. */
    if (selected.length !== wanted) {
      placements.push(pending(workload, "insufficient-candidates", eligible.length, viable.length));
      continue;
    }

    if (sameNodes(workload.current, selected)) {
      placements.push({ target: target(workload), nodes: [...workload.current] });
      continue;
    }

    apply(workload, currentIds, new Set(selected), nodeById, future, transition);
    placements.push({ target: target(workload), nodes: selected });
  }

  return { placements, accounts: accounts(nodes, current, transition, future), overcommitted };
}

function validateNodes(input: CreditPlacementNode[]): CreditPlacementNode[] {
  if (!Array.isArray(input)) {
    throw new ScafoError("invalid-input", "Invalid placement nodes", {
      detail: `"nodes" must be an array`,
    });
  }
  for (const node of input) {
    if (typeof node !== "object" || node === null) {
      throw new ScafoError("invalid-input", "Invalid placement node", {
        detail: `every "nodes" entry must be an object`,
      });
    }
  }
  const seen = new Set<string>();
  for (const node of input) {
    if (typeof node.id !== "string" || !NODE_ID_RE.test(node.id)) {
      throw new ScafoError("invalid-input", "Invalid placement node", {
        detail: `"node.id" must match the registry node-id contract`,
      });
    }
    if (seen.has(node.id)) {
      throw new ScafoError("invalid-input", "Duplicate placement node", {
        detail: `"${node.id}" appears more than once in one placement input`,
      });
    }
    seen.add(node.id);
    if (node.labels !== undefined) assertLabels(node.labels, `labels for "${node.id}"`);
    if (node.profile !== null && (typeof node.profile !== "object" || node.profile === null)) {
      throw new ScafoError("invalid-input", "Invalid placement node", {
        detail: `"node.profile" must be an object or null`,
      });
    }
    if (node.profile !== null) {
      accountCredits({
        allocatableMb: node.profile.allocatableMb,
        surgeMb: node.profile.runtimeMb,
      });
    }
  }
  return [...input].sort((left, right) => compare(left.id, right.id));
}

function validateWorkloads(input: CreditPlacementWorkload[]): CreditPlacementWorkload[] {
  if (!Array.isArray(input)) {
    throw new ScafoError("invalid-input", "Invalid placement workloads", {
      detail: `"workloads" must be an array`,
    });
  }
  for (const workload of input) {
    if (typeof workload !== "object" || workload === null) {
      throw new ScafoError("invalid-input", "Invalid placement workload", {
        detail: `every "workloads" entry must be an object`,
      });
    }
  }
  const seen = new Set<string>();
  for (const workload of input) {
    if (
      typeof workload.project !== "string" ||
      !isSlug(workload.project) ||
      typeof workload.env !== "string" ||
      !isSlug(workload.env)
    ) {
      throw new ScafoError("invalid-input", "Invalid placement workload", {
        detail: `"project" and "env" must match the registry slug contract`,
      });
    }
    const name = target(workload);
    if (seen.has(name)) {
      throw new ScafoError("invalid-input", "Duplicate placement workload", {
        detail: `"${name}" appears more than once in one placement input`,
      });
    }
    seen.add(name);
    assertReplicas(workload.replicas);
    if (workload.replicas !== "all") assertPositiveSafeInteger(workload.replicas, "replicas");
    if (!Number.isSafeInteger(workload.processes) || workload.processes < 0) {
      throw new ScafoError("invalid-input", "Invalid placement processes", {
        detail: `"processes" must be a non-negative safe integer`,
      });
    }
    if (workload.selector !== undefined) assertSelector(workload.selector);
    if (!Array.isArray(workload.current)) {
      throw new ScafoError("invalid-input", "Invalid current placement", {
        detail: `"current" must be an array of unique non-empty node ids`,
      });
    }
    const current = new Set<string>();
    for (const id of workload.current) {
      if (typeof id !== "string" || !NODE_ID_RE.test(id) || current.has(id)) {
        throw new ScafoError("invalid-input", "Invalid current placement", {
          detail: `"current" must contain unique registry node ids`,
        });
      }
      current.add(id);
    }
  }
  return [...input].sort((left, right) => compare(target(left), target(right)));
}

function canPlace(
  node: CreditPlacementNode,
  workload: CreditPlacementWorkload,
  currentIds: ReadonlySet<string>,
  current: Map<string, number>,
  future: Map<string, number>,
  transition: Map<string, number>,
): boolean {
  if (node.profile === null) return false;
  const { allocatableMb, runtimeMb } = node.profile;
  const mb = demand(node, workload);
  const hasCurrent = currentIds.has(node.id);
  const nextTransition = add(transition.get(node.id) ?? 0, hasCurrent ? 0 : mb);
  const nextFuture = add(future.get(node.id) ?? 0, hasCurrent ? 0 : mb);

  const transient = accountCredits({
    allocatableMb,
    surgeMb: runtimeMb,
    runtime: aggregate(node.id, "runtime", current.get(node.id) ?? 0),
    transition: aggregate(node.id, "transition", nextTransition),
  });
  const steady = accountCredits({
    allocatableMb,
    surgeMb: runtimeMb,
    runtime: aggregate(node.id, "steady", nextFuture),
  });
  return transient.fits && steady.steadyFits;
}

function hasProfile(
  node: CreditPlacementNode,
): node is CreditPlacementNode & { profile: NonNullable<CreditPlacementNode["profile"]> } {
  return node.profile !== null;
}

function apply(
  workload: CreditPlacementWorkload,
  currentIds: ReadonlySet<string>,
  selected: ReadonlySet<string>,
  nodes: ReadonlyMap<string, CreditPlacementNode>,
  future: Map<string, number>,
  transition: Map<string, number>,
): void {
  for (const id of workload.current) {
    if (!future.has(id) || selected.has(id)) continue;
    const node = nodes.get(id);
    if (node?.profile === undefined || node.profile === null) continue;
    change(future, id, -demand(node, workload));
  }
  for (const id of selected) {
    if (currentIds.has(id)) continue;
    const node = nodes.get(id);
    if (node?.profile === undefined || node.profile === null) continue;
    change(future, id, demand(node, workload));
    change(transition, id, demand(node, workload));
  }
}

function accounts(
  nodes: CreditPlacementNode[],
  current: Map<string, number>,
  transition: Map<string, number>,
  future: Map<string, number>,
): CreditPlacementAccount[] {
  return nodes.filter(hasProfile).map((node) => ({
    id: node.id,
    transient: accountCredits({
      allocatableMb: node.profile.allocatableMb,
      surgeMb: node.profile.runtimeMb,
      runtime: aggregate(node.id, "runtime", current.get(node.id) ?? 0),
      transition: aggregate(node.id, "transition", transition.get(node.id) ?? 0),
    }),
    steady: accountCredits({
      allocatableMb: node.profile.allocatableMb,
      surgeMb: node.profile.runtimeMb,
      runtime: aggregate(node.id, "steady", future.get(node.id) ?? 0),
    }),
  }));
}

function aggregate(id: string, kind: string, mb: number): CreditReservation[] {
  return mb === 0 ? [] : [{ target: `${id}/${kind}`, mb }];
}

function change(credits: Map<string, number>, id: string, delta: number): void {
  const next = add(credits.get(id) ?? 0, delta);
  if (next < 0) {
    throw new ScafoError("invalid-input", "Invalid credit transition", {
      detail: `credit demand for "${id}" cannot fall below zero`,
    });
  }
  credits.set(id, next);
}

function add(left: number, right: number): number {
  const total = left + right;
  if (Number.isSafeInteger(total)) return total;
  throw new ScafoError("invalid-input", "Credit arithmetic overflow", {
    detail: `placement credit demand exceeds the largest safe integer MiB value`,
  });
}

function demand(node: CreditPlacementNode, workload: CreditPlacementWorkload): number {
  if (node.profile === null) return 0;
  const total = node.profile.runtimeMb * workload.processes;
  if (Number.isSafeInteger(total)) return total;
  throw new ScafoError("invalid-input", "Credit arithmetic overflow", {
    detail: `placement runtime demand exceeds the largest safe integer MiB value`,
  });
}

function pending(
  workload: CreditPlacementWorkload,
  reason: CreditPlacementFailureReason,
  eligibleNodes: number,
  capacityNodes: number,
): CreditPlacement {
  return {
    target: target(workload),
    nodes: [...workload.current],
    pending: { reason, requiredReplicas: workload.replicas, eligibleNodes, capacityNodes },
  };
}

function target(workload: CreditPlacementWorkload): string {
  return `${workload.project}/${workload.env}`;
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sameNodes(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left);
  return ids.size === left.length && right.every((id) => ids.has(id));
}
