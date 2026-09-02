/* Selects persisted events and renders each variant's recorded fields. */

import {
  eventRecords,
  type ObserveEventRecord,
  type ObserveRecord,
} from "../daemon/observe-records.ts";
import { parseProcessId } from "../core/placement/ids.ts";

/** Events a listing shows when the caller states no limit. */
export const DEFAULT_TRACE_LIMIT: number = 200;

/** Timer-generated events, hidden by default but included by `--all`. */
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

/** Selects oldest-first events. Periodic events are removed before the newest-
    preserving limit unless `--all` is requested. */
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
