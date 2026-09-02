/* Monotonic in-memory per-environment ingress access-log counters. Built only
   with an ingress log; observation flushing persists snapshots. */

import { parsePlatformHost } from "../core/placement/hosts.ts";
import { APEX_ENVIRONMENT, type RouteClaim } from "../core/placement/routes.ts";
import type { IngressRoute } from "../core/types/ingress.ts";
import { parseAccessLogLine } from "../core/utils/access-log.ts";

/** Shared millisecond histogram upper bounds; fixed for fleet-wide aggregation. */
export const DURATION_BANDS_MS: number[] = [10, 50, 100, 300, 1000, 3000];

/** Reserved non-slug bucket for hosts not attributed to this node. */
export const UNATTRIBUTED: string = "-";

/** Status classes a response is counted in; `other` is anything outside 200-599. */
export interface StatusClassCounts {
  "2xx": number;
  "3xx": number;
  "4xx": number;
  "5xx": number;
  "other": number;
}

/** What one environment was served, since counting started. */
export interface IngressBucket {
  /** {@link UNATTRIBUTED} when the Host resolved to nothing. */
  project: string;
  /** {@link UNATTRIBUTED} when the Host resolved to nothing. */
  env: string;
  requests: number;
  /** Response body bytes, as the ingress reported them. */
  bytes: number;
  status: StatusClassCounts;
  /** One count per {@link DURATION_BANDS_MS} band, plus one for everything past the last. */
  durations: number[];
}

/** Everything the adapter has counted, monotonic since {@link IngressCountersSnapshot.since}. */
export interface IngressCountersSnapshot {
  /** When this adapter started counting; every total below is from then. */
  since: string;
  /** Lines read off the log, whatever became of them. */
  lines: number;
  /** Lines no format could be read out of. Skipped, never thrown. */
  malformed: number;
  /** Requests whose Host resolved to nothing, counted in the {@link UNATTRIBUTED} bucket. */
  unattributed: number;
  /** One entry per project and environment counted, sorted by project then environment. */
  buckets: IngressBucket[];
}

/** Current served routes plus durable custom-domain claims for attribution. */
export interface RoutingAttribution {
  routes: IngressRoute[];
  claims: RouteClaim[];
}

/** Where an ingress's access log is turned into what each environment was served. */
export interface IngressCounters {
  /** Counts one line; malformed input increments `malformed` and does not throw. */
  ingest(line: string): void;
  /** Replaces routing attribution after reconciliation. */
  observeRouting(routing: RoutingAttribution): void;
  /** Non-consuming monotonic snapshot; callers derive windows by subtraction. */
  snapshot(): IngressCountersSnapshot;
}

export interface IngressCountersOptions {
  /** Apex domains the platform serves subdomains under; the host grammar is read against these. */
  platformDomains: string[];
  /** Clock the snapshot is stamped from; defaults to `new Date()`. */
  now?: () => Date;
}

/** Creates ingress counters. Attribute current routing first, then platform
    host grammar; all other hosts use {@link UNATTRIBUTED}. */
export function createIngressCounters(opts: IngressCountersOptions): IngressCounters {
  const now = opts.now ?? ((): Date => new Date());
  const since = now().toISOString();
  const domains = [...opts.platformDomains];

  let routing = new Map<string, Attributed>();
  const buckets = new Map<string, IngressBucket>();
  let lines = 0;
  let malformed = 0;
  let unattributed = 0;

  const attribute = (host: string): Attributed | null => {
    const routed = routing.get(host);
    if (routed !== undefined) return routed;

    const named = parsePlatformHost(host, domains);
    return named === null ? null : { project: named.project, env: named.ref ?? APEX_ENVIRONMENT };
  };

  return {
    ingest(line: string): void {
      lines++;

      const request = parseAccessLogLine(line);
      if (request === null) {
        malformed++;
        return;
      }

      const target = attribute(request.host);
      if (target === null) unattributed++;

      const bucket = bucketFor(buckets, target ?? { project: UNATTRIBUTED, env: UNATTRIBUTED });
      bucket.requests++;
      bucket.bytes += request.bytes;
      bucket.status[statusClass(request.status)]++;
      bucket.durations[durationBand(request.durationMs)]++;
    },

    observeRouting(input: RoutingAttribution): void {
      const next = new Map<string, Attributed>();
      /* Routes override claims because they represent the request target. */
      for (const claim of input.claims) {
        next.set(claim.host, { project: claim.project, env: claim.environment });
      }
      for (const route of input.routes) {
        next.set(route.host, { project: route.backend.project, env: route.backend.env });
      }
      routing = next;
    },

    snapshot(): IngressCountersSnapshot {
      return {
        since,
        lines,
        malformed,
        unattributed,
        /* Snapshot must not alias mutable counters. */
        buckets: [...buckets.values()]
          .map((bucket) => ({
            ...bucket,
            status: { ...bucket.status },
            durations: [...bucket.durations],
          }))
          .sort((a, b) => compare(`${a.project}/${a.env}`, `${b.project}/${b.env}`)),
      };
    },
  };
}

/* ------------------------------------------------------------------ internal */

/** What a host was resolved to. */
interface Attributed {
  project: string;
  env: string;
}

function bucketFor(buckets: Map<string, IngressBucket>, target: Attributed): IngressBucket {
  const key = `${target.project}/${target.env}`;
  const found = buckets.get(key);
  if (found !== undefined) return found;

  const created: IngressBucket = {
    project: target.project,
    env: target.env,
    requests: 0,
    bytes: 0,
    status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0 },
    durations: Array.from({ length: DURATION_BANDS_MS.length + 1 }, () => 0),
  };
  buckets.set(key, created);
  return created;
}

function statusClass(status: number): keyof StatusClassCounts {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}

/** The first band the duration does not exceed, or the one past the last boundary. */
function durationBand(durationMs: number): number {
  for (let index = 0; index < DURATION_BANDS_MS.length; index++) {
    if (durationMs <= DURATION_BANDS_MS[index]) return index;
  }
  return DURATION_BANDS_MS.length;
}

/* Code-unit ordering, so a snapshot does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
