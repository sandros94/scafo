/*
 * A process that keeps exiting without ever serving: the verdict, the backoff
 * between restarts, and what the node says about it.
 *
 * The predicate is pure and takes no clock at all, so a crash loop is reproduced
 * by stating what happened rather than by waiting for it.
 */

import { describe, expect, it } from "vitest";
import {
  CRASH_LOOP_EXITS,
  isCrashLooping,
  isProcessReady,
  type ProcessExit,
  type ProcessHealth,
  type ProcessHealthRecord,
  processHealth,
  RESTART_BACKOFF_BASE_MS,
  RESTART_BACKOFF_MAX_MS,
  restartDelayMs,
  appendExit,
  failingSinceMs,
  restartStreak,
} from "../src/core/placement/process-health.ts";
import { createProcessHealth } from "../src/daemon/_process-health.ts";
import type { ProcessStatus } from "../src/core/types/supervisor.ts";

const NOW = Date.parse("2026-09-20T12:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A record of a process that is running right now, with the exits behind it. */
function record(opts: {
  exits?: ProcessExit[];
  startedAgoMs?: number;
  /** How long ago the run now going answered its health endpoint, when it has. */
  readyAgoMs?: number;
  lastError?: string[];
}): ProcessHealthRecord {
  return {
    application: "shop",
    exits: opts.exits ?? [],
    lastError: opts.lastError ?? [],
    ...(opts.startedAgoMs === undefined ? {} : { startedAtMs: NOW - opts.startedAgoMs }),
    ...(opts.readyAgoMs === undefined ? {} : { readyAtMs: NOW - opts.readyAgoMs }),
  };
}

/** `count` exits, one every `everyMs`, of runs that never answered. */
function loop(count: number, opts: { everyMs?: number } = {}): ProcessExit[] {
  const everyMs = opts.everyMs ?? 15 * SECOND;
  return Array.from({ length: count }, (_unused, index) => ({
    atMs: NOW - (count - index) * everyMs,
    wasReady: false,
    code: 1,
  }));
}

/** One exit of a run that did answer before it ended. */
function served(atMs: number): ProcessExit {
  return { atMs, wasReady: true, code: 1 };
}

describe("the crash-loop verdict", () => {
  /*
   * The incident: a Celld process that could never become ready — it spent about
   * sixty seconds retrying an unreadable node lease, then exited 1, every time.
   * Judged by how long each run lasted, every one of them "lasted", so nothing
   * was ever a loop and the dead port stayed in the routing.
   */
  const cases: Array<{ said: string; record: ProcessHealthRecord; health: ProcessHealth }> = [
    {
      said: "a process that has just been spawned is starting",
      record: record({ startedAgoMs: SECOND }),
      health: "starting",
    },
    {
      said: "a process that has been up ten minutes and answered nothing is still only starting",
      record: record({ startedAgoMs: 10 * MINUTE }),
      health: "starting",
    },
    {
      said: "a process that answered its health endpoint is running",
      record: record({ startedAgoMs: SECOND, readyAgoMs: 0 }),
      health: "running",
    },
    {
      said: "one exit is not a pattern",
      record: record({ exits: loop(1), startedAgoMs: SECOND }),
      health: "starting",
    },
    {
      said: "two exits are still a coincidence",
      record: record({ exits: loop(2), startedAgoMs: SECOND }),
      health: "starting",
    },
    {
      said: "three exits in a row, none of them after a run that served, is a loop",
      record: record({ exits: loop(CRASH_LOOP_EXITS), startedAgoMs: SECOND }),
      health: "crash-looping",
    },
    {
      said: "a loop is a loop while nothing is running either, between restarts",
      record: record({ exits: loop(CRASH_LOOP_EXITS) }),
      health: "crash-looping",
    },
    {
      /* The very shape of the incident: runs long enough that any uptime rule
         would have called each of them a success. */
      said: "three never-ready runs of a minute each are a loop, however long each one was up",
      record: record({ exits: loop(CRASH_LOOP_EXITS, { everyMs: 65 * SECOND }), startedAgoMs: 5 }),
      health: "crash-looping",
    },
    {
      said: "three never-ready runs of ten minutes each are the same loop",
      record: record({ exits: loop(CRASH_LOOP_EXITS, { everyMs: 10 * MINUTE }) }),
      health: "crash-looping",
    },
    {
      said: "a loop hours old is still a loop while nothing has answered since",
      record: record({ exits: loop(CRASH_LOOP_EXITS, { everyMs: 3600 * SECOND }) }),
      health: "crash-looping",
    },
    {
      said: "a run that served ends the streak, so the exits before it are not this loop",
      record: record({ exits: [...loop(2), served(NOW - SECOND)], startedAgoMs: SECOND }),
      health: "starting",
    },
    {
      said: "a process that came back and is answering has recovered, whatever is behind it",
      record: record({ exits: loop(CRASH_LOOP_EXITS), startedAgoMs: SECOND, readyAgoMs: 0 }),
      health: "running",
    },
    {
      said: "a process killed by a signal counts exactly like one that exited",
      record: record({
        exits: loop(CRASH_LOOP_EXITS).map((exit) => ({ ...exit, code: null, signal: "SIGKILL" })),
      }),
      health: "crash-looping",
    },
  ];

  it.each(cases)("$said", (one) => {
    expect(processHealth(one.record)).toBe(one.health);
    expect(isCrashLooping(one.record)).toBe(one.health === "crash-looping");
  });

  it("counts only the exits since the last run that served", () => {
    const mixed = record({ exits: [...loop(2), served(NOW - 10 * SECOND), ...loop(3)] });

    expect(restartStreak(mixed)).toBe(3);
  });

  it("calls no process ready whose run has ended, whatever it answered before", () => {
    expect(isProcessReady(record({ startedAgoMs: SECOND, readyAgoMs: 0 }))).toBe(true);
    expect(isProcessReady(record({ startedAgoMs: SECOND }))).toBe(false);
    /* Nothing is running: the readiness of the run before it is not this one's. */
    expect(isProcessReady(record({ readyAgoMs: SECOND }))).toBe(false);
  });
});

describe("a streak longer than the history kept", () => {
  it("still says since when and how many times", () => {
    const looping = record({});
    for (let i = 0; i < 50; i++) {
      appendExit(looping, { atMs: NOW + i * 70 * SECOND, wasReady: false, code: 1 }, 5);
    }

    expect(looping.exits).toHaveLength(5);
    expect(restartStreak(looping)).toBe(50);
    expect(failingSinceMs(looping)).toBe(NOW);
  });

  it("forgets it at the first run that served", () => {
    const looping = record({});
    for (let i = 0; i < 4; i++) appendExit(looping, { atMs: NOW + i, wasReady: false, code: 1 }, 5);
    appendExit(looping, served(NOW + 10), 5);

    expect(restartStreak(looping)).toBe(0);
    expect(failingSinceMs(looping)).toBeUndefined();
  });
});

describe("the wait between restarts", () => {
  /* The jitter seam is fixed at the top of the window, so the numbers below are
     the widths themselves rather than a draw from them. */
  const top = (windowMs: number): number => windowMs - 1;

  it("starts a process that has never exited at once", () => {
    expect(restartDelayMs(0, { jitter: top })).toBe(0);
  });

  it("grows from the reconcile interval, doubling, and stops at the ceiling", () => {
    expect(restartDelayMs(1, { jitter: top })).toBe(RESTART_BACKOFF_BASE_MS - 1);
    expect(restartDelayMs(2, { jitter: top })).toBe(RESTART_BACKOFF_BASE_MS * 2 - 1);
    expect(restartDelayMs(3, { jitter: top })).toBe(RESTART_BACKOFF_BASE_MS * 4 - 1);
    expect(restartDelayMs(20, { jitter: top })).toBe(RESTART_BACKOFF_MAX_MS - 1);
  });

  it("draws every wait, so a node with several wedged applications spreads them", () => {
    const windows: number[] = [];
    restartDelayMs(4, {
      jitter: (windowMs) => {
        windows.push(windowMs);
        return 0;
      },
    });

    expect(windows).toEqual([RESTART_BACKOFF_BASE_MS * 8]);
  });
});

describe("what the node remembers about its own processes", () => {
  it("holds a process back until its backoff has run, and lets it through after", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: (windowMs) => windowMs - 1,
      log: () => {},
    });

    health.started("shop");
    expect(health.mayStart("shop")).toBe(true);

    clock.ms += SECOND;
    health.exited(exit("shop"));
    expect(health.mayStart("shop"), "a start straight after an exit is held").toBe(false);

    clock.ms += RESTART_BACKOFF_BASE_MS;
    expect(health.mayStart("shop")).toBe(true);
  });

  /* Why the backoff never grew on the real fleet: each sixty-second run counted
     as settled, so the wait was drawn from a streak of one, every time. */
  it("keeps the wait growing while nothing serves, and forgets it after a run that did", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: (windowMs) => windowMs - 1,
      log: () => {},
    });

    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      health.started("shop");
      /* A whole minute up, and never ready: the incident's own cycle. */
      clock.ms += 65 * SECOND;
      health.exited(exit("shop"));
      waits.push(Date.parse(health.views().shop?.retryAt ?? "") - clock.ms);
    }

    expect(waits).toEqual([
      RESTART_BACKOFF_BASE_MS - 1,
      RESTART_BACKOFF_BASE_MS * 2 - 1,
      RESTART_BACKOFF_BASE_MS * 4 - 1,
      RESTART_BACKOFF_BASE_MS * 8 - 1,
      RESTART_BACKOFF_MAX_MS - 1,
      RESTART_BACKOFF_MAX_MS - 1,
    ]);

    /* One run that answers, and the streak behind it is gone: an application that
       served and then died is started again at once, like any first start. */
    clock.ms += RESTART_BACKOFF_MAX_MS;
    health.started("shop");
    health.ready("shop");
    clock.ms += SECOND;
    health.exited(exit("shop"));

    expect(health.views().shop?.restarts).toBe(0);
    expect(Date.parse(health.views().shop?.retryAt ?? "") - clock.ms).toBe(0);
    expect(health.mayStart("shop")).toBe(true);
  });

  it("says what is crash-looping, and stops saying it once the process answers", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: () => 0,
      log: () => {},
    });

    for (let i = 0; i < CRASH_LOOP_EXITS; i++) {
      health.started("shop");
      clock.ms += 15 * SECOND;
      health.exited(exit("shop"));
    }
    expect([...health.crashLooping()]).toEqual(["shop"]);

    health.started("shop");
    expect([...health.crashLooping()], "being up is not being ready").toEqual(["shop"]);

    health.ready("shop");
    expect([...health.crashLooping()]).toEqual([]);
  });

  it("names only the applications whose current run has answered", () => {
    const health = createProcessHealth({ jitter: () => 0, log: () => {} });

    health.started("shop");
    health.started("blog");
    health.ready("blog");
    expect([...health.readyApplications()]).toEqual(["blog"]);

    /* An exit takes the readiness of that run with it. */
    health.exited(exit("blog"));
    expect([...health.readyApplications()]).toEqual([]);

    /* Told of an application nothing runs for, a probe that raced a stop. */
    health.ready("gone");
    expect([...health.readyApplications()]).toEqual([]);
  });

  it("says it once when it starts and once when it ends, not once per restart", () => {
    const clock = { ms: NOW };
    const said: string[] = [];
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: () => 0,
      log: (line) => said.push(line),
    });

    for (let i = 0; i < CRASH_LOOP_EXITS + 3; i++) {
      health.started("shop");
      clock.ms += 15 * SECOND;
      health.exited(exit("shop", ["Error: node lease could not be read"]));
    }

    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`"shop" is crash-looping`);
    expect(said[0]).toContain("node lease could not be read");

    health.started("shop");
    health.ready("shop");

    expect(said).toHaveLength(2);
    expect(said[1]).toContain("is answering again");
  });

  it("publishes a failing map a node record can carry, and nothing at all when healthy", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: () => 0,
      log: () => {},
    });

    expect(health.failing()).toBeUndefined();

    const firstAt = clock.ms + 15 * SECOND;
    for (let i = 0; i < CRASH_LOOP_EXITS; i++) {
      health.started("shop");
      clock.ms += 15 * SECOND;
      health.exited(exit("shop", ["Error: node authority was not established", "  at wake scan"]));
    }

    expect(health.failing()).toEqual({
      shop: {
        since: new Date(firstAt).toISOString(),
        restarts: CRASH_LOOP_EXITS,
        /* The first line only: the rest of the tail stays on the node. */
        lastError: "Error: node authority was not established",
      },
    });
  });

  /* No liveness decision was taken about it, so there is nothing to report. */
  it("reports nothing as failing for a process that has been starting for an hour", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: () => 0,
      log: () => {},
    });

    health.started("shop");
    clock.ms += 60 * MINUTE;

    expect(health.failing()).toBeUndefined();
    expect([...health.crashLooping()]).toEqual([]);
    expect(health.views().shop).toMatchObject({
      health: "starting",
      ready: false,
      startedAt: new Date(NOW).toISOString(),
    });
    expect(health.views().shop?.readyAt).toBeUndefined();
  });

  it("forgets a process the daemon stopped on purpose, so a later start is not a restart", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: () => 0,
      log: () => {},
    });

    for (let i = 0; i < CRASH_LOOP_EXITS; i++) {
      health.started("shop");
      clock.ms += 15 * SECOND;
      health.exited(exit("shop"));
    }
    expect(health.failing()).toBeDefined();

    health.stopped("shop");

    expect(health.failing()).toBeUndefined();
    expect(health.mayStart("shop")).toBe(true);
    expect(health.views()).toEqual({});
  });

  it("reports the exit, the restarts and the whole stderr tail for one process", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({
      now: () => new Date(clock.ms),
      jitter: () => 0,
      log: () => {},
    });

    health.started("shop");
    clock.ms += 15 * SECOND;
    health.exited({ ...exit("shop", ["one", "two"]), exitCode: 3 });

    const view = health.views().shop;
    expect(view?.health).toBe("starting");
    expect(view?.ready).toBe(false);
    expect(view?.restarts).toBe(1);
    expect(view?.lastExit).toEqual({ code: 3, at: new Date(clock.ms).toISOString() });
    expect(view?.lastError).toEqual(["one", "two"]);
    expect(view?.retryAt).toBe(new Date(clock.ms).toISOString());
  });

  it("says when a run answered, and takes it back when the run ends", () => {
    const clock = { ms: NOW };
    const health = createProcessHealth({ now: () => new Date(clock.ms), log: () => {} });

    health.started("shop");
    clock.ms += 2 * SECOND;
    health.ready("shop");
    const readyAt = new Date(clock.ms).toISOString();

    /* Asked again on a later pass: readiness belongs to the run, and the moment
       it was reached does not move. */
    clock.ms += 5 * SECOND;
    health.ready("shop");
    expect(health.views().shop).toMatchObject({ health: "running", ready: true, readyAt });

    health.exited(exit("shop"));
    expect(health.views().shop).toMatchObject({ health: "starting", ready: false });
    expect(health.views().shop?.readyAt).toBeUndefined();
  });
});

/** An exit as the supervisor reports one. */
function exit(id: string, lastError?: string[]): ProcessStatus {
  return {
    id,
    state: "exited",
    exitCode: 1,
    startedAt: new Date(NOW).toISOString(),
    ...(lastError === undefined ? {} : { lastError }),
  };
}
