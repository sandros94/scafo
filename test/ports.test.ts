/*
 * Choosing the two ports one application holds on a node: where they may come
 * from, what they may never be, and what happens once a range has nothing left.
 */

import { describe, expect, it } from "vitest";
import { secureRandomNumber } from "unsecure/random";
import {
  assertPortRange,
  choosePorts,
  DEFAULT_PORT_QUARANTINE_MS,
  DEFAULT_PORT_RANGE_SPAN,
  DEFAULT_PORT_RANGE_START,
  defaultPortRangeEnd,
  type PortPair,
} from "../src/core/placement/ports.ts";
import { rejectsWith } from "./_helpers.ts";

/** A range big enough for a handful of pairs, away from the default one. */
const START = 50_000;
const END = 50_009;

/** Two ports in the order a comparison reads them. */
const ascending = (a: number, b: number): number => a - b;

/** Everything in the range is bindable unless a case says otherwise. */
const allFree = (): Promise<boolean> => Promise.resolve(true);

/**
 * A source that walks a fixed list of draws and then repeats the last one, so a
 * case says exactly which candidates are offered and in what order.
 */
/**
 * A source answering each draw with the port at the given FRACTION of what is
 * still drawable, in port order — the same contract `secureRandomNumber` has.
 */
function draws(...fractions: number[]): (min: number, max: number, ignore: Set<number>) => number {
  let index = 0;
  return (min, max, ignore): number => {
    const drawable: number[] = [];
    for (let port = min; port < max; port++) if (!ignore.has(port)) drawable.push(port);
    const fraction = fractions[Math.min(index++, fractions.length - 1)] as number;
    return drawable[
      Math.min(Math.floor(fraction * drawable.length), drawable.length - 1)
    ] as number;
  };
}

async function chosen(opts?: Partial<Parameters<typeof choosePorts>[0]>): Promise<PortPair> {
  return await choosePorts({
    range: { start: START, end: END },
    held: [],
    quarantined: [],
    isFree: allFree,
    random: secureRandomNumber,
    ...opts,
  });
}

describe("a pair drawn from the range", () => {
  it("draws both halves at random and independently of each other", async () => {
    /* Both halves are drawn from the same range, the second from what the first
       left: neither half follows from the other, and neither follows from the
       order applications are started in. */
    expect(await chosen({ random: draws(0.999_999, 0) })).toEqual({
      public: END,
      internal: START,
    });
    const apart = await chosen({ random: draws(0, 0.5) });
    expect(apart.public).toBe(START);
    expect(apart.internal).toBeGreaterThan(START + 1);
  });

  it("gives the same pair twice for the same draws, so a test may fix a choice", async () => {
    const first = await chosen({ random: draws(0.4, 0.8) });
    const second = await chosen({ random: draws(0.4, 0.8) });

    expect(first).toEqual(second);
  });

  it("stays inside the range and never pairs a port with itself", async () => {
    for (let round = 0; round < 200; round++) {
      const pair = await chosen();

      expect(pair.public).toBeGreaterThanOrEqual(START);
      expect(pair.public).toBeLessThanOrEqual(END);
      expect(pair.internal).toBeGreaterThanOrEqual(START);
      expect(pair.internal).toBeLessThanOrEqual(END);
      expect(pair.internal).not.toBe(pair.public);
    }
  });

  it("does not put the two halves next to each other every time", async () => {
    /* Consecutive halves are what made a public port name an internal one. */
    let consecutive = 0;
    for (let round = 0; round < 200; round++) {
      const pair = await chosen();
      if (pair.internal === pair.public + 1) consecutive++;
    }

    expect(consecutive).toBeLessThan(200);
  });
});

