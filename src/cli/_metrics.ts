/*
 * Internal: turning the counter snapshots a fleet flushed into what it served
 * over a window, and printing it.
 *
 * THE SNAPSHOTS ARE MONOTONIC TOTALS AND THE WINDOW IS A SUBTRACTION. Each node
 * writes what it has counted SINCE ITS OWN BOOT, so a window is the last
 * snapshot inside it less the first — per node, per {project, environment}, and
 * per RUN of that node, a run being one unbroken `since`. A `since` that changed
 * means that node restarted and its totals went back to zero: the new run's
 * snapshot is taken WHOLE rather than subtracted from a baseline that no longer
 * exists, which is the difference between reporting a restart correctly and
 * reporting it as a negative number of requests.
 *
 * TWO SAMPLES ARE THE MINIMUM AND THAT IS INHERENT. A window holding one
 * snapshot of a run that predates it reads as zero — there is no earlier value
 * in the window to subtract from — so a window shorter than the flush interval
 * says less than a window longer than it. Widening `--since` is the answer, and
 * it is why the flush cadence is the one thing a reader has to know about.
 */

import {
  DURATION_BANDS_MS,
  type StatusClassCounts,
  UNATTRIBUTED,
} from "../daemon/access-counters.ts";
import { counterRecords, type ObserveRecord } from "../daemon/observe-records.ts";
import type { ObserveWindow } from "./_observe-read.ts";

/** What one environment was served over the window. */
export interface MetricsRow {
  project: string;
  env: string;
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
  /** One row per {project, environment}, sorted by project then environment. */
  rows: MetricsRow[];
  /** Every row added up. */
  totals: MetricsRow;
  /** Counter snapshots the window held. */
  samples: number;
  /** Nodes that wrote any of them, sorted. */
  nodes: string[];
}

export interface MetricsFilter {
  project?: string;
  env?: string;
}

/**
 * The row a host is shown under when it names nothing this installation holds.
 *
 * ONE ROW FOR EVERY WAY OF NAMING NOTHING: a request the counting node could not
 * attribute at all, a label under a platform domain that no project answers to,
 * and a project's own label with a ref it has no environment and no build for.
 * The alternative is what this replaces — a scanner walking `*.<domain>` turning
 * every label it invents into a project row of that name.
 *
 * Parenthesised, so it can never collide with a real name: every project and
 * environment is a slug, and no slug carries brackets.
 */
export const UNMATCHED: string = "(unmatched)";

/** Characters of a build id shown in the row a build's own host is grouped under. */
export const BUILD_LABEL_LENGTH: number = 12;

/**
 * What the registry holds, for a counted `{project, env}` to be read against.
 *
 * WHY THE READER HAS TO DO THIS AT ALL: the node counting an access log
 * attributes a host through the routing it published, and falls back to the
 * platform host grammar for everything the routing does not name — a parked
 * environment, one that is starting, one a wake was forwarded for. That grammar
 * is pure and registry-free by design, and it therefore CANNOT tell a build id
 * from an environment name, nor a real project from a label a crawler made up.
 * Only the registry can, and only this side of the flush has one.
 */
