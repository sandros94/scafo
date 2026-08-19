/* Helpers shared by the registry modules; not part of the public surface. */

import { isScaloError } from "../error.ts";
import { stableStringify } from "../utils/json.ts";

export function isCasConflict(err: unknown): boolean {
  return isScaloError(err) && err.code === "cas-conflict";
}

export function isNotFound(err: unknown): boolean {
  return isScaloError(err) && err.code === "not-found";
}

/** Structural equality by deterministic serialization; key order is irrelevant. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/**
 * A duration as a refusal should say it: the largest unit that still reads as a
 * number, because "86400s" tells an operator less about how long to wait than
 * "24h" does.
 *
 * Days only from two of them up. A message often names a remaining time and the
 * window it came out of in one breath — "23.9h of its 24h grace remains" — and a
 * threshold at exactly one day makes those two land in different units either
 * side of a rounding boundary, so the same duration reads as "24h" in one half
 * of the sentence and "1d" in the other.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  if (seconds < 3600) return `${String(Math.round(seconds / 60))}m`;
  if (seconds < 172_800) return `${String(Math.round(seconds / 360) / 10)}h`;
  return `${String(Math.round(seconds / 8640) / 10)}d`;
}

/** Names of the `<prefix><name>.json` keys in `keys`, skipping nested ones. */
export function namesFromKeys(keys: string[], prefix: string): string[] {
  const names: string[] = [];
  for (const key of keys) {
    if (!key.startsWith(prefix) || !key.endsWith(".json")) continue;
    const name = key.slice(prefix.length, -".json".length);
    if (name.length > 0 && !name.includes("/")) names.push(name);
  }
  return names;
}
