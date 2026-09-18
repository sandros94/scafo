/*
 * Internal: the one way a flag carries more than one value without repeating.
 *
 * COMMA-SEPARATED, in a single flag. Every list-valued flag is written the same
 * way, and every one of them says so in its own description. A flag whose values
 * may contain a comma is declared `multiple: true` instead and repeated, which
 * the argument parser collects into an array on its own.
 *
 * An array is accepted here all the same, so that a repeated flag reaching a
 * comma-separated one is honoured rather than silently truncated.
 */

/** Every value a list-valued flag names; blank entries and surrounding spaces are dropped. */
export function flagList(value: unknown): string[] {
  const given = Array.isArray(value) ? value : [value];
  return given
    .filter((entry): entry is string => typeof entry === "string")
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