describe("ports the node may not offer", () => {
  it("never offers one another application of this node holds", async () => {
    const held = [START, START + 1, START + 2, START + 3, START + 4, START + 5, START + 6];

    for (let round = 0; round < 50; round++) {
      const pair = await chosen({ held });

      expect(held).not.toContain(pair.public);
      expect(held).not.toContain(pair.internal);
    }
  });

  it("never offers one released too recently for the fleet to have stopped routing there", async () => {
    const quarantined = [START, START + 1, START + 2, START + 3, START + 4, START + 5, START + 6];

    for (let round = 0; round < 50; round++) {
      const pair = await chosen({ quarantined });

      expect(quarantined).not.toContain(pair.public);
      expect(quarantined).not.toContain(pair.internal);
    }
  });

  it("skips a port a foreign process is listening on", async () => {
    /* The range is this node's by convention and by nothing else. */
    const busy = new Set([START, START + 1]);
    const pair = await chosen({
      random: draws(0, 0),
      isFree: (port) => Promise.resolve(!busy.has(port)),
    });

    expect(busy.has(pair.public)).toBe(false);
    expect(busy.has(pair.internal)).toBe(false);
  });

  it("probes a port at most once, however long the range is", async () => {
    const probed: number[] = [];
    await chosen({
      isFree: (port) => {
        probed.push(port);
        return Promise.resolve(false);
      },
    }).catch(() => undefined);

    expect(new Set(probed).size).toBe(probed.length);
    expect(probed).toHaveLength(END - START + 1);
  });
});

describe("a range with nothing left in it", () => {
  it("refuses to place a process, naming the range", async () => {
    const error = await rejectsWith(
      async () => await chosen({ isFree: () => Promise.resolve(false) }),
      "placement-unavailable",
    );

    expect(error.detail).toContain(String(START));
    expect(error.detail).toContain(String(END));
  });

  it("refuses when only one port of the range is left", async () => {
    const held: number[] = [];
    for (let port = START + 1; port <= END; port++) held.push(port);

    const error = await rejectsWith(async () => await chosen({ held }), "placement-unavailable");

    expect(error.code).toBe("placement-unavailable");
  });

  it("places a pair in the smallest range that holds one", async () => {
    const pair = await chosen({ range: { start: START, end: START + 1 } });

    expect([pair.public, pair.internal].sort(ascending)).toEqual([START, START + 1]);
  });
});

describe("a range that cannot be used", () => {
  it("refuses a start below the unprivileged ports or past the last one", async () => {
    for (const start of [0, 1, 1023, 65_535, 70_000, 1.5, Number.NaN]) {
      const error = await rejectsWith(
        () => Promise.resolve(assertPortRange({ start, end: 65_535 })),
        "invalid-input",
      );

      expect(error.detail, `for start ${String(start)}`).toContain("1024-65534");
    }
  });

  it("refuses an end that leaves room for fewer than two ports", async () => {
    for (const end of [START, START - 1, 65_536, 60_000.5]) {
      const error = await rejectsWith(
        () => Promise.resolve(assertPortRange({ start: START, end })),
        "invalid-input",
      );

      expect(error.detail, `for end ${String(end)}`).toContain("at least two ports");
    }
  });

  it("names the settings an operator would correct", async () => {
    const error = await rejectsWith(
      () =>
        Promise.resolve(
          assertPortRange({ start: 80, end: 90 }, { start: "runtime.portRangeStart" }),
        ),
      "invalid-input",
    );

    expect(error.detail).toContain("runtime.portRangeStart");
  });

  it("accepts the documented default range", () => {
    expect(DEFAULT_PORT_RANGE_START).toBe(24_000);
    expect(defaultPortRangeEnd(DEFAULT_PORT_RANGE_START)).toBe(24_998);
    expect(DEFAULT_PORT_RANGE_SPAN).toBe(998);
    expect(() =>
      assertPortRange({
        start: DEFAULT_PORT_RANGE_START,
        end: defaultPortRangeEnd(DEFAULT_PORT_RANGE_START),
      }),
    ).not.toThrow();
  });

  it("stops the default end at the last port there is", () => {
    expect(defaultPortRangeEnd(65_000)).toBe(65_535);
  });

  it("quarantines a released pair for ten minutes by default", () => {
    expect(DEFAULT_PORT_QUARANTINE_MS).toBe(600_000);
  });
});

describe("the default range and the ports a machine hands out by itself", () => {
  it("ends below where Linux starts drawing the source ports of outgoing connections", () => {
    /* 32768 is the first ephemeral port of a stock Linux machine. A default range
       that reached it would have any outgoing connection able to take a port an
       application holds, and a listener is refused a port in that use. */
    expect(defaultPortRangeEnd(DEFAULT_PORT_RANGE_START)).toBeLessThan(32_768);
  });
});
