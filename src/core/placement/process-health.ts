/*
 * Whether a supervised runtime process is actually serving, or only being
 * started over and over.
 *
 * WHY THIS LIVES BESIDE `serving.ts`. A node publishes what it serves from the
 * processes it holds, and the fleet's routing is rendered from that. A process
 * that exits every few seconds is held, and is published, and answers nothing:
 * the ingress routes to a port that is dead more often than it is alive, and
 * every operator surface says the application is fine. The verdict below is what
 * separates a process that is serving from one that is being restarted, and it
 * is the same verdict `serving.ts` filters by and the node record reports.
 *
 * UPTIME IS NOT READINESS, and that is the whole of what this measures a run by.
 * A Celld process that can never become ready — one retrying a node lease the
 * store will not hand over — stays up for as long as it takes to give up, exits,
 * and is started again: judged by how long it ran, every one of those runs
 * "lasted", so nothing was ever a loop, the node stayed live, and the dead port
 * stayed in the routing every ingress reads. A run counts for something only once
 * the process has ANSWERED ITS OWN HEALTH ENDPOINT, which is the one signal that
 * says requests sent there will be served.
 *
 * ONCE, AND THEN TRUSTED. Readiness is asked of a process until it answers and
 * never again: a run that answered is a run that is serving until it exits, and
 * an ingress with its own health checks is what notices anything in between. So
 * nothing here is a liveness check and nothing here has a timer — a process that
 * has not become ready yet is `starting`, however long it has been at it, and
 * only its EXITS ever add up to a verdict.
 *
 * SCAFO REPORTS, AND NEVER REPAIRS. Nothing here restarts, kills, or edits
 * anything: it reads the exits a supervisor observed and says what they add up
 * to. What to do about it is the operator's, and what a runtime does about its
 * own state is Celld's.
 */

import { jitteredDelayMs } from "../utils/backoff.ts";

/**
 * How many exits IN A ROW, none of them after a run that became ready, make a
 * crash loop.
 *
 * THREE, because two is a coincidence an operator does not need to hear about:
 * a process that dies, comes back and dies again may well be a deploy landing
 * or a machine under load, and the second exit is the first evidence of a
 * pattern rather than the pattern itself. A third in a row is no longer an
 * accident.
 *
 * IN A ROW, NOT INSIDE A TIME WINDOW. The wait between restarts grows to a minute
 * ({@link RESTART_BACKOFF_MAX_MS}), so a loop that has slowed down exits about
 * once every seventy seconds: counted inside any window short enough to mean
 * "recently", it would stop being a loop the moment the backoff did its job, and
 * the node would publish the process as served again. A streak has no clock to
 * outrun — only a run that became ready ends it.
 */
export const CRASH_LOOP_EXITS: number = 3;

/** One exit a supervisor observed, and whether the run before it ever served. */
export interface ProcessExit {
  /** When the process exited, epoch milliseconds. */
  atMs: number;
  /**
   * Whether the run that ended here had answered its own health endpoint.
   *
   * THE ONE THING THAT MAKES AN EXIT FORGIVABLE. A run that served and then died
   * is a new event — a deploy, a signal, a machine under load — and it ends the
   * streak behind it. A run that never answered is the same failure as the one
   * before it, whether it took five seconds to give up or ten minutes.
   */
  wasReady: boolean;
  /** Its exit code, or null when a signal ended it. */
  code: number | null;
  /** The signal that ended it, when one did. */
  signal?: string;
}

/** What a node knows about one supervised process, as the tracker keeps it. */
export interface ProcessHealthRecord {
  /** The application whose process this is; its supervisor id is the same name. */
  application: string;
  /** When the process now running started, epoch milliseconds; absent while none runs. */
  startedAtMs?: number;
  /**
   * When the run now going answered its health endpoint, epoch milliseconds;
   * absent until it has, and cleared with every start and every exit.
   */
  readyAtMs?: number;
  /** Exits seen, oldest first, bounded by the tracker. */
  exits: ProcessExit[];
  /**
   * The streak the bounded history can no longer show whole: how many exits in a
   * row it has counted and when the first of them was. Kept by whoever appends
   * exits ({@link appendExit}); absent, the streak is read from `exits` alone.
   */
  streak?: { exits: number; sinceMs: number };
  /**
   * The last lines the process wrote to stderr, oldest first, as the supervisor
   * captured them. NEVER PARSED — they are quoted to an operator and nothing
   * here reads a meaning out of them.
   */
  lastError: string[];
}

