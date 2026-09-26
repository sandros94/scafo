/*
 * How many nodes an application asks for, and what an application that never
 * said means.
 *
 * Pure: nothing here reads the registry or knows which nodes exist. Choosing
 * WHICH nodes is `rendezvous.ts`; this only answers HOW MANY.
 */

import { ScafoError } from "../error.ts";
import type { ApplicationRecord, ReplicaCount } from "../types/registry.ts";

/**
 * What an application gets when its record names no replica count.
 *
 * This default is what makes the whole feature invisible to an installation that
 * never asked for it: the application runs on every node that may serve it, and
 * a count is only ever a narrowing an operator asked for.
 */
export const DEFAULT_REPLICAS: ReplicaCount = "all";

/** The replica count an application record asks for, defaults resolved. */
export function resolveReplicas(application: ApplicationRecord): ReplicaCount {
  return application.replicas ?? DEFAULT_REPLICAS;
}

/**
 * Throws `ScafoError("invalid-input")` unless `value` is `"all"` or a whole
 * number of at least 1.
 *
 * Zero is refused rather than read as "run nowhere": an application nothing runs
 * is expressed by deleting it, and a caller that meant `1` and typed `0` would
 * otherwise take its own application off every node without a word.
 */
export function assertReplicas(value: unknown): asserts value is ReplicaCount {
  if (value === "all") return;
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return;

  throw new ScafoError("invalid-input", "Invalid replica count", {
    detail: `${describe(value)} must be "all" or a whole number of at least 1`,
  });
}

/**
 * Reads a replica count written as text — a command-line flag, a process
 * environment variable — into the value the registry stores. Refuses anything
 * else with `ScafoError("invalid-input")`, so a typo never becomes a placement
 * decision.
 */
export function parseReplicas(text: string): ReplicaCount {
  const trimmed = text.trim();
  if (trimmed === "all") return "all";

  /* Parsed strictly: `Number("2 nodes")` is NaN but `parseInt` would answer 2,
     and a flag that means something other than what it says is worse than one
     that is refused. Anything unusable is reported as the text it arrived as,
     which is what the caller can actually correct. */
  const count = Number(trimmed);
  if (trimmed === "" || !Number.isInteger(count) || count < 1) assertReplicas(trimmed);
  return count;
}

function describe(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}
