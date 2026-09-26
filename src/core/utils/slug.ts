import { ScafoError } from "../error.ts";

/**
 * Lowercase alphanumeric segments joined by single hyphens: no leading or
 * trailing hyphen, and never two hyphens in a row. It is the rule an
 * application's name follows, and the same one Celld applies to a config's
 * `name`.
 */
export const SLUG_RE: RegExp = /^[a-z\d]+(?:-[a-z\d]+)*$/;

/** DNS label limit; an application is served at its name under a platform domain. */
export const SLUG_MAX_LENGTH: number = 63;

export function isSlug(s: string): boolean {
  return s.length > 0 && s.length <= SLUG_MAX_LENGTH && SLUG_RE.test(s);
}

/** Throws `ScafoError("invalid-slug")` when `s` is not a valid slug. */
export function assertSlug(s: string): void {
  if (!isSlug(s)) {
    throw new ScafoError("invalid-slug", "Invalid slug", {
      detail:
        `"${s}" must be 1-${SLUG_MAX_LENGTH} lowercase alphanumeric characters, ` +
        `optionally separated by single hyphens`,
    });
  }
}