export interface MetricsNaming {
  /** Every project the registry holds. */
  projects: ReadonlySet<string>;
  /** The environments of each project, by project. */
  environments: ReadonlyMap<string, ReadonlySet<string>>;
  /** The build ids of each project, by project. */
  builds: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface MetricsOptions extends MetricsFilter {
  /**
   * What the registry holds, read back so a counted name can be checked rather
   * than trusted. Without it every name is taken exactly as it was counted:
   * there is nothing to check against, and guessing is the failure this exists
   * to fix.
   */
  naming?: MetricsNaming;
}

/**
 * The projects a window's counters name, sorted and deduplicated.
 *
 * What a caller reads {@link MetricsNaming} for — only these have to be looked
 * up, rather than every project the installation has ever held. The
 * {@link UNATTRIBUTED} bucket is not a project and is never among them.
 */
export function projectsCounted(records: readonly ObserveRecord[]): string[] {
  const named = new Set<string>();
  for (const record of counterRecords(records)) {
    if (record.project !== UNATTRIBUTED) named.add(record.project);
  }
  return [...named].sort(compare);
}

/**
 * What a counted `{project, env}` really names, or {@link UNMATCHED} when it
 * names nothing this installation holds.
 *
 * A BUILD'S OWN HOST BELONGS TO ITS PROJECT, under a row that says which build
 * it was. It is deliberately NOT folded into the environment the build was
 * deployed into: that needs the build record itself — one bucket read per build
 * id — while the listing that says it IS a build is already paid for, and a row
 * naming the build is what the traffic actually was. The ROUTED case is
 * unaffected and always was correct: a build host the ingress serves is
 * attributed to its environment by the routing, before any of this.
 *
 * A NAME THE REGISTRY NO LONGER HOLDS READS AS UNMATCHED, deletion included.
 * That is the honest answer rather than a compromise: a deleted environment
 * takes its builds, its domains and its history with it by design, and a row
 * naming one would claim an environment that is not there.
 */
export function attributionOf(
  counted: { project: string; env: string },
  naming: MetricsNaming,
): { project: string; env: string } {
  /* Stated first and on its own, because it is the rule that matters most: a
     name that is not a project never becomes one, however well it parses. */
  if (!naming.projects.has(counted.project)) return { project: UNMATCHED, env: UNMATCHED };

  if (naming.environments.get(counted.project)?.has(counted.env) === true) return counted;

  if (naming.builds.get(counted.project)?.has(counted.env) === true) {
    return { project: counted.project, env: `(build ${counted.env.slice(0, BUILD_LABEL_LENGTH)})` };
  }
  return { project: UNMATCHED, env: UNMATCHED };
}

/**
 * The window's counter records reduced to one row per {project, environment}.
 *
 * The filter is applied to the ROWS rather than to the records, so a snapshot
 * that carries several environments is read once whichever one was asked for —
 * and to the row's RESOLVED name rather than to the counted one, because that
 * is the name a reader is looking at.
 */
export function summarizeMetrics(
  records: readonly ObserveRecord[],
  window: ObserveWindow,
  opts: MetricsOptions = {},
): MetricsSummary {
  const runs = new Map<string, { since: number; first: MetricsSample; last: MetricsSample }>();
  const nodes = new Set<string>();
  let samples = 0;

  for (const record of counterRecords(records)) {
    const named = opts.naming === undefined ? record : attributionOf(record, opts.naming);
    if (opts.project !== undefined && named.project !== opts.project) continue;
    if (opts.env !== undefined && named.env !== opts.env) continue;

    samples++;
    nodes.add(record.node);
    /* The key is what was COUNTED rather than what it resolved to, so two names
       landing in one row are still differenced apart: each is its own monotonic
       series on that node, and subtracting one from the other would be
       arithmetic across two counters. */
    const key = [record.node, record.project, record.env, record.since].join(" ");
    const sample: MetricsSample = {
      node: record.node,
      project: named.project,
      env: named.env,
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
    const row = rowFor(rows, run.last.project, run.last.env);
    addDelta(row, run.last, baseline);

    const seen = contributors.get(`${row.project}/${row.env}`) ?? new Set<string>();
    seen.add(run.last.node);
    contributors.set(`${row.project}/${row.env}`, seen);
  }

  const ordered = [...rows.values()]
    .map((row) => ({
      ...row,
      nodes: [...(contributors.get(`${row.project}/${row.env}`) ?? [])].sort(),
    }))
    .sort((a, b) => compare(`${a.project}/${a.env}`, `${b.project}/${b.env}`));

  const totals = emptyRow("", "");
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
 * The summary as a table: one line per environment, then the totals.
 *
 * The latency columns are BANDS rather than interpolated percentiles, because
 * bands are what was counted — `<=100ms` says the median request finished inside
 * the 100ms band and nothing more precise is knowable from seven counters.
 */
export function formatMetrics(summary: MetricsSummary): string {
  const header = ["PROJECT", "ENV", "REQUESTS", "BYTES", "2XX", "3XX", "4XX", "5XX", "P50", "P95"];
  const body = summary.rows.map((row) => cells(row.project, row.env, row));
  const totals = cells("TOTAL", "", summary.totals);

  const rows = [header, ...body, totals];
  const widths = header.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  const rendered = rows.map((row) =>
    row
      .map((cell, column) =>
        /* The two name columns read left to right; every number is compared
           against the one above it, which only works right-aligned. */
        column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]),
      )
      .join("  ")
      .trimEnd(),
  );

  /* A rule before the totals, so a fleet with one environment cannot be misread
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

/** One node's totals for one environment at one moment. */
interface MetricsSample {
  node: string;
  project: string;
  env: string;
  requests: number;
  bytes: number;
  status: StatusClassCounts;
  durations: number[];
}

const STATUS_CLASSES: (keyof StatusClassCounts)[] = ["2xx", "3xx", "4xx", "5xx", "other"];

function emptyRow(project: string, env: string): MetricsRow {
  return {
    project,
    env,
    requests: 0,
    bytes: 0,
    status: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, "other": 0 },
    durations: Array.from({ length: DURATION_BANDS_MS.length + 1 }, () => 0),
    nodes: [],
  };
}

function rowFor(rows: Map<string, MetricsRow>, project: string, env: string): MetricsRow {
  const key = `${project}/${env}`;
  const found = rows.get(key);
  if (found !== undefined) return found;

  const created = emptyRow(project, env);
  rows.set(key, created);
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

function cells(project: string, env: string, row: MetricsRow): string[] {
  return [
    project,
    env,
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
