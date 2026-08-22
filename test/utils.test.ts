/* The naming grammar is a bijection, plus the utilities the registry hashes and retries with. */

import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { fromBase64Url, toBase64Url } from "../src/core/utils/base64.ts";
import { withRetry } from "../src/core/utils/backoff.ts";
import {
  createConcurrencyGate,
  DEFAULT_CONCURRENCY,
  mapConcurrent,
} from "../src/core/utils/concurrency.ts";
import { sha256Hex } from "../src/core/utils/hash.ts";
import { isHost } from "../src/core/utils/host.ts";
import { stableStringify } from "../src/core/utils/json.ts";
import { assertSlug, formatHostLabel, isSlug, parseHostLabel } from "../src/core/utils/slug.ts";
import { randomSlug, rejectsWith, seededRng } from "./_helpers.ts";

const PROPERTY_ITERATIONS = 2000;

describe("host labels", () => {
  it("round-trips every generated label, with and without a ref", () => {
    const rng = seededRng(0x5ca10_001);

    for (let i = 0; i < PROPERTY_ITERATIONS; i++) {
      const project = randomSlug(rng, 20);
      const ref = randomSlug(rng, 20);
      expect(isSlug(project) && isSlug(ref)).toBe(true);

      const bare = formatHostLabel(project);
      expect(bare).toBe(project);
      expect(parseHostLabel(bare)).toEqual({ project });

      const scoped = formatHostLabel(project, ref);
      expect(scoped).toBe(`${project}--${ref}`);
      expect(parseHostLabel(scoped)).toEqual({ project, ref });
    }
  });

  it("re-formats every label it parses to the same bytes", () => {
    const rng = seededRng(0x5ca10_002);

    for (let i = 0; i < PROPERTY_ITERATIONS; i++) {
      const segments = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => randomSlug(rng, 18));
      const label = segments.join("--");
      const parsed = parseHostLabel(label);

      /* Three segments are not a label at all, so parsing them must give up. */
      const reformatted = parsed === null ? null : formatHostLabel(parsed.project, parsed.ref);
      expect({ label, reformatted }).toEqual({
        label,
        reformatted: segments.length > 2 ? null : label,
      });
    }
  });

  it("rejects labels that are not one project, optionally one ref", () => {
    expect(isSlug("a--b")).toBe(false);
    expect(() => assertSlug("a--b")).toThrow(ScafoError);

    for (const label of ["a---b", "--a", "a--", "a--b--c", "-a", "a-", "A", "a_b", ""]) {
      expect({ label, parsed: parseHostLabel(label) }).toEqual({ label, parsed: null });
    }
  });

  it("refuses labels past the DNS label limit at both ends", () => {
    const long = "a".repeat(40);
    expect(() => formatHostLabel(long, long)).toThrow(ScafoError);
    expect(parseHostLabel(`${long}--${long}`)).toBeNull();
    expect(parseHostLabel("a".repeat(64))).toBeNull();
  });

  it("accepts the hosts a label composes into", () => {
    expect(isHost(`${formatHostLabel("proj", "pr-12")}.example.com`)).toBe(true);
    expect(isHost("Example.com")).toBe(false);
    expect(isHost("example.com.")).toBe(false);
  });
});

describe("stableStringify", () => {
  it("is insensitive to key order at every depth", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ outer: { x: [1, { p: 1, q: 2 }], y: null } })).toBe(
      stableStringify({ outer: { y: null, x: [1, { q: 2, p: 1 }] } }),
    );
  });

  it("keeps array order and skips undefined properties", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(stableStringify({ a: undefined, b: 1 })).toBe(`{"b":1}`);
  });

  it("throws on a top-level undefined", () => {
    expect(() => stableStringify(undefined)).toThrow(TypeError);
  });
});

