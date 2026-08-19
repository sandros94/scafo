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

/** An interface address written with its prefix length, the way `ip addr` takes one. */
export interface InterfaceAddress {
  /** The address on its own, with the prefix stripped: `10.83.0.1`. */
  host: string;
  /** Prefix length as written: the size of the subnet the interface is on. */
  prefix: number;
  /**
   * Prefix length that addresses this one host and nothing else — 32 for IPv4,
   * 128 for IPv6. What a peer's `AllowedIPs` is written with, so one node's
   * route never covers another's.
   */
  hostPrefix: number;
}

/**
 * Reads `10.83.0.1/24` (or an IPv6 equivalent) into its parts, or null when it
 * is not one. Callers word their own refusal, because only they know which
 * setting carried the value.
 *
 * The address itself is checked for shape, not for reachability: whether an
 * interface can actually hold it is the operator's business and the kernel's.
 * The two shapes that are refused are the ones no interface could ever hold and
 * that nothing could ever be routed to on their own — a wildcard (`0.0.0.0`,
 * `::`), and a prefix of `0`, which is every address there is.
 */
export function parseInterfaceAddress(value: string): InterfaceAddress | null {
  const slash = value.lastIndexOf("/");
  if (slash < 1 || slash === value.length - 1) return null;

  const host = value.slice(0, slash);
  const written = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(written)) return null;
  const prefix = Number(written);
  if (prefix === 0 || host === "0.0.0.0" || host === "::") return null;

  const hostPrefix = isIpv4(host) ? 32 : isIpv6(host) ? 128 : 0;
  if (hostPrefix === 0 || prefix > hostPrefix) return null;
  return { host, prefix, hostPrefix };
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

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Loose on purpose: an address counts as IPv6 when it carries a colon and holds
 * nothing but hex digits, colons and at most one embedded IPv4 tail. Deciding
 * whether every elision is legal is the kernel's job, and a shape that gets
 * through here fails the moment `wg-quick` reads the file rather than silently.
 */
function isIpv6(value: string): boolean {
  if (!value.includes(":") || value.split(":").length > 8) return false;
  return /^[\da-f]{0,4}(?::[\da-f]{0,4})+(?::\d{1,3}(?:\.\d{1,3}){3})?$/i.test(value);
}
