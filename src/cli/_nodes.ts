/*
 * Internal: the machines. What `scafo fleet nodes` reads and how it prints.
 *
 * STRAIGHT OUT OF THE BUCKET, and deliberately not through a node. Every other
 * question about an installation is best asked of a node, because a node knows
 * things the registry does not; this one is the opposite. "Which machines are
 * there, and which of them are still answering?" is exactly the question an
 * operator asks when a node is NOT answering, and routing it through one of the
 * machines being asked about would make the failure case the case it cannot
 * serve.
 *
 * Liveness is read the same way placement reads it — the freshness of what each
 * node last wrote about itself — so what this prints is what the coordinator
 * will act on, rather than a second opinion about it.
 */

import type { RegistryContext } from "../core/registry/context.ts";
import { isNodeLive, listNodeRecords, NODE_LIVENESS_WINDOW_MS } from "../core/registry/nodes.ts";
import type {
  FreezeRecord,
  NodeFailing,
  NodeRecord,
  NodeVersions,
} from "../core/types/registry.ts";
import { formatLabels } from "../core/utils/labels.ts";
import { compareVersions } from "../drivers/runtime/celld.ts";
import { describeFreezeLine } from "./_fleet.ts";

/**
 * What a node is, for placement.
 *
 * `draining` is its own state rather than a flavour of `lost` because the two
 * mean opposite things about the operator's day: a draining node said it was
 * leaving and is doing so in order, while a lost one stopped saying anything.
 *
 * `degraded` is a LIVE node that cannot keep one of its applications running.
 * It is said here rather than left to the application's own listing because of
 * what the failure looks like from outside: the machine answers, it heartbeats,
 * it is a placement candidate and it is serving everything else — and the one
 * application whose process exits every few seconds is invisible in every one
 * of those facts. A node that says `live` while it is dropping a tenant's
 * traffic is the sentence this state exists to stop being printed.
 */
export type NodeState = "live" | "degraded" | "draining" | "lost";

/** One node as this listing reads it. */
export interface NodeListing {
  id: string;
  state: NodeState;
  /** Last sign of life the record carries, when it carries one. */
  seenAt?: string;
  /** Where its peers reach it, and the port its daemon answers on. */
  internal: string;
  apiPort: number;
  /** What the operator said this machine IS, as an application's selector matches it. */
  labels: Record<string, string>;
  /** The binaries its daemon booted with. Absent on a record written before they were kept. */
  versions?: NodeVersions;
  /** When it said it was leaving. Only ever set on a `draining` node. */
  drainingAt?: string;
  /** What it says it cannot keep running, as its own record reports it. */
  failing?: NodeFailing;
}

/** Every registered node, in id order, judged against `now`. */
export async function listFleetNodes(
  ctx: RegistryContext,
  opts: { now?: Date } = {},
): Promise<NodeListing[]> {
  const now = opts.now ?? ctx.now?.() ?? new Date();
  return (await listNodeRecords(ctx)).map((record) => readNode(record, now));
}

/** One record as the listing reads it. Pure, so the caller decides what "now" is. */
export function readNode(record: NodeRecord, now: Date): NodeListing {
  const seenAt = record.heartbeatAt;
  const failing = record.failing;
  const degraded = failing !== undefined && Object.keys(failing).length > 0;

  return {
    id: record.id,
    state:
      record.drainingAt !== undefined
        ? "draining"
        : !isNodeLive(record, now)
          ? "lost"
          : degraded
            ? "degraded"
            : "live",
    ...(seenAt === undefined ? {} : { seenAt }),
    internal: record.addresses.internal,
    apiPort: record.addresses.apiPort,
    labels: record.labels ?? {},
    ...(record.versions === undefined ? {} : { versions: record.versions }),
    ...(record.drainingAt === undefined ? {} : { drainingAt: record.drainingAt }),
    ...(degraded ? { failing } : {}),
  };
}

/**
 * The listing as an operator reads it: one row per machine, and a header saying
 * how many of them are still counted in.
 *
 * The COUNT is the line worth having. An operator running this is usually asking
 * "is the fleet the size I think it is?", and answering that by making them
 * count rows would be answering a different question.
 */
