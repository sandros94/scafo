/* Parses Caddy and Traefik JSON access logs independently per line. Malformed
   lines return null so unattended input cannot stop counting. */

import { safeJsonParse } from "unsecure/sanitize";

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

/** Returns the access-log format, if known. */
export function detectAccessLogFormat(entry: Record<string, unknown>): AccessLogFormat | null {
  if ("RequestHost" in entry || "DownstreamStatus" in entry) return "traefik";
  if (typeof entry.request === "object" && entry.request !== null) return "caddy";
  return null;
}

/** Parses one JSON access-log record. Host and status are required; other
 * measurements default to zero. Caddy durations are seconds; Traefik's are ns. */
export function parseAccessLogLine(line: string): AccessLogRequest | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;

  let entry: unknown;
  try {
    /* A line an ingress wrote about a request somebody else made: read without
       the keys an object answers for on its own. */
    entry = safeJsonParse<unknown>(trimmed);
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

/** Lowercases a Host value and removes a port without validating its routeability. */
function normalizeHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const written = value.trim().toLowerCase();
  if (written === "") return null;

  /* Brackets delimit an IPv6 literal before its optional port. */
  if (written.startsWith("[")) {
    const end = written.indexOf("]");
    return end > 1 ? written.slice(1, end) : null;
  }

  /* Strip only an unambiguous host:port suffix, never an unbracketed IPv6 value. */
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
