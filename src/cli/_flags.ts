/*
 * Internal: how a flag carries more than one value, and how the flags a command
 * parsed reach the daemon configuration loader.
 *
 * ON THE COMMAND LINE A LIST IS A REPEATED FLAG. Each occurrence is one whole
 * value and NOTHING is split: a comma inside a value is part of the value, so a
 * subject, a variable value or a URL may hold one. The argument parser collects
 * the occurrences of a `multiple: true` flag into an array; a plain string is
 * the single value a flag declared without the modifier hands over.
 */

/** Every value a repeated flag names; blank entries and surrounding spaces are dropped. */
export function flagList(value: unknown): string[] {
  const given = Array.isArray(value) ? value : [value];
  return given
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * The declared flags that were actually given, in the shapes `loadDaemonConfig`
 * reads them: text for a scalar, an array for a repeated one.
 *
 * A switch reaches the loader as the text that loader accepts for one. Only a
 * flag the operator actually WROTE gets here — an unpassed boolean is undefined
 * rather than false, and an unpassed repeated flag is an empty array rather than
 * a stated empty list — so a `--flag` says on, a `--no-flag` says off, and a
 * flag nobody wrote leaves the process environment and the config file to answer.
 */
export function configFlags(
  flags: Record<string, unknown>,
): Record<string, string | string[] | undefined> {
  const given: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
    else if (typeof value === "boolean") given[name] = value ? "true" : "false";
    else if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string");
      if (entries.length > 0) given[name] = entries;
    }
  }
  return given;
}
