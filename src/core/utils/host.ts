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

/**
 * Whether a listener bound to `host`, or an address advertised as `host`, stays
 * on the machine itself: `localhost`, anything in `127.0.0.0/8`, or the IPv6
 * loopback, written bare or bracketed.
 *
 * Everything else counts as reachable from elsewhere, including the wildcards
 * `0.0.0.0` and `::` — they bind every interface the machine has, loopback being
 * only one of them.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const address = bare.toLowerCase();

  if (address === "localhost" || address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return ipv4 !== null && Number(ipv4[1]) === 127;
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
