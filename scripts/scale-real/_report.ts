/*
 * The markdown one run produces.
 *
 * FACTS AND NOTHING ELSE. There is no verdict language and no budget anywhere in
 * here: the report says what the machines did, and a default is chosen by a
 * human reading the slowest row of it. Every "Finding" is generated from a
 * measurement — an OOM kill, a missed deadline, a port that moved, a deploy that
 * failed — never written by hand.
 */

import type { CellMeasurement, PhaseResources } from "./_phases.ts";
import { PHASES } from "./_phases.ts";

export interface ReportHeader {
  commit: string;
  dirty: boolean;
  engine: string;
  engineVersion: string;
  host: { cpus: number; memoryBytes: number; kernel: string; platform: string };
  image: string;
  imageDigest: string;
  storeImage: string;
  flags: string;
  startedAt: string;
  finishedAt: string;
  runId: string;
}

/** A cell whose installation or script work failed outright, rather than a phase. */
export interface AbortedCell {
  cell: string;
  error: string;
}

/** Renders the whole document. */
export function renderReport(
  header: ReportHeader,
  cells: CellMeasurement[],
  aborted: AbortedCell[] = [],
): string {
  const lines: string[] = [
    `# scafo scale:real — an on-demand benchmark on real containers`,
    ``,
    `Every number below was measured on real containers by \`pnpm scale:real\`. It`,
    `is not a test, nothing asserts a budget, and CI never runs it: the sweep`,
    `exists so a default is never chosen from one big development machine.`,
    ``,
    `| | |`,
    `| --- | --- |`,
    `| commit | \`${header.commit}\`${header.dirty ? " (worktree dirty)" : ""} |`,
    `| engine | ${header.engine} ${header.engineVersion} |`,
    `| host | ${String(header.host.cpus)} cpus, ${gib(header.host.memoryBytes)} RAM, ${header.host.platform} ${header.host.kernel} |`,
    `| node image | ${header.image} \`${header.imageDigest}\` |`,
    `| store image | ${header.storeImage} |`,
    `| flags | \`${header.flags}\` |`,
    `| run | \`${header.runId}\`, ${header.startedAt} → ${header.finishedAt} |`,
    ``,
    ...bootTable(cells),
    ...deployTable(cells),
    ...convergenceTable(cells),
    ...idleTable(cells),
    ...burstTable(cells),
    ...restartTable(cells),
    ...resourceTable(cells),
    ...findings(cells, aborted),
    ...raw(cells),
  ];
  return lines.join("\n");
}

function bootTable(cells: CellMeasurement[]): string[] {
  return [
    `## 1. Boot`,
    ``,
    `From the creation of the node containers to every node answering`,
    `\`/.well-known/scafo/health\` with one coordinator elected.`,
    ``,
    `| cell | nodes | seconds |`,
    `| --- | ---: | ---: |`,
    ...cells.map(
      (cell) =>
        `| ${name(cell)} | ${String(cell.nodes)} | ${seconds(cell.boot.seconds, cell.boot.note)} |`,
    ),
    ``,
  ];
}

function deployTable(cells: CellMeasurement[]): string[] {
  return [
    `## 2. First deploys`,
    ``,
    `The real CLI, one application after another, replicas \`all\`.`,
    ``,
    `| cell | applications | p50 | max | failed |`,
    `| --- | ---: | ---: | ---: | --- |`,
    ...cells.map(
      (cell) =>
        `| ${name(cell)} | ${String(cell.deploys.count)} | ${ms(cell.deploys.p50Ms)} | ` +
        `${ms(cell.deploys.maxMs)} | ${failures(cell.deploys.failures)} |`,
    ),
    ``,
  ];
}

function convergenceTable(cells: CellMeasurement[]): string[] {
  return [
    `## 3. Convergence`,
    ``,
    `Seconds from the last deploy's acknowledgement until every application`,
    `answered 200 on every node's own public port for it.`,
    ``,
    `| cell | seconds |`,
    `| --- | ---: |`,
    ...cells.map(
      (cell) => `| ${name(cell)} | ${seconds(cell.convergence.seconds, cell.convergence.note)} |`,
    ),
    ``,
  ];
}

