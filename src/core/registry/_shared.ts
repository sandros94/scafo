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
