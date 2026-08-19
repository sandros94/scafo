import { ScaloError } from "../error.ts";

/**
 * A single DNS label: lowercase alphanumerics and inner hyphens, at most 63
 * characters. Uppercase is rejected outright — hosts are stored normalized.
 */
export const HOST_LABEL_RE: RegExp = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

/** DNS name limit, counting the dots between labels. */
export const HOST_MAX_LENGTH: number = 253;

/**
 * Lowercase DNS name of one or more dot-separated labels. Single-label names are
 * allowed so internal hosts work; a trailing dot is not.
 */
export function isHost(s: string): boolean {
  if (s.length === 0 || s.length > HOST_MAX_LENGTH) return false;
  return s.split(".").every((label) => HOST_LABEL_RE.test(label));
}

/** Throws `ScaloError("invalid-slug")` when `s` is not a valid host. */
export function assertHost(s: string): void {
  if (!isHost(s)) {
    throw new ScaloError("invalid-slug", "Invalid host", {
      detail:
        `"${s}" must be a lowercase DNS name of up to ${HOST_MAX_LENGTH} characters, ` +
        `each dot-separated label 1-63 alphanumerics optionally containing hyphens`,
    });
  }
}
