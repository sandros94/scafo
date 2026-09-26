/* Summarizes monotonic node counter snapshots over a window. Subtract per
   node/run (`since`); a restarted run starts from its first sample. */

import {
  DURATION_BANDS_MS,
  type StatusClassCounts,
  UNATTRIBUTED,
} from "../daemon/access-counters.ts";
import { counterRecords, type ObserveRecord } from "../daemon/observe-records.ts";
import type { ObserveWindow } from "./_observe-read.ts";

/** What one application was served over the window. */
export interface MetricsRow {
  application: string;
  requests: number;
  /** Response body bytes, as the ingress reported them. */
  bytes: number;
  status: StatusClassCounts;
  /** One count per {@link DURATION_BANDS_MS} band, plus one past the last. */
  durations: number[];
  /** Nodes that served any of it, sorted. */
  nodes: string[];
}

/** What a window of counter snapshots came to. */
export interface MetricsSummary {
  /** Window read, as ISO-8601 instants. */
  since: string;
  until: string;
  /** One row per application, sorted by name. */
  rows: MetricsRow[];
  /** Every row added up. */
  totals: MetricsRow;
  /** Counter snapshots the window held. */
  samples: number;
  /** Nodes that wrote any of them, sorted. */
  nodes: string[];
}

export interface MetricsFilter {
  application?: string;
}

/** Reserved non-slug row for hosts not held by this installation. */
export const UNMATCHED: string = "(unmatched)";

/** Registry names used to verify counted attribution. */
export interface MetricsNaming {
  /** Every application the registry holds. */
  applications: ReadonlySet<string>;
}

export interface MetricsOptions extends MetricsFilter {
  /** Optional registry names used to validate attribution. */
  naming?: MetricsNaming;
}

/** Counted application names, excluding {@link UNATTRIBUTED}. */
export function applicationsCounted(records: readonly ObserveRecord[]): string[] {
  const named = new Set<string>();
  for (const record of counterRecords(records)) {
    if (record.application !== UNATTRIBUTED) named.add(record.application);
  }
  return [...named].sort(compare);
}

/** Resolves counted attribution; a name the registry does not hold is {@link UNMATCHED}. */
export function attributionOf(counted: string, naming: MetricsNaming): string {
  return naming.applications.has(counted) ? counted : UNMATCHED;
}

/** Reduces window counters to one row per resolved application. */
export function summarizeMetrics(
  records: readonly ObserveRecord[],
  window: ObserveWindow,
  opts: MetricsOptions = {},
): MetricsSummary {
  const runs = new Map<string, { since: number; first: MetricsSample; last: MetricsSample }>();
  const nodes = new Set<string>();
  let samples = 0;

  for (const record of counterRecords(records)) {
    const named =
      opts.naming === undefined
        ? record.application
        : attributionOf(record.application, opts.naming);
    if (opts.application !== undefined && named !== opts.application) continue;

    samples++;
    nodes.add(record.node);
    /* The key is what was COUNTED rather than what it resolved to, so two names
       landing in one row are still differenced apart: each is its own monotonic
       series on that node, and subtracting one from the other would be
       arithmetic across two counters. */
    const key = [record.node, record.application, record.since].join("\u0000");
    const sample: MetricsSample = {
      node: record.node,
      application: named,
      requests: record.requests,
      bytes: record.bytes,
      status: record.status,
      durations: record.durations,
    };

    const run = runs.get(key);
    /* Records arrive oldest first, so the first one seen for a run is its
       baseline and every later one replaces its end. */
    if (run === undefined)
      runs.set(key, { since: Date.parse(record.since), first: sample, last: sample });
    else run.last = sample;
  }

  const rows = new Map<string, MetricsRow>();
  const contributors = new Map<string, Set<string>>();
  for (const run of runs.values()) {
    /* A run that BEGAN inside the window has no baseline outside it: everything
       it counted, it counted here. Anything else is the difference. */
    const baseline = run.since >= window.sinceMs ? null : run.first;
    const row = rowFor(rows, run.last.application);
    addDelta(row, run.last, baseline);

    const seen = contributors.get(row.application) ?? new Set<string>();
    seen.add(run.last.node);
    contributors.set(row.application, seen);
  }

  const ordered = [...rows.values()]
    .map((row) => ({ ...row, nodes: [...(contributors.get(row.application) ?? [])].sort() }))
    .sort((a, b) => compare(a.application, b.application));

  const totals = emptyRow("");
  for (const row of ordered) addRow(totals, row);
  totals.nodes = [...nodes].sort();

  return {
    since: new Date(window.sinceMs).toISOString(),
    until: new Date(window.untilMs).toISOString(),
    rows: ordered,
    totals,
    samples,
    nodes: [...nodes].sort(),
  };
}

/**
 * The summary as a table: one line per application, then the totals.
 *
 * The latency columns are BANDS rather than interpolated percentiles, because
 * bands are what was counted — `<=100ms` says the median request finished inside
 * the 100ms band and nothing more precise is knowable from seven counters.
 */
