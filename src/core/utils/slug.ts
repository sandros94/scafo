import { ScaloError } from "../error.ts";

/**
 * Lowercase alphanumeric segments joined by single hyphens: no leading or
 * trailing hyphen, and never two hyphens in a row. The `--` separator used by
 * host labels is therefore unambiguous.
 */
export const SLUG_RE: RegExp = /^[a-z\d]+(?:-[a-z\d]+)*$/;

/** DNS label limit; host labels built from slugs must also fit within it. */
export const SLUG_MAX_LENGTH: number = 63;

export function isSlug(s: string): boolean {
  return s.length > 0 && s.length <= SLUG_MAX_LENGTH && SLUG_RE.test(s);
}

/** Throws `ScaloError("invalid-slug")` when `s` is not a valid slug. */
export function assertSlug(s: string): void {
  if (!isSlug(s)) {
    throw new ScaloError("invalid-slug", "Invalid slug", {
      detail:
        `"${s}" must be 1-${SLUG_MAX_LENGTH} lowercase alphanumeric characters, ` +
        `optionally separated by single hyphens`,
    });
  }
}

/**
 * Builds the host label for a project, optionally scoped to a ref:
 * `project` or `project--ref`. Both parts must be valid slugs and the combined
 * label must stay within {@link SLUG_MAX_LENGTH}.
 */
export function formatHostLabel(project: string, ref?: string): string {
  assertSlug(project);
  if (ref === undefined) return project;

  assertSlug(ref);
  const label = `${project}--${ref}`;
  if (label.length > SLUG_MAX_LENGTH) {
    throw new ScaloError("invalid-slug", "Host label too long", {
      detail: `"${label}" is ${label.length} characters, the limit is ${SLUG_MAX_LENGTH}`,
    });
  }
  return label;
}

/** Inverse of {@link formatHostLabel}; returns null when `label` is not one. */
export function parseHostLabel(label: string): { project: string; ref?: string } | null {
  if (label.length > SLUG_MAX_LENGTH) return null;

  const segments = label.split("--");
  if (segments.length > 2) return null;
  for (const segment of segments) {
    if (!isSlug(segment)) return null;
  }

  return segments.length === 2
    ? { project: segments[0], ref: segments[1] }
    : { project: segments[0] };
}
