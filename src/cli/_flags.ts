/*
 * Internal: the one way a flag carries more than one value.
 *
 * COMMA-SEPARATED, in a single flag. Repeating the flag would read more
 * naturally, but the argument parser keeps only the last occurrence of one — so
 * a command that read a repeated flag would act on one of the several things an
 * operator listed and say nothing about the rest. Every list-valued flag is
 * written the same way, and every one of them says so in its own description.
 *
 * An array is accepted all the same, so that a parser which one day hands the
 * repeats over is honoured rather than silently truncated.
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
