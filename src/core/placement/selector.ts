/*
 * WHICH nodes an application is allowed to run on, decided by the labels an
 * operator set on each node.
 *
 * This runs BEFORE `rendezvous.ts`, and the two answer different questions. This
 * one narrows the CANDIDATES to the nodes an application may use at all;
 * rendezvous then picks `replicas` of those. So the two compose rather than
 * compete — `replicas: "all"` under a selector means every MATCHING node — and
 * every property rendezvous has continues to hold, now within the eligible set:
 * the same eligible set always gives the same answer, and a node leaving that
 * set only moves the applications it was serving.
 *
 * Pure: nothing here reads the registry or knows what is live.
 */

import { ScafoError } from "../error.ts";
import type { NodeRecord, NodeSelector } from "../types/registry.ts";
import { assertLabels, formatLabels } from "../utils/labels.ts";

/**
 * Whether a node carrying `labels` satisfies `selector`.
 *
 * AND over exact values: every entry of the selector must be present in the
 * node's labels with that entry's value. A label the node carries and the
 * selector never mentions is ignored — a selector states requirements, not the
 * whole truth about a node.
 *
 * Both absences are unconstrained rather than unmatched: NO selector matches
 * every node, and an EMPTY selector requires nothing of one. A node with no
 * labels at all satisfies only those two.
 */
export function matchesSelector(
  labels: Record<string, string> | undefined,
  selector: NodeSelector | undefined,
): boolean {
  if (selector === undefined) return true;

  for (const [key, value] of Object.entries(selector)) {
    if (labels?.[key] !== value) return false;
  }
  return true;
}

/**
 * The nodes of `candidates` that may serve an application selecting `selector`,
 * in the order they arrived.
 *
 * An EMPTY answer is a real outcome — an operator selecting labels no live node
 * carries — and it is the caller's job never to write it down as a placement:
 * see the coordinator's assignment pass for why an application with no eligible
 * node keeps the placement it already had.
 */
export function eligibleNodes(candidates: NodeRecord[], selector?: NodeSelector): NodeRecord[] {
  if (selector === undefined) return [...candidates];
  return candidates.filter((record) => matchesSelector(record.labels, selector));
}

/**
 * Throws `ScafoError("invalid-input")` unless `value` is a usable selector: an
 * object whose every key and value is a label.
 *
 * An EMPTY selector is refused here even though {@link matchesSelector} reads
 * one as unconstrained. Storing `{}` and storing nothing would then be two
 * spellings of the same state, and an operator who meant to lift a constraint
 * must be able to see that they have — so lifting one is spelled `null`, and
 * `{}` is answered with that instruction rather than accepted as a no-op.
 */
export function assertSelector(value: unknown): asserts value is NodeSelector {
  assertLabels(value, "a node selector");

  if (Object.keys(value).length === 0) {
    throw new ScafoError("invalid-input", "Invalid node selector", {
      detail:
        `an empty node selector constrains nothing, which is not the same as storing one: ` +
        `clear the selector instead to let the application run on every node`,
    });
  }
}

/** How a selector reads in a refusal or on a terminal: `k=v,k2=v2`, keys sorted. */
export function describeSelector(selector: NodeSelector): string {
  return formatLabels(selector);
}
