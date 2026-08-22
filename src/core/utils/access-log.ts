/*
 * Reading one line of an ingress's access log into the request it records.
 *
 * PURE, AND THAT IS WHY IT IS HERE rather than beside the tailer that produces
 * the lines: no file, no clock, no state. A caller hands it a string from
 * wherever it came from, and a test states a line rather than writing one.
 *
 * TWO FORMATS, DETECTED PER LINE. A file only ever carries one in practice, but
 * a rotated or concatenated file can carry both, and a reader that decided once
 * would be wedged by the first line of the other kind. Detection is a look at
 * two keys of the parsed object, which costs nothing next to the parse itself.
 *
 * NOTHING HERE THROWS. A line that is not JSON, not an object, of no format this
 * knows, or carrying no host and status is `null` — the caller counts it as
 * malformed and moves on. An ingress's log is an outside input arriving
 * unattended: one bad line must never be able to stop a node counting.
 */

/** Access-log formats this reads. Both are the ingress's own JSON output. */
export type AccessLogFormat = "caddy" | "traefik";

/** One request, as an ingress recorded serving it. */
export interface AccessLogRequest {
  /** Which format the line was read as. */
  format: AccessLogFormat;
  /** The Host the request asked for, lowercased and with any port stripped. */
  host: string;
  /** HTTP method, uppercased; empty when the line did not record one. */
  method: string;
  /** Status the ingress answered the client with. */
  status: number;
  /** Response body bytes the ingress reported writing; `0` when unrecorded. */
  bytes: number;
  /** What the ingress measured the whole request at, in milliseconds. */
  durationMs: number;
}

/**
 * Which format an already-parsed line is in, or null when it is neither.
 *
 * Key sniffing, in the order that settles it fastest. Traefik's fields are
 * unmistakable — flat, PascalCase, one object per request — so `RequestHost` or
 * `DownstreamStatus` decides it outright. Caddy nests everything the request
 * asked for under `request`, and nothing else it logs carries that object.
 */
export function detectAccessLogFormat(entry: Record<string, unknown>): AccessLogFormat | null {
  if ("RequestHost" in entry || "DownstreamStatus" in entry) return "traefik";
  if (typeof entry.request === "object" && entry.request !== null) return "caddy";
  return null;
}

/**
 * The request one line records, or null when the line is not one.
 *
 * WHAT EACH FORMAT IS READ FROM, verified against a Caddy 2.11.4 and a Traefik
 * 3.7.11 writing their own access logs:
 *
 * - Caddy (`http.log.access`, json encoder): `request.host`, `request.method`,
 *   `status`, `size` (response body bytes), `duration` (SECONDS, float).
 * - Traefik (`--accesslog.format=json`): `RequestHost`, `RequestMethod`,
 *   `DownstreamStatus`, `DownstreamContentSize`, `Duration` (NANOSECONDS).
 *
 * A HOST AND A STATUS ARE WHAT MAKE A LINE A REQUEST; everything else defaults
 * to zero rather than failing the line, because a missing size or duration is a
 * field an ingress chose not to write and not a broken record. Caddy's
 * `request.host` CARRIES THE PORT when the client sent one
 * (`shop.scafo.test:8080`, observed) — Traefik's does not — so both are
 * normalized the same way and the two agree on what a host is.
 *
 * POINTING THIS AT THE WRONG FILE IS VISIBLE RATHER THAN SILENT: Caddy's own
 * runtime log carries no `request`, so a node reading it counts every line as
 * malformed and nothing as traffic.
 */
export function parseAccessLogLine(line: string): AccessLogRequest | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;

  let entry: unknown;
  try {
    entry = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;

  const fields = entry as Record<string, unknown>;
  const format = detectAccessLogFormat(fields);
  if (format === null) return null;

  const request = format === "caddy" ? ((fields.request ?? {}) as Record<string, unknown>) : fields;
  const host = normalizeHost(request[format === "caddy" ? "host" : "RequestHost"]);
  const status = whole(fields[format === "caddy" ? "status" : "DownstreamStatus"]);
  if (host === null || status === null) return null;

  return {
    format,
    host,
    method: method(request[format === "caddy" ? "method" : "RequestMethod"]),
    status,
    bytes: whole(fields[format === "caddy" ? "size" : "DownstreamContentSize"]) ?? 0,
    durationMs:
      format === "caddy" ? scaled(fields.duration, 1_000) : scaled(fields.Duration, 1 / 1_000_000),
  };
}

/* ------------------------------------------------------------------ internal */

/**
 * The Host as a name a routing can be asked about: lowercased, and with the port
 * an ingress may have logged alongside it taken off.
 *
 * Null when there is no usable name there at all. The shape is NOT validated
 * beyond that — an address, a bare label, something a scanner made up, they are
 * all hosts a request really carried, and a name nothing answers to is a
 * question for attribution rather than for parsing.
 */
function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const written = value.trim().toLowerCase();
  if (written === "") return null;

  /* An IPv6 literal is bracketed in a Host header, so the brackets bound the
     address and whatever follows them is the port. */
  if (written.startsWith("[")) {
    const end = written.indexOf("]");
    return end > 1 ? written.slice(1, end) : null;
  }

  /* ONE colon and digits after it is a port; more than one is an address that
     was written without the brackets that would have bounded it, and taking
     anything off that would invent a name. */
  const colon = written.indexOf(":");
  if (colon >= 0 && written.lastIndexOf(":") === colon && /^\d+$/.test(written.slice(colon + 1))) {
    const bare = written.slice(0, colon);
    return bare === "" ? null : bare;
  }
  return written;
}

/** The method as it is counted: uppercase, or empty when the line carried none. */
function method(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

/**
 * A whole non-negative number, or null when the field holds nothing readable.
 * Text is accepted beside a JSON number: an ingress that quotes its integers is
 * still recording the same thing.
 */
function whole(value: unknown): number | null {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.floor(numeric);
}

/** A duration in the unit the caller asks for, or `0` when it is not a duration. */
function scaled(value: unknown, factor: number): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric * factor;
}
