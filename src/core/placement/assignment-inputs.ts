/*
 * Everything an assignment pass decides from, reduced to one comparable value.
 *
 * WHY IT EXISTS. Rendezvous hashing is deterministic: the same applications over
 * the same live nodes produce the same placement, every time. A pass over
 * unchanged inputs therefore re-derives an answer it already has and writes
 * nothing — which costs nothing in the bucket but is still a listing and a read
 * of the whole installation on every coordinator tick, forever. Holding the
 * inputs against the last pass's is what lets the tick decide there is nothing
 * to decide.
 *
 * WHAT IT MUST CARRY is exactly what the decision reads: which applications
 * exist, how many replicas each asks for, which nodes each will accept, whether
 * it is out of service at all, the placements as they stand, and which nodes are
 * live. Anything the decision does not read — a deployment revision, a domain, a
 * label on the application — is left out, or every deploy in the installation
 * would re-run a pass that could only reach the same answer.
 */

import type { ApplicationRecord, PlacementRecord } from "../types/registry.ts";
import { stableStringify } from "../utils/json.ts";

export interface AssignmentInputs {
  applications: readonly ApplicationRecord[];
  placements: ReadonlyMap<string, PlacementRecord>;
  /** Ids of the nodes the pass would decide over, in any order. */
  live: readonly string[];
}

/**
 * A value that is equal exactly when two passes would decide the same thing.
 *
 * Order-independent: the applications and the live nodes are sorted, so a
 * listing that came back in another order is not a change.
 */
export function assignmentInputs(input: AssignmentInputs): string {
  const applications = [...input.applications]
    .map((record) => ({
      name: record.name,
      replicas: record.replicas ?? null,
      selector: record.nodeSelector ?? null,
      blocked: record.blocked === true,
      retired: record.retiredAt !== undefined,
      placement: input.placements.get(record.name) ?? null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  /* Placements of applications that no longer exist are what a pass DELETES, so
     they have to be in here too — the applications above never name them. */
  const orphans = [...input.placements.keys()]
    .filter((name) => !input.applications.some((record) => record.name === name))
    .sort();

  return stableStringify({
    applications,
    orphans,
    live: [...input.live].sort(),
  });
}