export function formatMetrics(summary: MetricsSummary): string {
  const header = ["APPLICATION", "REQUESTS", "BYTES", "2XX", "3XX", "4XX", "5XX", "P50", "P95"];
  const body = summary.rows.map((row) => cells(row.application, row));
  const totals = cells("TOTAL", summary.totals);

  const rows = [header, ...body, totals];
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  const rendered = rows.map((row) =>
    row
      .map((cell, column) =>
        /* The name column reads left to right; every number is compared against
           the one above it, which only works right-aligned. */
        column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]),
      )
      .join("  ")
      .trimEnd(),
  );

  /* A rule before the totals, so a fleet with one application cannot be misread
     as having its total counted twice. */
  rendered.splice(rendered.length - 1, 0, "-".repeat(rendered[0].length));
  return rendered.join("\n");
}

/** What a window with no counter records in it says, given what it did find. */
export function noCounters(records: readonly ObserveRecord[]): string {
  const nodes = new Set(records.map((record) => record.node));
  if (nodes.size === 0) return "";

  return (
    `scafo: nothing recorded — ${String(nodes.size)} node(s) reported on themselves in this ` +
    `window but none of them counts requests. Counting needs the ingress's access log: set ` +
    `"observability.ingressAccessLog" (--ingress-access-log, SCAFO_INGRESS_ACCESS_LOG) on the ` +
    `nodes serving this traffic`
  );
}

/** A duration band as a reader sees it: its upper bound, or past the last one. */
export function bandLabel(index: number): string {
  const bound = DURATION_BANDS_MS[index];
  return bound === undefined
    ? `>${duration(DURATION_BANDS_MS.at(-1) ?? 0)}`
    : `<=${duration(bound)}`;
}

/**
 * The band a given share of the requests finished inside, or `-` when nothing
 * was counted. A running sum over the bands, which is what a histogram is.
 */
export function bandAt(durations: readonly number[], share: number): string {
  const total = durations.reduce((sum, count) => sum + count, 0);
  if (total === 0) return "-";

  const wanted = total * share;
  let seen = 0;
  for (let index = 0; index < durations.length; index++) {
    seen += durations[index];
    if (seen >= wanted) return bandLabel(index);
  }
  return bandLabel(durations.length - 1);
}

/* ------------------------------------------------------------------ internal */

/** One node's totals for one application at one moment. */
interface MetricsSample {
  node: string;
  application: string;
  requests: number;
  bytes: number;
  status: StatusClassCounts;
  durations: number[];
}

const STATUS_CLASSES: (keyof StatusClassCounts)[] = ["2xx", "3xx", "4xx", "5xx", "other"];

function emptyRow(application: string): MetricsRow {
  return {
    application,
    requests: 0,
    bytes: 0,
    status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0 },
    durations: Array.from({ length: DURATION_BANDS_MS.length + 1 }, () => 0),
    nodes: [],
  };
}

function rowFor(rows: Map<string, MetricsRow>, application: string): MetricsRow {
  const found = rows.get(application);
  if (found !== undefined) return found;

  const created = emptyRow(application);
  rows.set(application, created);
  return created;
}

/**
 * Adds one run's contribution: the last sample less the baseline, or the whole
 * sample when the run began inside the window.
 *
 * Every difference is clamped at zero. Counters only ever go up within a run, so
 * a negative can only come from a clock that went backwards or a record written
 * out of order, and a negative request count is worse than a missing one.
 */
function addDelta(row: MetricsRow, last: MetricsSample, baseline: MetricsSample | null): void {
  row.requests += atLeastZero(last.requests - (baseline?.requests ?? 0));
  row.bytes += atLeastZero(last.bytes - (baseline?.bytes ?? 0));
  for (const name of STATUS_CLASSES) {
    row.status[name] += atLeastZero(last.status[name] - (baseline?.status[name] ?? 0));
  }
  for (let index = 0; index < row.durations.length; index++) {
    row.durations[index] += atLeastZero(
      (last.durations[index] ?? 0) - (baseline?.durations[index] ?? 0),
    );
  }
}

function addRow(into: MetricsRow, row: MetricsRow): void {
  into.requests += row.requests;
  into.bytes += row.bytes;
  for (const name of STATUS_CLASSES) into.status[name] += row.status[name];
  for (let index = 0; index < into.durations.length; index++) {
    into.durations[index] += row.durations[index] ?? 0;
  }
}

function cells(application: string, row: MetricsRow): string[] {
  return [
    application,
    String(row.requests),
    bytes(row.bytes),
    String(row.status["2xx"]),
    String(row.status["3xx"]),
    String(row.status["4xx"]),
    String(row.status["5xx"]),
    bandAt(row.durations, 0.5),
    bandAt(row.durations, 0.95),
  ];
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}

/** Milliseconds as an operator writes them: `300ms`, `1s`, `3s`. */
function duration(ms: number): string {
  return ms < 1000 ? `${String(ms)}ms` : `${String(ms / 1000)}s`;
}

/** Bytes at three significant figures, in the unit a human would have picked. */
function bytes(value: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit++;
  }
  const shown = unit === 0 ? String(scaled) : scaled.toFixed(scaled < 10 ? 2 : 1);
  return `${shown} ${units[unit]}`;
}

/* Code-unit ordering, so a table does not depend on the reader's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