describe("sha256Hex", () => {
  it("matches the published vectors", async () => {
    await expect(sha256Hex("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes strings as UTF-8 bytes", async () => {
    await expect(sha256Hex("héllo")).resolves.toBe(
      await sha256Hex(new TextEncoder().encode("héllo")),
    );
  });
});

describe("withRetry", () => {
  const nap = (): Promise<void> => Promise.resolve();

  it("retries CAS conflicts and returns the first success", async () => {
    let calls = 0;
    const delays: number[] = [];

    const value = await withRetry(
      () => {
        calls++;
        if (calls < 3) throw new ScafoError("cas-conflict", "conflict");
        return Promise.resolve("ok");
      },
      {
        jitter: () => 0.5,
        sleep: (ms) => {
          delays.push(ms);
          return nap();
        },
      },
    );

    expect(value).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([25, 50]);
  });

  it("does not wait for real between attempts", async () => {
    const started = Date.now();
    let calls = 0;

    await rejectsWith(
      () =>
        withRetry(
          () => {
            calls++;
            return Promise.reject(new ScafoError("cas-conflict", "conflict"));
          },
          { attempts: 5, baseMs: 10_000, jitter: () => 1, sleep: nap },
        ),
      "cas-conflict",
    );

    expect(calls).toBe(5);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("honours the attempt budget and rethrows the last error", async () => {
    let calls = 0;
    const error = await rejectsWith(
      () =>
        withRetry(
          () => {
            calls++;
            return Promise.reject(new ScafoError("cas-conflict", `conflict ${String(calls)}`));
          },
          { attempts: 2, jitter: () => 0, sleep: nap },
        ),
      "cas-conflict",
    );

    expect(calls).toBe(2);
    expect(error.message).toBe("conflict 2");
  });

  it("does not retry anything but a CAS conflict by default", async () => {
    let calls = 0;
    await rejectsWith(
      () =>
        withRetry(
          () => {
            calls++;
            return Promise.reject(new ScafoError("not-found", "gone"));
          },
          { attempts: 5, jitter: () => 0, sleep: nap },
        ),
      "not-found",
    );

    expect(calls).toBe(1);
  });

  it("takes a custom retry predicate", async () => {
    let calls = 0;
    const value = await withRetry(
      () => {
        calls++;
        if (calls < 2) throw new ScafoError("draining", "busy");
        return Promise.resolve(calls);
      },
      {
        attempts: 3,
        jitter: () => 0,
        sleep: nap,
        isRetryable: (err) => err instanceof ScafoError && err.code === "draining",
      },
    );

    expect(value).toBe(2);
  });

  it("caps the pre-jitter delay at maxMs", async () => {
    const delays: number[] = [];
    let calls = 0;

    await rejectsWith(
      () =>
        withRetry(
          () => {
            calls++;
            return Promise.reject(new ScafoError("cas-conflict", "conflict"));
          },
          {
            attempts: 4,
            baseMs: 100,
            maxMs: 150,
            jitter: () => 1,
            sleep: (ms) => {
              delays.push(ms);
              return nap();
            },
          },
        ),
      "cas-conflict",
    );

    expect(delays).toEqual([100, 150, 150]);
  });
});

describe("base64url", () => {
  it("round-trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const encoded = toBase64Url(bytes);

    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
  });

  it("round-trips every length modulo 4", () => {
    const rng = seededRng(0x5ca10_003);
    for (let length = 0; length < 32; length++) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(rng() * 256));
      expect([...fromBase64Url(toBase64Url(bytes))], `length ${String(length)}`).toEqual([
        ...bytes,
      ]);
    }
  });

  it("decodes padded input as well as unpadded", () => {
    expect(toBase64Url(new TextEncoder().encode("hello"))).toBe("aGVsbG8");
    expect([...fromBase64Url("aGVsbG8=")]).toEqual([...fromBase64Url("aGVsbG8")]);
  });
});

describe("mapConcurrent", () => {
  it("answers in input order, whatever order the work finished in", async () => {
    const finished: number[] = [];

    const answers = await mapConcurrent([30, 20, 10, 0], 4, async (ms, index) => {
      await delay(ms);
      finished.push(index);
      return index;
    });

    /* The completion order is the exact reverse, so an answer assembled as the
       work came back would be too. */
    expect(finished).toEqual([3, 2, 1, 0]);
    expect(answers).toEqual([0, 1, 2, 3]);
  });

  it("never runs more than the bound at a time, and does run more than one", async () => {
    let active = 0;
    let peak = 0;

    await mapConcurrent(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(1);
        active--;
      },
    );

    expect(peak).toBe(4);
  });

  it("bounds two maps together when they share one gate", async () => {
    /* Nested bounds MULTIPLY, and the product is what would reach the store; one
       gate handed to both is what keeps the total at what was asked for. */
    const gate = createConcurrencyGate(3);
    let active = 0;
    let peak = 0;

    const work = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await delay(2);
      active--;
    };
    await Promise.all([
      mapConcurrent([1, 2, 3, 4, 5], gate, work),
      mapConcurrent([1, 2, 3, 4, 5], gate, work),
    ]);

    expect(peak).toBe(3);
  });

  it("rejects with the failure of the LOWEST index, not the first one to settle", async () => {
    const error = await rejectsWith(
      async () =>
        mapConcurrent([0, 1, 2, 3], 4, async (item) => {
          /* Settles LAST and wins, because a sequential loop would have stopped
             here and never reached the one that settled first. */
          if (item === 0) {
            await delay(5);
            throw new ScafoError("not-found", "index 0");
          }
          if (item === 2) throw new ScafoError("draining", "index 2");
          return item;
        }),
      "not-found",
    );

    expect(error.message).toBe("index 0");
  });

  it("starts nothing behind a failure", async () => {
    const started: number[] = [];

    await rejectsWith(
      async () =>
        mapConcurrent([0, 1, 2, 3, 4, 5], 2, async (item) => {
          started.push(item);
          if (item === 0) throw new ScafoError("not-found", "index 0");
          await delay(1);
          return item;
        }),
      "not-found",
    );

    /* The two that fill the bound run; the four a sequential loop would never
       have reached are never handed to it either. */
    expect(started).toEqual([0, 1]);
  });

  it("waits for the work already in flight before it rejects", async () => {
    let settled = false;

    await rejectsWith(
      async () =>
        mapConcurrent([0, 1], 2, async (item) => {
          if (item === 0) throw new ScafoError("not-found", "index 0");
          await delay(5);
          settled = true;
          return item;
        }),
      "not-found",
    );

    /* Nothing this started outlives the call: a read still running once the
       caller has given up is one nobody is waiting for. */
    expect(settled).toBe(true);
  });

  it("answers an empty list without running anything", async () => {
    let calls = 0;

    expect(
      await mapConcurrent([], 4, async () => {
        calls++;
        return 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it("clamps a bound below one, and falls back to the default for one that is no number", () => {
    expect(createConcurrencyGate().limit).toBe(DEFAULT_CONCURRENCY);
    expect(createConcurrencyGate(Number.NaN).limit).toBe(DEFAULT_CONCURRENCY);
    expect(createConcurrencyGate(Number.POSITIVE_INFINITY).limit).toBe(DEFAULT_CONCURRENCY);

    for (const [limit, slots] of [
      [0, 1],
      [-3, 1],
      [0.5, 1],
      [2.9, 2],
    ] as const) {
      expect(createConcurrencyGate(limit).limit, `for a bound of ${String(limit)}`).toBe(slots);
    }
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
