import { ScafoError } from "../error.ts";

/**
 * A single DNS label: lowercase alphanumerics and inner hyphens, at most 63
 * characters. Uppercase is rejected outright — hosts are stored normalized.
 */
export const HOST_LABEL_RE: RegExp = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/;

/** DNS name limit, counting the dots between labels. */
export const HOST_MAX_LENGTH: number = 253;

/** DNS label limit, which is also the length an application's name is held to. */
export const HOST_LABEL_MAX_LENGTH: number = 63;

/**
 * Lowercase DNS name of one or more dot-separated labels. Single-label names are
 * allowed so internal hosts work; a trailing dot is not.
 */
export function isHost(s: string): boolean {
  if (s.length === 0 || s.length > HOST_MAX_LENGTH) return false;
  return s.split(".").every((label) => HOST_LABEL_RE.test(label));
}

/**
 * A host an application may claim, lowercased and checked against the rule a
 * claim is held to.
 *
 * LOWERCASING IS THE ONLY NORMALISATION. DNS is case-insensitive, so
 * `Shop.Example.COM` and `shop.example.com` are one name and the registry keeps
 * one spelling of it; everything else is refused rather than repaired, with
 * `invalid-input` naming the rule that failed — an operator who pasted a URL, a
 * port or a wildcard needs to read which part of it is not a host.
 *
 * It is stricter than {@link isHost}, which admits the single-label names an
 * internal listener carries: a claimed host is FULLY QUALIFIED, and its last
 * label is not all digits, so an IPv4 literal — a name no certificate authority
 * issues for — is never taken for one. `xn--` punycode labels are ordinary
 * labels and pass.
 */
export function normalizeCustomDomain(host: string): string {
  const name = host.toLowerCase();

  if (name === "") throw badHost(host, "it is empty");
  if (name.includes("://") || name.includes("/")) {
    throw badHost(host, "a host carries no scheme and no path");
  }
  if (name.includes("*")) throw badHost(host, "a host carries no wildcard");
  if (name.includes(":")) {
    throw badHost(host, "a host carries no port, and an IPv6 literal is not one");
  }
  if (name.endsWith(".")) throw badHost(host, "a host carries no trailing dot");
  if (name.length > HOST_MAX_LENGTH) {
    throw badHost(
      host,
      `it is ${String(name.length)} characters, past the ${String(HOST_MAX_LENGTH)} a DNS name may be`,
    );
  }

  const labels = name.split(".");
  if (labels.some((label) => label === "")) throw badHost(host, "it holds an empty label");
  if (labels.length < 2) {
    throw badHost(host, "it must be fully qualified: at least two dot-separated labels");
  }
  for (const label of labels) {
    if (label.length > HOST_LABEL_MAX_LENGTH) {
      throw badHost(
        host,
        `its label "${label}" is past the ${String(HOST_LABEL_MAX_LENGTH)} characters a label may be`,
      );
    }
    if (!/^[a-z\d-]+$/.test(label)) {
      throw badHost(
        host,
        `its label "${label}" holds something other than letters, digits and hyphens`,
      );
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      throw badHost(host, `its label "${label}" starts or ends with a hyphen`);
    }
  }
  if (/^\d+$/.test(labels[labels.length - 1] as string)) {
    throw badHost(host, "its last label is all digits, so it names an address rather than a host");
  }

  return name;
}

/**
 * How a routing document writes "one label below this base": `*.shop.example`.
 *
 * NOBODY EVER TYPES IT. A wildcard is asked for as `--wildcard` on the base and
 * stored as a flag on the base's claim; this spelling exists only in the
 * document an ingress reads, where a key has to name the set rather than a host.
 * A consumer looks a request host up exactly first and, failing that, replaces
 * the host's first label with `*` and looks that up once.
 */
export function wildcardHost(base: string): string {
  return `*.${base}`;
}

/** The base a `*.BASE` routing key names, or null when the host is not one. */
export function wildcardBase(host: string): string | null {
  return host.startsWith("*.") ? host.slice(2) : null;
}

/** A host read as one label under a base that is itself a claimable host. */
export interface HostUnderBase {
  /** The first label, which is what names a family member: `preview`. */
  label: string;
  /** Everything below it, fully qualified: `shop.example.com`. */
  base: string;
}

/**
 * Splits `preview.shop.example.com` into `preview` and `shop.example.com`, or
 * answers null when the name is not one label under a fully qualified base.
 *
 * A WILDCARD COVERS EXACTLY ONE LABEL, as a TLS wildcard does, so this is also
 * the whole of the wildcard-matching rule: `a.b.shop.example.com` splits into
 * `a` and `b.shop.example.com`, which is a different base and matches only a
 * claim on that name.
 */
export function splitHostLabel(host: string): HostUnderBase | null {
  const dot = host.indexOf(".");
  if (dot < 1) return null;

  const label = host.slice(0, dot);
  const base = host.slice(dot + 1);
  if (!base.includes(".") || !HOST_LABEL_RE.test(label)) return null;
  return { label, base };
}

/** Writes `host:port`, bracketing an IPv6 literal the way a URL authority does. */
export function formatHostPort(host: string, port: number): string {
  const literal = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${literal}:${String(port)}`;
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

/** Names the rule a claimed host broke; the detail is what an operator reads. */
function badHost(host: string, why: string): ScafoError {
  return new ScafoError("invalid-input", "Invalid host", {
    detail: `"${host}" is no host to claim: ${why}`,
  });
}

/** Throws `ScafoError("invalid-slug")` when `s` is not a valid host. */
export function assertHost(s: string): void {
  if (!isHost(s)) {
    throw new ScafoError("invalid-slug", "Invalid host", {
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