/**
 * What an operator is told about one process, in the one set of words every
 * surface uses.
 *
 * `starting` is not a lesser `running`: it is a process nothing has answered for
 * yet, which is also what a process waiting for its restart reads as. A process
 * that stays `starting` without exiting is not a loop and is not reported as
 * failing — no verdict has been reached about it — but it is not published as
 * served either.
 */
export type ProcessHealth = "running" | "starting" | "crash-looping";

/**
 * Whether the run now going has answered its own health endpoint: the one thing
 * that says a request sent to its port will be served.
 */
export function isProcessReady(record: ProcessHealthRecord): boolean {
  return record.startedAtMs !== undefined && record.readyAtMs !== undefined;
}

/**
 * Whether the process is being restarted rather than serving: its last
 * {@link CRASH_LOOP_EXITS} exits or more came one after another with not one run
 * between them — the current one included — that ever became ready.
 *
 * Pure, and with no clock at all: readiness is an event rather than a duration.
 */
export function isCrashLooping(record: ProcessHealthRecord): boolean {
  if (neverReadyStreak(record).length < CRASH_LOOP_EXITS) return false;
  /* A process that came back and is answering has recovered, whatever the exits
     behind it say: it is serving again. */
  return !isProcessReady(record);
}

/** The health of one process, in the words every surface reports it with. */
export function processHealth(record: ProcessHealthRecord): ProcessHealth {
  if (isCrashLooping(record)) return "crash-looping";
  return isProcessReady(record) ? "running" : "starting";
}

/** How many exits in a row the process has had with no run between them that served. */
export function restartStreak(record: ProcessHealthRecord): number {
  return Math.max(record.streak?.exits ?? 0, neverReadyStreak(record).length);
}

/** When the run of exits behind a crash loop began, epoch ms, or undefined when there is none. */
export function failingSinceMs(record: ProcessHealthRecord): number | undefined {
  if (neverReadyStreak(record).length === 0) return undefined;
  return record.streak?.sinceMs ?? neverReadyStreak(record)[0]?.atMs;
}

/**
 * Appends one exit, keeping at most `keep` of them AND the streak's true start
 * and length: a process looping for a week holds a handful of exits, and still
 * says since when and how many times.
 */
export function appendExit(record: ProcessHealthRecord, exit: ProcessExit, keep: number): void {
  if (exit.wasReady) delete record.streak;
  else
    record.streak = {
      exits: (record.streak?.exits ?? 0) + 1,
      sinceMs: record.streak?.sinceMs ?? exit.atMs,
    };
  record.exits.push(exit);
  while (record.exits.length > keep) record.exits.shift();
}

/**
 * The first step of the wait between restarts, and the ceiling it grows to.
 *
 * THE FLOOR IS THE RECONCILE INTERVAL, because that is the cadence a restart
 * already happens at: a process that exits is started again by the next pass,
 * which on a default node is five seconds later, and a wedged process therefore
 * spawns a runtime, opens the bucket and fails twelve times a minute, forever.
 * The ceiling is a minute, which is short enough that a machine that recovers
 * comes back quickly and long enough that a loop costs the bucket almost
 * nothing.
 */
export const RESTART_BACKOFF_BASE_MS: number = 5_000;
export const RESTART_BACKOFF_MAX_MS: number = 60_000;

/**
 * How long to wait before starting a process again, given how many times it has
 * exited with nothing that served in between.
 *
 * Full jitter over a doubling window, the same draw the rest of the repo
 * retries on, so a node restarting several wedged applications does not restart
 * them all in the same second. A process with no such exits behind it waits
 * nothing: the first start of anything is immediate, and so is the one after a
 * run that served.
 */
export function restartDelayMs(
  exits: number,
  opts?: { jitter?: (windowMs: number) => number },
): number {
  if (exits <= 0) return 0;
  return jitteredDelayMs(exits - 1, {
    baseMs: RESTART_BACKOFF_BASE_MS,
    maxMs: RESTART_BACKOFF_MAX_MS,
    ...(opts?.jitter === undefined ? {} : { jitter: opts.jitter }),
  });
}

/* ---------------------------------------------------------------- internals */

/** The exits at the END of the history that no run which served interrupts, oldest first. */
function neverReadyStreak(record: ProcessHealthRecord): ProcessExit[] {
  let from = record.exits.length;
  while (from > 0 && !(record.exits[from - 1] as ProcessExit).wasReady) from -= 1;
  return record.exits.slice(from);
}
