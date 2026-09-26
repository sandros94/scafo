/*
 * Internal: what this node knows about the processes it supervises, and how
 * long it waits before starting one again.
 *
 * THE SUPERVISOR RESTARTS AND SAYS NOTHING; this is what remembers. It is told
 * of every start, every stop the daemon asked for, every exit it did not, and
 * the one moment each run answers for itself — and it holds, in memory and per
 * application, when the current process started, whether it has become ready,
 * the exits behind it, and the last lines the process wrote to stderr. From
 * that, `core/placement/process-health.ts` says whether the process is serving
 * or being restarted, and every operator surface reports the same word.
 *
 * READINESS COMES FROM OUTSIDE. Nothing here probes anything: the reconcile loop
 * asks the runtime driver, once per pass and only of a process that has not
 * answered yet, and tells this tracker with {@link ProcessHealthTracker.ready}.
 *
 * IT DECIDES NOTHING ABOUT CELLD'S STATE. A crash-looping process keeps being
 * restarted; what changes is that the node stops claiming to serve it, says so
 * in its record, and waits longer between tries.
 */

import {
  appendExit,
  failingSinceMs,
  isCrashLooping,
  isProcessReady,
  type ProcessHealth,
  type ProcessHealthRecord,
  processHealth,
  restartDelayMs,
  restartStreak,
} from "../core/placement/process-health.ts";
import type { NodeFailing } from "../core/types/registry.ts";
import type { ProcessStatus } from "../core/types/supervisor.ts";

/**
 * How much of a process's last error a NODE RECORD carries.
 *
 * One line, cut short. The record is read by every node of the installation on
 * every refresh and by every operator asking about the fleet, so what it holds
 * is the sentence that says which failure this is — the rest of the tail stays
 * on the node that has it, behind `GET /v1/state`.
 */
export const NODE_FAILING_ERROR_MAX: number = 200;

/** One supervised process as an operator surface reports it. */
export interface ProcessHealthView {
  application: string;
  health: ProcessHealth;
  /** Whether the run now going has answered its own health endpoint. */
  ready: boolean;
  /** When it did, ISO-8601; absent until it has. */
  readyAt?: string;
  /** Exits in a row with no run between them that served; zero for a fresh process. */
  restarts: number;
  /** The last exit, when there has been one. */
  lastExit?: { code: number | null; signal?: string; at: string };
  /** The last lines the process wrote to stderr, oldest first, never parsed. */
  lastError?: string[];
  /** When the process now running started; absent while none runs. */
  startedAt?: string;
  /** When a start is held back until, while it is being backed off. */
  retryAt?: string;
}

export interface ProcessHealthTracker {
  /** Told that a process has just been started under this application's name. */
  started(application: string): void;
  /**
   * Told that the process running under this name has answered its own health
   * endpoint. Idempotent, and ignored for an application with nothing running:
   * readiness belongs to ONE run, and the run it belongs to is the current one.
   */
  ready(application: string): void;
  /**
   * The applications whose current run has answered. What a node may publish as
   * served, minus whatever is crash-looping.
   */
  readyApplications(): ReadonlySet<string>;
  /**
   * Told that the daemon stopped this process on purpose — a retirement, a
   * reassignment, a drain. Its history goes with it: a process that was stopped
   * and later placed here again is a new process, not a restart.
   */
  stopped(application: string): void;
  /** Told of an exit the supervisor did not initiate. */
  exited(status: ProcessStatus): void;
  /** Whether a start may go ahead now, or is still being backed off. */
  mayStart(application: string): boolean;
  /** The applications whose process is crash-looping right now. */
  crashLooping(): ReadonlySet<string>;
  /** Every supervised process, by application name. */
  views(): Record<string, ProcessHealthView>;
  /** The compact map a node record carries, or undefined when nothing is failing. */
  failing(): NodeFailing | undefined;
}

export interface ProcessHealthOptions {
  /** The clock. Defaults to the system one. */
  now?: () => Date;
  /** The jitter a restart wait is drawn with; injectable for a test that fixes it. */
  jitter?: (windowMs: number) => number;
  /** Where the two transition lines go. Defaults to stderr. */
  log?: (message: string) => void;
}

