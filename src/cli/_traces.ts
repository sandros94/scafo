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
 * A WAKE ID IS THE THREAD THROUGH EVERYTHING. `x-scafo-wake` is on every answer
 * the wake surface gives, whether it served, held, refused or 404'd, so a
 * caller's failed request, the ingress's log line and this node's own account of
 * it share one id. `--wake` is therefore the reader that matters: it takes that
 * id off a response header and lays out what the node did about it, in order and
 * with the gaps between the steps visible.
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
 * deploy, wake, rollout and gate events a reader opened `scafo traces` for.
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
  /** One request's id, as `x-scafo-wake` carries it. */
  wake?: string;
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
 * `--project` reaches an event three ways, and it has to: a wake event names its
 * project only where the Host was resolved (`wake.admitted`), so the rest of that
 * request is found through its ID, and a rollout or a gate is found through the
 * PROCESS ID it names, which encodes the project by convention. Events about the
 * node itself — a reconcile pass — belong to no project and are left out.
 */
export function selectTraces(
  records: readonly ObserveRecord[],
  filter: TraceFilter = {},
): TraceSelection {
  const events = eventRecords(records);
  const limit = Math.max(1, filter.limit ?? DEFAULT_TRACE_LIMIT);

  const wakes = new Set<string>();
  if (filter.project !== undefined) {
    for (const event of events) {
      if (event.type === "wake.admitted" && event.project === filter.project) wakes.add(event.id);
    }
  }

  let hidden = 0;
  const matched = events.filter((event) => {
    if (filter.wake !== undefined && wakeId(event) !== filter.wake) return false;
    if (filter.project !== undefined && !belongsTo(event, filter.project, wakes)) return false;

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

/**
 * One request's timeline: what the node did about it, offset from the first
 * thing it did.
 *
 * The offsets are what the layout is for. A wake is a sequence of waits — the
 * bucket resolving the Host, the stamp landing, the process coming up — and
 * which of them took the time is the whole question; absolute timestamps make a
 * reader do that subtraction in their head.
 */
export function formatWakeTimeline(id: string, events: readonly ObserveEventRecord[]): string {
  if (events.length === 0) {
    return (
      `scafo: nothing recorded for wake "${id}" in this window — widen --since, or check that ` +
      `the node that answered the request had "observability.enabled" on`
    );
  }

  const startMs = Date.parse(events[0].at);
  const endMs = Date.parse(events.at(-1)?.at ?? events[0].at);
  const nodes = [...new Set(events.map((event) => event.node))].sort();
  const offsets = events.map((event) => `+${String(Date.parse(event.at) - startMs)}ms`);
  const width = Math.max(...offsets.map((offset) => offset.length));
  const typeWidth = Math.max(...events.map((event) => event.type.length));

  const header =
    `scafo: wake "${id}" on ${nodes.join(", ")}, ${String(events.length)} event(s) over ` +
    `${String(endMs - startMs)}ms, starting ${events[0].at}`;
  const lines = events.map(
    (event, index) =>
      `  ${offsets[index].padStart(width)}  ${event.type.padEnd(typeWidth)}  ` +
      `${fields(event).join(" ")}`.trimEnd(),
  );
  return [header, ...lines].join("\n");
}

/* ------------------------------------------------------------------ internal */

/** What every event carries, and what a line therefore renders on its own. */
const RENDERED_APART = new Set(["v", "record", "node", "at", "type", "id"]);

/** The fields this variant added, as `key=value`, in the order they were written. */
function fields(event: ObserveEventRecord): string[] {
  const rendered: string[] = [];
  const id = wakeId(event);
  /* First, because it is the thread a reader follows between lines. */
  if (id !== null) rendered.push(`id=${id}`);

  for (const [name, value] of Object.entries(event)) {
    if (RENDERED_APART.has(name)) continue;
    rendered.push(`${name}=${String(value)}`);
  }
  return rendered;
}

/** The wake this event belongs to, or null when it belongs to none. */
function wakeId(event: ObserveEventRecord): string | null {
  return "id" in event ? event.id : null;
}

/** Whether an event is this project's: by name, by its wake, or by its process id. */
function belongsTo(
  event: ObserveEventRecord,
  project: string,
  wakes: ReadonlySet<string>,
): boolean {
  if ("project" in event) return event.project === project;

  const id = wakeId(event);
  if (id !== null) return wakes.has(id);
  if ("processId" in event) return parseProcessId(event.processId)?.project === project;
  return false;
}
