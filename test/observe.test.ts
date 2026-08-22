/*
 * The seam the agent reports through: what it stamps an event with, what the
 * bounded ring keeps, what it admits to having dropped, and what a node that is
 * not observing pays for it.
 *
 * The clock is injected, so every `at` here is a value the case chose rather
 * than the moment it ran.
 */

import { describe, expect, it } from "vitest";
import {
  createObservability,
  OBSERVED_RING_SIZE,
  type ObservedEvent,
} from "../src/agent/observe.ts";
import { CLOCK_START_MS } from "./_helpers.ts";

/** A clock that only moves when the case says so, as the registry's tests use. */
function manualClock(): { now: () => Date; tick: (ms: number) => void } {
  let current = CLOCK_START_MS;
  return {
    now: (): Date => new Date(current),
    tick: (ms: number): void => {
      current += ms;
    },
  };
}

describe("what an event is stamped with", () => {
  it("takes its time from the injected clock, never from the caller", () => {
    const clock = manualClock();
    const observe = createObservability({ enabled: true, now: clock.now });

    observe.emit({ type: "wake.kicked", id: "aaaa" });
    clock.tick(2_500);
    observe.emit({ type: "wake.stamped", id: "aaaa" });

    expect(observe.snapshot().events).toEqual([
      { at: new Date(CLOCK_START_MS).toISOString(), type: "wake.kicked", id: "aaaa" },
      { at: new Date(CLOCK_START_MS + 2_500).toISOString(), type: "wake.stamped", id: "aaaa" },
    ]);
    /* The same clock a span is measured against, so a `durationMs` and the `at`
       beside it can never come from two different ones. */
    expect(observe.nowMs()).toBe(CLOCK_START_MS + 2_500);
  });

  it("keeps every field the caller wrote, and adds nothing but the time", () => {
    const observe = createObservability({ enabled: true, now: manualClock().now });

    observe.emit({
      type: "wake.admitted",
      id: "bbbb",
      host: "shop--preview.apps.test",
      kind: "build",
      project: "shop",
      env: "preview",
      build: "aaaa1111",
      inFlight: 2,
    });

    expect(observe.snapshot().events[0]).toEqual({
      at: new Date(CLOCK_START_MS).toISOString(),
      type: "wake.admitted",
      id: "bbbb",
      host: "shop--preview.apps.test",
      kind: "build",
      project: "shop",
      env: "preview",
      build: "aaaa1111",
      inFlight: 2,
    });
  });
});

describe("the ring", () => {
  it("holds what it was sized for and no more, dropping the oldest", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });

    for (let index = 0; index < 6; index++) {
      observe.emit({ type: "wake.kicked", id: `id-${String(index)}` });
    }
    const snapshot = observe.snapshot();

    /* Oldest first, and the two that fell out are the two oldest. */
    expect(ids(snapshot.events)).toEqual(["id-2", "id-3", "id-4", "id-5"]);
    /* Never silent about what it forgot: a reader that is too slow, or a ring
       that is too small, has to be able to tell. */
    expect(snapshot.dropped).toBe(2);
  });

  it("says nothing was dropped while it has not filled up", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });

    observe.emit({ type: "wake.kicked", id: "one" });
    observe.emit({ type: "wake.kicked", id: "two" });

    expect(observe.snapshot()).toEqual({
      events: [
        { at: new Date(CLOCK_START_MS).toISOString(), type: "wake.kicked", id: "one" },
        { at: new Date(CLOCK_START_MS).toISOString(), type: "wake.kicked", id: "two" },
      ],
      dropped: 0,
    });
  });

  it("does not consume what it hands out: two readers see the same events", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });
    observe.emit({ type: "wake.kicked", id: "one" });

    const first = observe.snapshot();
    const second = observe.snapshot();

    expect(ids(second.events)).toEqual(ids(first.events));
    /* And a snapshot is a copy: pushing to one must not grow the ring. */
    first.events.push({ at: "", type: "wake.kicked", id: "forged" });
    expect(ids(observe.snapshot().events)).toEqual(["one"]);
  });

  it("defaults to a size a node can hold without thinking about it", () => {
    const observe = createObservability({ enabled: true, now: manualClock().now });

    for (let index = 0; index < OBSERVED_RING_SIZE + 3; index++) {
      observe.emit({ type: "wake.kicked", id: String(index) });
    }

    expect(observe.snapshot().events).toHaveLength(OBSERVED_RING_SIZE);
    expect(observe.snapshot().dropped).toBe(3);
  });
});

describe("a seam that is off", () => {
  it("records nothing at all, whatever it is handed", () => {
    const observe = createObservability({ enabled: false, now: manualClock().now });

    observe.emit({ type: "reconcile.pass.start", kicked: true });
    observe.emit({ type: "wake.kicked", id: "one" });

    expect(observe.enabled).toBe(false);
    expect(observe.snapshot()).toEqual({ events: [], dropped: 0 });
  });

  it("still answers the clock, so a caller measuring a span needs no branch", () => {
    const clock = manualClock();
    const observe = createObservability({ enabled: false, now: clock.now });

    const before = observe.nowMs();
    clock.tick(700);

    expect(observe.nowMs() - before).toBe(700);
  });
});

/* ------------------------------------------------------------------ helpers */

/** The ids of the wake events a case emitted, in order. */
function ids(events: ObservedEvent[]): string[] {
  return events.map((event) => ("id" in event ? event.id : event.type));
}