export function formatNodeTable(
  nodes: NodeListing[],
  now: Date = new Date(),
  freeze: FreezeRecord | null = null,
): string {
  if (nodes.length === 0) {
    return (
      `scafo: no node is registered in this bucket; a machine joins the fleet by running ` +
      `"scafo sail"`
    );
  }

  /* A degraded node is still live for placement, and is counted as one: what
     it is not is a node that can be assumed to be serving everything it holds,
     which the block under the table is for. */
  const live = nodes.filter((node) => node.state === "live" || node.state === "degraded").length;
  const degraded = nodes.filter((node) => node.state === "degraded");
  const rows = nodes.map((node) => [
    node.id,
    node.state,
    describeSeen(node.seenAt, now),
    `${node.internal}:${String(node.apiPort)}`,
    node.versions?.celld ?? UNREPORTED,
    node.versions?.scafo ?? UNREPORTED,
    /* Last, because it is the ragged column: anything after it would be a
       different distance from the left on every row. */
    formatLabels(node.labels),
  ]);
  const head = ["NODE", "STATE", "SEEN", "API", "CELLD", "SCAFO", "LABELS"];
  const width = head.map((_, column) =>
    Math.max(...[head, ...rows].map((row) => (row[column] as string).length)),
  );

  const lines = [
    `scafo: ${String(nodes.length)} node${nodes.length === 1 ? "" : "s"}, ${String(live)} live` +
      (degraded.length === 0 ? "" : `, ${String(degraded.length)} degraded`) +
      ` (a node counts as live for ${String(NODE_LIVENESS_WINDOW_MS / 1000)}s after it last ` +
      `said so)`,
    /* Above the version rolls, because a frozen fleet is usually a fleet part
       way through the upgrade those rolls are measuring. */
    ...(freeze === null ? [] : [describeFreezeLine(freeze)]),
    formatVersionRoll("celld", nodes, (versions) => versions.celld),
    formatVersionRoll("scafo", nodes, (versions) => versions.scafo),
    "",
    ...[head, ...rows].map((row) => `  ${row.map(pad(width)).join("  ").trimEnd()}`),
    ...describeDegraded(degraded),
  ];
  return lines.join("\n");
}

/**
 * What a degraded node cannot keep running, beneath the table: one line per
 * application, with how often it has been restarted and the last thing it said.
 *
 * SAID IN FULL RATHER THAN COUNTED. "1 degraded" in the header tells an operator
 * to go looking; the whole point of carrying this in the node record is that
 * they do not have to, and that the machine they would have to log into is the
 * one that is failing.
 */
function describeDegraded(nodes: NodeListing[]): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    const failing = Object.entries(node.failing ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
    if (failing.length === 0) continue;

    lines.push(
      "",
      `  ${node.id} cannot keep ${String(failing.length)} ` +
        `application${failing.length === 1 ? "" : "s"} running:`,
    );
    for (const [application, failure] of failing) {
      lines.push(
        `    ${application}  ${String(failure.restarts)} restart` +
          `${failure.restarts === 1 ? "" : "s"} since ${failure.since}` +
          (failure.lastError === undefined ? "" : `: ${failure.lastError}`),
      );
    }
  }
  return lines;
}

/* ---------------------------------------------------------------- internals */

/** What a node that has not said which binaries it runs reads as, in a cell and in a roll. */
const UNREPORTED = "-";

/**
 * One binary's spread over the fleet, newest first: `celld: 0.5.0 on 2 nodes,
 * 0.4.1 on 1`.
 *
 * WHICH MACHINES STILL RUN THE OLD BINARY IS THE QUESTION THIS ANSWERS. An
 * installation is upgraded by stopping every node and starting the new ones, or
 * one node at a time between a rolling pair of Celld releases upstream declared,
 * so a second version in this line is work left to do: the column below says
 * which machine it is, and this says how much of the fleet is waiting on it.
 * Newest first, because that is the half that is done. A record from a build
 * older than the field itself counts as `unreported` rather than as a version,
 * since nothing in it says one.
 */
function formatVersionRoll(
  label: string,
  nodes: NodeListing[],
  of: (versions: NodeVersions) => string,
): string {
  const counts = new Map<string, number>();
  let unreported = 0;
  for (const node of nodes) {
    if (node.versions === undefined) unreported += 1;
    else {
      const version = of(node.versions);
      counts.set(version, (counts.get(version) ?? 0) + 1);
    }
  }

  const spread = [...counts].sort(([a], [b]) => compareVersions(b, a));
  if (unreported > 0) spread.push(["unreported", unreported]);

  /* The noun is said once, on the first count; the rest are bare numbers, so a
     line about six versions still reads as one sentence. */
  const parts = spread.map(([name, count], index) =>
    index === 0
      ? `${name} on ${String(count)} node${count === 1 ? "" : "s"}`
      : `${name} on ${String(count)}`,
  );
  return `${label}: ${parts.join(", ")}`;
}

function pad(width: number[]): (cell: string, column: number) => string {
  return (cell, column) => cell.padEnd(width[column] as number);
}

/**
 * How long ago a node was last seen, in the largest unit that still says
 * something. A record with no sign of life at all reads as `never`, which is
 * exactly what it means: nothing in it says when that machine was last up.
 */
function describeSeen(seenAt: string | undefined, now: Date): string {
  if (seenAt === undefined) return "never";

  const seen = Date.parse(seenAt);
  if (!Number.isFinite(seen)) return seenAt;

  const seconds = Math.max(0, Math.round((now.getTime() - seen) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h ago`;
  return `${String(Math.floor(seconds / 86_400))}d ago`;
}