/** Builds the tracker one node keeps for its own processes. */
export function createProcessHealth(opts: ProcessHealthOptions = {}): ProcessHealthTracker {
  const now = opts.now ?? ((): Date => new Date());
  const log =
    opts.log ??
    ((message: string): void => {
      console.error(message);
    });

  const records = new Map<string, Tracked>();
  /* What the log has already been told is looping, so a crash loop is one line
     when it starts and one when it ends, never one per restart. */
  const announced = new Set<string>();

  /**
   * Re-reads every record and logs what CHANGED: one line when a process begins
   * crash-looping and one when it answers again, never one per restart.
   *
   * Called by every read and by {@link ProcessHealthTracker.ready} rather than on
   * a timer of its own; it takes no clock, because every transition it reports is
   * an event somebody told this tracker about.
   */
  function refresh(): void {
    for (const [application, tracked] of records) {
      const looping = isCrashLooping(tracked);
      if (looping === announced.has(application)) continue;

      if (looping) {
        announced.add(application);
        log(
          `scafo: "${application}" is crash-looping: ${String(restartStreak(tracked))} ` +
            `exits in a row, none of them after a ` +
            `run that became ready; this node has stopped publishing it as served` +
            errorSuffix(tracked),
        );
      } else {
        announced.delete(application);
        log(`scafo: "${application}" is answering again and is published as served once more`);
      }
    }
    /* An application that is no longer tracked cannot recover; it left. */
    for (const application of announced) {
      if (!records.has(application)) announced.delete(application);
    }
  }

  function tracked(application: string): Tracked {
    const found = records.get(application);
    if (found !== undefined) return found;

    const made: Tracked = { application, exits: [], lastError: [] };
    records.set(application, made);
    return made;
  }

  return {
    started(application: string): void {
      const record = tracked(application);
      record.startedAtMs = now().getTime();
      /* A new run has answered nothing yet, whatever the one before it did. */
      delete record.readyAtMs;
      /* The wait is over the moment the start goes through; the next exit sets
         a new one. */
      delete record.retryAtMs;
    },

    ready(application: string): void {
      const record = records.get(application);
      /* Told of a process that is not running, or told twice: the first is a
         probe that raced a stop, the second is a pass asking about a run this
         one already answered for. */
      if (record?.startedAtMs === undefined || record.readyAtMs !== undefined) return;

      record.readyAtMs = now().getTime();
      /* The moment a crash loop ends is this one, so it is said here rather than
         at whichever read happens to come next. */
      refresh();
    },

    readyApplications(): ReadonlySet<string> {
      const ready = new Set<string>();
      for (const [application, record] of records) {
        if (isProcessReady(record)) ready.add(application);
      }
      return ready;
    },

    stopped(application: string): void {
      records.delete(application);
      announced.delete(application);
    },

    exited(status: ProcessStatus): void {
      const record = tracked(status.id);
      const atMs = now().getTime();

      appendExit(
        record,
        {
          atMs,
          /* THE WHOLE VERDICT RESTS ON THIS: a run that never answered is the
             same failure as the one before it, however long it took to give up. */
          wasReady: isProcessReady(record),
          code: status.exitCode ?? null,
          ...(status.exitSignal === undefined ? {} : { signal: status.exitSignal }),
        },
        MAX_EXITS,
      );

      delete record.startedAtMs;
      delete record.readyAtMs;
      if (status.lastError !== undefined) record.lastError = [...status.lastError];
      /* Drawn ONCE, here, rather than at every pass that asks: a deadline
         redrawn each time would move under the pass that is waiting for it. */
      record.retryAtMs =
        atMs +
        restartDelayMs(
          restartStreak(record),
          opts.jitter === undefined ? {} : { jitter: opts.jitter },
        );
      refresh();
    },

    mayStart(application: string): boolean {
      const record = records.get(application);
      if (record?.retryAtMs === undefined) return true;
      return now().getTime() >= record.retryAtMs;
    },

    crashLooping(): ReadonlySet<string> {
      refresh();

      const looping = new Set<string>();
      for (const [application, record] of records) {
        if (isCrashLooping(record)) looping.add(application);
      }
      return looping;
    },

    views(): Record<string, ProcessHealthView> {
      refresh();

      const views: Record<string, ProcessHealthView> = {};
      for (const [application, record] of records) views[application] = viewOf(record);
      return views;
    },

    failing(): NodeFailing | undefined {
      refresh();

      const failing: NodeFailing = {};
      for (const [application, record] of records) {
        if (!isCrashLooping(record)) continue;

        const since = failingSinceMs(record);
        const first = record.lastError[0];
        failing[application] = {
          since: new Date(since ?? now().getTime()).toISOString(),
          restarts: restartStreak(record),
          ...(first === undefined ? {} : { lastError: truncate(first) }),
        };
      }
      return Object.keys(failing).length === 0 ? undefined : failing;
    },
  };
}

/* ---------------------------------------------------------------- internals */

/** One record, plus the restart deadline the tracker holds it to. */
interface Tracked extends ProcessHealthRecord {
  /** Epoch ms before which a start of this application waits. */
  retryAtMs?: number;
}

/**
 * How many exits one process's history holds: enough to read a streak from,
 * and small enough that a process looping for a week costs nothing. The
 * streak's own start and length are kept beside it, so neither is clipped.
 */
const MAX_EXITS = 20;

function viewOf(record: Tracked): ProcessHealthView {
  const last = record.exits.at(-1);
  return {
    application: record.application,
    health: processHealth(record),
    ready: isProcessReady(record),
    ...(record.readyAtMs === undefined
      ? {}
      : { readyAt: new Date(record.readyAtMs).toISOString() }),
    restarts: restartStreak(record),
    ...(last === undefined
      ? {}
      : {
          lastExit: {
            code: last.code,
            ...(last.signal === undefined ? {} : { signal: last.signal }),
            at: new Date(last.atMs).toISOString(),
          },
        }),
    ...(record.lastError.length === 0 ? {} : { lastError: [...record.lastError] }),
    ...(record.startedAtMs === undefined
      ? {}
      : { startedAt: new Date(record.startedAtMs).toISOString() }),
    ...(record.retryAtMs === undefined
      ? {}
      : { retryAt: new Date(record.retryAtMs).toISOString() }),
  };
}

/** The last thing the process said, appended to the line that reports the loop. */
function errorSuffix(record: ProcessHealthRecord): string {
  const first = record.lastError[0];
  return first === undefined ? "" : ` — it last said: ${truncate(first)}`;
}

function truncate(line: string): string {
  return line.length > NODE_FAILING_ERROR_MAX ? `${line.slice(0, NODE_FAILING_ERROR_MAX)}…` : line;
}
