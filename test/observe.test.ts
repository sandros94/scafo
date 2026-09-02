/*
 * The seam the daemon reports through: what it stamps an event with, what the bounded ring keeps,
 * what it admits to having dropped, and what a node that is not observing pays for it.
 */

import { describe, expect, it } from "vitest";
import {
  createObservability,
  OBSERVED_RING_SIZE,
  type ObservedEvent,
} from "../src/daemon/observe.ts";
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

    observe.emit({ type: "runtime.started", processId: "shop--one" });
    clock.tick(2_500);
    observe.emit({ type: "runtime.started", processId: "shop--two" });

    expect(observe.snapshot().events).toEqual([
      {
        at: new Date(CLOCK_START_MS).toISOString(),
        type: "runtime.started",
        processId: "shop--one",
      },
      {
        at: new Date(CLOCK_START_MS + 2_500).toISOString(),
        type: "runtime.started",
        processId: "shop--two",
      },
    ]);
    /* The same clock a span is measured against, so a `durationMs` and the `at`
       beside it can never come from two different ones. */
    expect(observe.nowMs()).toBe(CLOCK_START_MS + 2_500);
  });

  it("keeps every field the caller wrote, and adds nothing but the time", () => {
    const observe = createObservability({ enabled: true, now: manualClock().now });

    observe.emit({
      type: "placement.pending",
      project: "shop",
      env: "preview",
      reason: "placement-unavailable",
    });

    expect(observe.snapshot().events[0]).toEqual({
      at: new Date(CLOCK_START_MS).toISOString(),
      type: "placement.pending",
      project: "shop",
      env: "preview",
      reason: "placement-unavailable",
    });
  });
});

describe("the ring", () => {
  it("holds what it was sized for and no more, dropping the oldest", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });

    for (let index = 0; index < 6; index++) {
      observe.emit({ type: "runtime.started", processId: `id-${String(index)}` });
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

    observe.emit({ type: "runtime.started", processId: "one" });
    observe.emit({ type: "runtime.started", processId: "two" });

    expect(observe.snapshot()).toEqual({
      events: [
        { at: new Date(CLOCK_START_MS).toISOString(), type: "runtime.started", processId: "one" },
        { at: new Date(CLOCK_START_MS).toISOString(), type: "runtime.started", processId: "two" },
      ],
      dropped: 0,
    });
  });

  it("does not consume what it hands out: two readers see the same events", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });
    observe.emit({ type: "runtime.started", processId: "one" });

    const first = observe.snapshot();
    const second = observe.snapshot();

    expect(ids(second.events)).toEqual(ids(first.events));
    /* And a snapshot is a copy: pushing to one must not grow the ring. */
    first.events.push({ at: "", type: "runtime.started", processId: "forged" });
    expect(ids(observe.snapshot().events)).toEqual(["one"]);
  });

  it("defaults to a size a node can hold without thinking about it", () => {
    const observe = createObservability({ enabled: true, now: manualClock().now });

    for (let index = 0; index < OBSERVED_RING_SIZE + 3; index++) {
      observe.emit({ type: "runtime.started", processId: String(index) });
    }

    expect(observe.snapshot().events).toHaveLength(OBSERVED_RING_SIZE);
    expect(observe.snapshot().dropped).toBe(3);
  });
});

describe("draining, which is the flusher's reader", () => {
  it("takes what has been emitted since the last drain, and only that", () => {
    const observe = createObservability({ enabled: true, ringSize: 8, now: manualClock().now });
    observe.emit({ type: "runtime.started", processId: "one" });
    observe.emit({ type: "runtime.started", processId: "two" });

    expect(ids(observe.drain().events)).toEqual(["one", "two"]);
    /* Consumed: a second drain of the same events would write them twice. */
    expect(observe.drain().events).toEqual([]);

    observe.emit({ type: "runtime.started", processId: "three" });
    expect(ids(observe.drain().events)).toEqual(["three"]);
  });

  it("leaves the window alone: a snapshot still shows what was drained", () => {
    const observe = createObservability({ enabled: true, ringSize: 8, now: manualClock().now });
    observe.emit({ type: "runtime.started", processId: "one" });

    observe.drain();

    /* The ring is a window on the recent past and the drain is a high-water
       mark over it; consuming one must not empty the other. */
    expect(ids(observe.snapshot().events)).toEqual(["one"]);
  });

  it("counts what fell out of the ring before it could be read, since the last drain", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });
    for (let index = 0; index < 6; index++) {
      observe.emit({ type: "runtime.started", processId: `id-${String(index)}` });
    }

    const first = observe.drain();

    expect(ids(first.events)).toEqual(["id-2", "id-3", "id-4", "id-5"]);
    expect(first.dropped).toBe(2);

    /* Since the last DRAIN, never since the seam was made: the flusher records
       each flush's own loss, and a total would be counted again every time. */
    for (let index = 6; index < 11; index++) {
      observe.emit({ type: "runtime.started", processId: `id-${String(index)}` });
    }
    const second = observe.drain();

    expect(ids(second.events)).toEqual(["id-7", "id-8", "id-9", "id-10"]);
    expect(second.dropped).toBe(1);
  });

  it("admits no loss while the drainer keeps up", () => {
    const observe = createObservability({ enabled: true, ringSize: 4, now: manualClock().now });

    for (let round = 0; round < 5; round++) {
      observe.emit({ type: "runtime.started", processId: `round-${String(round)}` });
      expect(observe.drain().dropped).toBe(0);
    }
    /* And the ring itself has forgotten a few by now, which is a different
       number and a different question. */
    expect(observe.snapshot().dropped).toBe(1);
  });
});

describe("a seam that is off", () => {
  it("records nothing at all, whatever it is handed", () => {
    const observe = createObservability({ enabled: false, now: manualClock().now });

    observe.emit({ type: "reconcile.pass.start", kicked: true });
    observe.emit({ type: "runtime.started", processId: "one" });

    expect(observe.enabled).toBe(false);
    expect(observe.snapshot()).toEqual({ events: [], dropped: 0 });
    /* Including to the flusher: a disabled seam is legal to hand one, and it
       simply never has anything to write. */
    expect(observe.drain()).toEqual({ events: [], dropped: 0 });
  });

  it("still answers the clock, so a caller measuring a span needs no branch", () => {
    const clock = manualClock();
    const observe = createObservability({ enabled: false, now: clock.now });

    const before = observe.nowMs();
    clock.tick(700);

    expect(observe.nowMs() - before).toBe(700);
  });
});

/** The identities of the events a case emitted, in order. */
function ids(events: ObservedEvent[]): string[] {
  return events.map((event) => ("processId" in event ? event.processId : event.type));
}