function idleTable(cells: CellMeasurement[]): string[] {
  const methods = ["GET", "LIST", "PUT", "DELETE", "HEAD", "POST"];
  const keyspaces = ["scafo", "celld-fleets", "celld-deploy", "celld-blobs", "other"];
  const measured = cells.some((cell) => cell.idle.storeMetricsAvailable);

  return [
    `## 4. Idle`,
    ``,
    `Nothing happens. Store requests per minute, counted at the delay proxy every`,
    `client reaches the bucket through — so this is what the bucket was asked for,`,
    `by request line.`,
    ``,
    `| cell | idle s | total/min | ${methods.join(" | ")} |`,
    `| --- | ---: | ---: | ${methods.map(() => "---:").join(" | ")} |`,
    ...cells.map((cell) => {
      const total = Object.values(cell.idle.perMinuteByMethod).reduce((a, b) => a + b, 0);
      return (
        `| ${name(cell)} | ${String(cell.idle.seconds)} | ${round(total)} | ` +
        methods.map((method) => round(cell.idle.perMinuteByMethod[method] ?? 0)).join(" | ") +
        ` |`
      );
    }),
    ``,
    `### Whose requests they are`,
    ``,
    `BY KEYSPACE, WHICH IS NOT BY PROCESS. A node and the runtime processes it`,
    `supervises share one container and one connection to the store, and the`,
    `requests carry no user agent that separates them, so nothing here says which`,
    `process sent a request. What it does say is whose keys were touched: \`scafo\``,
    `is \`_scafo/\`, and \`celld-*\` are the runtime's own \`fleets/\`, \`deploy/\` and`,
    `\`deploy-blobs/\` keyspaces.`,
    ``,
    `| cell | ${keyspaces.join(" | ")} |`,
    `| --- | ${keyspaces.map(() => "---:").join(" | ")} |`,
    ...cells.map(
      (cell) =>
        `| ${name(cell)} | ` +
        keyspaces.map((space) => round(cell.idle.perMinuteByKeyspace[space] ?? 0)).join(" | ") +
        ` |`,
    ),
    ``,
    `### Runtime processes at the end of idle`,
    ``,
    `| cell | ${cells[0]?.idle.celld.map((entry) => entry.node).join(" | ") ?? "node"} |`,
    `| --- | ${cells[0]?.idle.celld.map(() => "---:").join(" | ") ?? "---:"} |`,
    ...cells.map(
      (cell) =>
        `| ${name(cell)} | ` +
        cell.idle.celld
          .map((entry) => `${String(entry.processes)} procs, ${mib(entry.rssBytes)} RSS`)
          .join(" | ") +
        ` |`,
    ),
    ``,
    measured
      ? `SeaweedFS's own \`/metrics\` was read before and after each idle window; the` +
        ` per-minute deltas of every counter naming a request are in the raw JSON below.`
      : `SeaweedFS's \`/metrics\` endpoint answered nothing this run, so the store's own` +
        ` view is absent and only the proxy's count is reported.`,
    ``,
  ];
}

function burstTable(cells: CellMeasurement[]): string[] {
  return [
    `## 5. Burst`,
    ``,
    `A new version of every application, deployed by concurrent CLI processes.`,
    `"served" is the time from the last deploy settling until every node answered`,
    `with the new version for every application.`,
    ``,
    `| cell | deploys | succeeded | failed | wall | max single | served (s) |`,
    `| --- | ---: | ---: | --- | ---: | ---: | ---: |`,
    ...cells.map(
      (cell) =>
        `| ${name(cell)} | ${String(cell.burst.deploys)} | ${String(cell.burst.succeeded)} | ` +
        `${failures(cell.burst.failed)} | ${ms(cell.burst.wallMs)} | ${ms(cell.burst.maxSingleMs)} | ` +
        `${seconds(cell.burst.servedSeconds, cell.burst.note)} |`,
    ),
    ``,
  ];
}

