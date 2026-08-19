/*
 * The loopback port-pair allocator: which pairs a node hands to the processes it
 * starts, which it must step over because something already listens there, and
 * what happens once its range is used up.
 *
 * A pair is two consecutive ports — public and internal — of one process, so the
 * unit that is allocated, skipped and exhausted is always the pair, never a
 * single port.
 */

import { describe, expect, it } from "vitest";
import {
  createPortAllocator,
  DEFAULT_PORT_RANGE_SPAN,
  DEFAULT_PORT_RANGE_START,
} from "../src/core/placement/ports.ts";
import { rejectsWith } from "./_helpers.ts";

/** A range big enough for a handful of pairs, away from the default one. */
const START = 50_000;
const END = 50_009;

describe("handing out pairs", () => {
  it("starts at the configured port and walks the range two ports at a time", () => {
    const ports = createPortAllocator({ start: START, end: END });

    expect(ports.nextPorts()).toEqual({ public: START, internal: START + 1 });
    expect(ports.nextPorts()).toEqual({ public: START + 2, internal: START + 3 });
    expect(ports.nextPorts()).toEqual({ public: START + 4, internal: START + 5 });
  });

  it("starts at the documented default when no range is configured", () => {
    const ports = createPortAllocator();

    expect(DEFAULT_PORT_RANGE_START).toBe(42_000);
    expect(ports.nextPorts()).toEqual({
      public: DEFAULT_PORT_RANGE_START,
      internal: DEFAULT_PORT_RANGE_START + 1,
    });
  });

  it("never hands the same port to two processes", () => {
    const ports = createPortAllocator({ start: DEFAULT_PORT_RANGE_START });
    const seen = new Set<number>();

    for (let i = 0; i < 100; i++) {
      const pair = ports.nextPorts();

      expect(pair.internal, `pair ${String(i)} must be consecutive`).toBe(pair.public + 1);
      expect(seen.has(pair.public), `pair ${String(i)} reused its public port`).toBe(false);
      expect(seen.has(pair.internal), `pair ${String(i)} reused its internal port`).toBe(false);
      seen.add(pair.public);
      seen.add(pair.internal);
    }
    expect(seen.size).toBe(200);
  });

  it("gives two allocators over one range the same first pair, having no shared state", () => {
    const first = createPortAllocator({ start: START, end: END });
    const second = createPortAllocator({ start: START, end: END });

    expect(first.nextPorts()).toEqual(second.nextPorts());
  });
});

describe("ports something already listens on", () => {
  it("steps over a pair whose public port is taken", () => {
    /* The listeners of the processes this node already runs, as the loop passes
       them in: both halves of every running pair. */
    const ports = createPortAllocator({ start: START, end: END, taken: [START, START + 1] });

    expect(ports.nextPorts()).toEqual({ public: START + 2, internal: START + 3 });
  });

  it("steps over the whole pair when only its internal port is taken", () => {
    /* Pairs sit at even offsets from the start of the range, so the public half
       of a pair whose internal half is unavailable cannot be handed out on its
       own — it would leave the next process without an internal port. */
    const ports = createPortAllocator({ start: START, end: END, taken: [START + 1] });

    expect(ports.nextPorts()).toEqual({ public: START + 2, internal: START + 3 });
  });

  it("takes the ports in use as any iterable, and ignores ones outside the range", () => {
    const ports = createPortAllocator({
      start: START,
      end: END,
      taken: new Set([START + 2, 80, 65_535]),
    });

    expect(ports.nextPorts()).toEqual({ public: START, internal: START + 1 });
    expect(ports.nextPorts()).toEqual({ public: START + 4, internal: START + 5 });
  });
});

describe("a range that runs out", () => {
  it("refuses to place a process once every pair is spoken for", async () => {
    /* Exactly two pairs fit in this range. */
    const ports = createPortAllocator({ start: START, end: START + 3 });
    expect(ports.nextPorts()).toEqual({ public: START, internal: START + 1 });
    expect(ports.nextPorts()).toEqual({ public: START + 2, internal: START + 3 });

    const error = await rejectsWith(async () => ports.nextPorts(), "placement-unavailable");

    expect(error.detail).toContain(String(START));
    expect(error.detail).toContain(String(START + 3));
  });

  it("counts a range that ends on an even offset one pair short", () => {
    /* Three ports hold one pair: the third has no partner to be paired with. */
    const ports = createPortAllocator({ start: START, end: START + 2 });

    expect(ports.nextPorts()).toEqual({ public: START, internal: START + 1 });
    expect(() => ports.nextPorts()).toThrow("No free port pair");
  });

  it("spans the documented number of pairs by default", async () => {
    const ports = createPortAllocator();
    const pairs = Math.floor((DEFAULT_PORT_RANGE_SPAN + 1) / 2);

    for (let i = 0; i < pairs; i++) ports.nextPorts();

    expect(pairs).toBe(499);
    const error = await rejectsWith(async () => ports.nextPorts(), "placement-unavailable");

    expect(error.detail).toContain(String(DEFAULT_PORT_RANGE_START));
  });

  it("has nothing to hand out when every pair of the range is already in use", async () => {
    const ports = createPortAllocator({
      start: START,
      end: START + 3,
      taken: [START, START + 1, START + 2, START + 3],
    });

    const error = await rejectsWith(async () => ports.nextPorts(), "placement-unavailable");

    expect(error.detail).toContain("already in use");
  });
});

describe("a range that cannot be used", () => {
  it("refuses a start that is not a usable port", async () => {
    for (const start of [0, -1, 65_535, 70_000, 1.5, Number.NaN]) {
      const error = await rejectsWith(async () => createPortAllocator({ start }), "invalid-input");

      expect(error.detail, `for start ${String(start)}`).toContain("1-65534");
    }
  });

  it("refuses an end that leaves no room for a pair, or reaches past the last port", async () => {
    for (const end of [START, START - 1, 65_536, 60_000.5]) {
      const error = await rejectsWith(
        async () => createPortAllocator({ start: START, end }),
        "invalid-input",
      );

      expect(error.detail, `for end ${String(end)}`).toContain("65535");
    }
  });

  it("accepts the smallest range that holds one pair", () => {
    const ports = createPortAllocator({ start: START, end: START + 1 });

    expect(ports.nextPorts()).toEqual({ public: START, internal: START + 1 });
  });
});
