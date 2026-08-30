/*
 * What the ingress served, counted per environment.
 *
 * THE INGRESS IS THE ONLY COMPLETE OBSERVER OF TENANT TRAFFIC. The daemon sees
 * the requests it wakes and nothing else: once a process is up, every request
 * for it goes ingress → process and never passes through the node's own
 * surface. So the numbers a platform is measured by — requests, bytes, status,
 * latency, per project and environment — can only be read off the ingress's own
 * access log, which is what this counts.
 *
 * OPT-IN BY PRESENCE, SEPARATELY FROM THE OBSERVABILITY SWITCH. Counting needs a
 * file an operator's ingress writes, and most operators run their ingress their
 * own way. There is no default path and no warning for not having one: absent
 * `observability.ingressAccessLog`, nothing here is built at all.
 *
 * IN MEMORY, MONOTONIC, AND NOTHING PERSISTS IT — the same terms as the event
 * ring beside it (`src/daemon/observe.ts`). {@link IngressCounters.snapshot}
 * reads totals since the counters were made; windowing them and writing them to
 * the bucket is a later phase, and a restarted daemon counts from zero.
 */

import { parsePlatformHost } from "../core/placement/hosts.ts";
import { APEX_ENVIRONMENT, type RouteClaim } from "../core/placement/routes.ts";
import type { IngressRoute } from "../core/types/ingress.ts";
import { parseAccessLogLine } from "../core/utils/access-log.ts";

/**
 * Upper boundaries, in milliseconds, of the duration bands a request is counted
 * in. A request lands in the FIRST band whose boundary it does not exceed, and
 * anything past the last one lands in a band of its own — so the counts are one
 * longer than this list, and a histogram is a running sum over them.
 *
 * Fixed rather than configurable: bands that differ per node cannot be added up
 * across a fleet, which is the only thing anyone ever wants to do with them.
 */
export const DURATION_BANDS_MS: number[] = [10, 50, 100, 300, 1000, 3000];

/**
 * The project and environment a request is counted under when its Host resolved
 * to nothing this node serves.
 *
 * A single hyphen is not a slug — every real project and environment name is
 * alphanumeric segments joined by single hyphens — so this bucket can never
 * collide with a real one.
 */
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

/**
 * What the routing this node published says a host belongs to.
 *
 * BOTH HALVES ARE NEEDED AND THEY COVER DIFFERENT GAPS. `routes` is what the
 * ingress is actually serving, so it names every host with a ready process
 * behind it — an environment's label, its apex or a custom domain — and it
 * carries the environment each of them reaches. `claims`
 * is every custom domain an environment's record holds, ready or not, which is
 * what keeps a parked environment's own domain attributable while nothing is
 * running for it.
 */
export interface RoutingAttribution {
  routes: IngressRoute[];
  claims: RouteClaim[];
}

/** Where an ingress's access log is turned into what each environment was served. */
export interface IngressCounters {
  /**
   * Reads one line and counts it. Never throws: an unreadable line is counted as
   * malformed and dropped.
   */
  ingest(line: string): void;
  /**
   * Takes the routing this node last published as the answer to "whose host is
   * this". Restated wholesale on every reconcile pass, because a host that
   * stopped being served must stop being attributed to what used to serve it.
   */
  observeRouting(routing: RoutingAttribution): void;
  /**
   * The totals as they stand. Reading does NOT consume and does not reset:
   * counters are monotonic, and a reader that wants a window subtracts two
   * snapshots.
   */
  snapshot(): IngressCountersSnapshot;
}

export interface IngressCountersOptions {
  /** Apex domains the platform serves subdomains under; the host grammar is read against these. */
  platformDomains: string[];
  /** Clock the snapshot is stamped from; defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * Builds the counters an access-log adapter feeds.
 *
 * HOW A HOST BECOMES A PROJECT AND AN ENVIRONMENT, in two steps that are tried
 * in this order and no other:
 *
 * 1. THE ROUTING, when it names the host. This is the authority, and it has to
 *    be: it is the only thing that knows a custom domain belongs to an
 *    environment.
 * 2. THE PLATFORM HOST GRAMMAR, for everything else under a platform domain —
 *    `<project>.<domain>` as the apex environment, `<project>--<ref>.<domain>`
 *    as that ref. This is what a request for a PARKED or STARTING environment
 *    looks like: nothing routes it yet, and it is still that environment's
 *    traffic.
 *
 * Anything else — a domain this installation never minted, an address, a
 * scanner's invention — is {@link UNATTRIBUTED}, counted in full in its own
 * bucket and reported as a total of its own.
 */
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
      /* Claims first, so a custom domain whose environment has something ready
         is answered by the route rather than by the claim; the two agree, and
         the route is the one the request actually took. */
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
        /* Copied out: a reader must not be able to reach back into the counters,
           and a snapshot taken now must not change when the next line lands. */
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