function restartTable(cells: CellMeasurement[]): string[] {
  const rows: string[] = [];
  for (const cell of cells) {
    for (const outcome of cell.restart) {
      rows.push(
        `| ${name(cell)} | ${outcome.node} | ${outcome.how} | ` +
          `${seconds(outcome.seconds, outcome.note)} | ` +
          `${outcome.moved.length === 0 ? "none" : outcome.moved.map((moved) => `${moved.application} ${String(moved.before)}→${String(moved.after)}`).join(", ")} |`,
      );
    }
  }
  return [
    `## 6. Restart`,
    ``,
    `One node restarted, then killed and started again. "seconds" is until it`,
    `served every application again; "ports moved" names any application that did`,
    `not come back on the public port it held.`,
    ``,
    `| cell | node | how | seconds | ports moved |`,
    `| --- | --- | --- | ---: | --- |`,
    ...rows,
    ``,
  ];
}

function resourceTable(cells: CellMeasurement[]): string[] {
  const rows: string[] = [];
  for (const cell of cells) {
    for (const phase of PHASES) {
      const byNode = cell.resources[phase];
      if (byNode === undefined) continue;
      const entries = Object.values(byNode);
      if (entries.length === 0) continue;
      rows.push(
        `| ${name(cell)} | ${phase} | ${String(entries.reduce((total, entry) => total + entry.samples, 0))} | ` +
          `${mib(peak(entries, (entry) => entry.peakMemoryBytes))} | ` +
          `${round(mean(entries, (entry) => entry.meanCpuPercent))}% | ` +
          `${round(peak(entries, (entry) => entry.peakCpuPercent))}% |`,
      );
    }
  }
  return [
    `## Resources per phase`,
    ``,
    `Every node container, sampled every two seconds. Memory is the highest a node`,
    `container reached; CPU is across the node containers of the cell, where 100%`,
    `is one core.`,
    ``,
    `| cell | phase | samples | peak memory | mean cpu | peak cpu |`,
    `| --- | --- | ---: | ---: | ---: | ---: |`,
    ...rows,
    ``,
    `| cell | node | OOM-killed | engine restarts |`,
    `| --- | --- | --- | ---: |`,
    ...cells.flatMap((cell) =>
      cell.containers.map(
        (entry) =>
          `| ${name(cell)} | ${entry.node} | ${entry.oomKilled ? "YES" : "no"} | ${String(entry.restarts)} |`,
      ),
    ),
    ``,
  ];
}

function findings(cells: CellMeasurement[], aborted: AbortedCell[]): string[] {
  const found = [
    ...aborted.map((entry) => `- ${entry.cell}: the cell ended early — ${entry.error}`),
    ...cells.flatMap((cell) => cell.findings.map((line) => `- ${name(cell)}: ${line}`)),
  ];
  return [
    `## Findings`,
    ``,
    ...(found.length === 0
      ? [
          `Nothing was OOM-killed, no deadline was missed, no deploy failed and no`,
          `application changed public port.`,
        ]
      : found),
    ``,
  ];
}

function raw(cells: CellMeasurement[]): string[] {
  return [
    `<details><summary>Raw per-cell measurements</summary>`,
    ``,
    "```json",
    JSON.stringify(cells, null, 2),
    "```",
    ``,
    `</details>`,
    ``,
  ];
}

/* ----------------------------------------------------------------- numbers */

function name(cell: CellMeasurement): string {
  return `${cell.profile} @ ${String(cell.latencyMs)}ms`;
}

function seconds(value: number | null, note?: string): string {
  if (value === null) return note === undefined ? "—" : "did not converge (deadline)";
  return value.toFixed(1);
}

function ms(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${String(Math.round(value))}ms` : `${(value / 1000).toFixed(1)}s`;
}

function failures(list: Array<{ application: string; code: string }>): string {
  if (list.length === 0) return "none";
  const counted = new Map<string, number>();
  for (const failure of list) counted.set(failure.code, (counted.get(failure.code) ?? 0) + 1);
  return [...counted].map(([code, times]) => `${String(times)}× \`${code}\``).join(", ");
}

function peak(entries: PhaseResources[], of: (entry: PhaseResources) => number): number {
  return Math.max(0, ...entries.map(of));
}

function mean(entries: PhaseResources[], of: (entry: PhaseResources) => number): number {
  if (entries.length === 0) return 0;
  return entries.reduce((total, entry) => total + of(entry), 0) / entries.length;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function mib(value: number): string {
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function gib(value: number): string {
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
