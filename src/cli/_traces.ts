/*
 * Internal: picking events out of what a fleet flushed, and printing them.
 *
 * ONE LINE PER EVENT, AND THE LINE IS DERIVED. Every event carries its moment,
 * its node and its type; everything else is that variant's own fields, and they
 * are rendered as they were written rather than through a per-type formatter.
 * That is deliberate — the event union grows, and a renderer that had to be
 * taught each new variant would silently print the OLD fields of a new event,
 * which is the one failure a trace reader cannot recover from.
 *
 */

import {
  eventRecords,
  type ObserveEventRecord,
  type ObserveRecord,
} from "../daemon/observe-records.ts";
import { parseProcessId } from "../core/placement/ids.ts";

/** Events a listing shows when the caller states no limit. */
export const DEFAULT_TRACE_LIMIT: number = 200;

/**
 * What a node emits on its own timer rather than because something happened.
 *
 * The reconcile loop runs every 5s whether or not the fleet is doing anything,
 * so these two arrive at a fixed rate forever — hundreds of them in the window a
 * default listing shows, and the LAST hundreds, which is what pushes out the
 * deployment and operator events a reader opened `scafo traces` for.
 * Nothing else in the catalog is periodic: everything else is a thing a person
 * or a request asked for.
 *
 * Hidden by default and never dropped — `--all` shows them, and how many were
 * held back is reported either way.
 */
export const PERIODIC_EVENTS: readonly ObserveEventRecord["type"][] = [
  "reconcile.pass.start",
  "reconcile.pass.end",
];

/** What a filter picked out of a window. */
export interface TraceSelection {
  /** The events shown, oldest first. */
  events: ObserveEventRecord[];
  /** Events the filter matched, before the limit was applied. */
  matched: number;
  /** Events the limit left out; they are the OLDEST, so the newest are shown. */
  omitted: number;
  /**
   * Events left out for being {@link PERIODIC_EVENTS}. Reported rather than
   * implied, because they are events the node really did record.
   */
  hidden: number;
}

export interface TraceFilter {
  /** Only what belongs to this project. */
  project?: string;
  /** Events shown at most. Defaults to {@link DEFAULT_TRACE_LIMIT}. */
  limit?: number;
  /**
   * Show every kind, {@link PERIODIC_EVENTS} included. Off by default, which is
   * what makes an unnarrowed listing readable.
   */
  all?: boolean;
}

/**
 * The events a filter selects, oldest first.
 *
 * The limit keeps the NEWEST, because a reader looking at a window is looking at
 * what just happened; how many were left out is reported rather than implied.
 *
 * THE PERIODIC EVENTS ARE TAKEN OUT BEFORE THE LIMIT IS, and that order is the
 * point: they arrive at a fixed rate forever, so counting them against the limit
 * spends the whole window on the loop's own housekeeping and leaves a reader
 * looking at the last two minutes of a node doing nothing. `--all` puts them
 * back, and {@link TraceSelection.hidden} says how many there were either way.
 *
 * `--project` reaches a directly named project and a runtime event through the
 * process id, which encodes the project by convention. Events about the node
 * itself — a reconcile pass — belong to no project and are left out.
 */
export function selectTraces(
  records: readonly ObserveRecord[],
  filter: TraceFilter = {},
): TraceSelection {
  const events = eventRecords(records);
  const limit = Math.max(1, filter.limit ?? DEFAULT_TRACE_LIMIT);

  let hidden = 0;
  const matched = events.filter((event) => {
    if (filter.project !== undefined && !belongsTo(event, filter.project)) return false;

    if (filter.all !== true && PERIODIC_EVENTS.includes(event.type)) {
      hidden++;
      return false;
    }
    return true;
  });

  return {
    events: matched.slice(Math.max(0, matched.length - limit)),
    matched: matched.length,
    omitted: Math.max(0, matched.length - limit),
    hidden,
  };
}

/** One event as a line: when, where, what, and what it carried. */
export function formatTraceLine(event: ObserveEventRecord, widths?: TraceWidths): string {
  const node = widths === undefined ? event.node : event.node.padEnd(widths.node);
  const type = widths === undefined ? event.type : event.type.padEnd(widths.type);
  return `${event.at}  ${node}  ${type}  ${fields(event).join(" ")}`.trimEnd();
}

/** Column widths a listing aligns on, so the fields of every line start together. */
export interface TraceWidths {
  node: number;
  type: number;
}

/** The whole listing, one line per event. */
export function formatTraces(selection: TraceSelection): string {
  const widths: TraceWidths = {
    node: Math.max(...selection.events.map((event) => event.node.length), 0),
    type: Math.max(...selection.events.map((event) => event.type.length), 0),
  };
  return selection.events.map((event) => formatTraceLine(event, widths)).join("\n");
}

/* ------------------------------------------------------------------ internal */

/** What every event carries, and what a line therefore renders on its own. */
const RENDERED_APART = new Set(["v", "record", "node", "at", "type"]);

/** The fields this variant added, as `key=value`, in the order they were written. */
function fields(event: ObserveEventRecord): string[] {
  const rendered: string[] = [];
  for (const [name, value] of Object.entries(event)) {
    if (RENDERED_APART.has(name)) continue;
    rendered.push(`${name}=${String(value)}`);
  }
  return rendered;
}

/** Whether an event is this project's: by name or by its process id. */
function belongsTo(event: ObserveEventRecord, project: string): boolean {
  if ("project" in event) return event.project === project;
  if ("processId" in event) return parseProcessId(event.processId)?.project === project;
  return false;
}
