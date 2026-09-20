/* The naming grammar, plus the utilities the registry hashes and retries with. */

import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { assertDeployId, parseDeployId } from "../src/core/registry/paths.ts";
import { fromBase64Url, toBase64Url } from "../src/core/utils/base64.ts";
import { withRetry } from "../src/core/utils/backoff.ts";
import {
  createConcurrencyGate,
  DEFAULT_CONCURRENCY,
  mapConcurrent,
} from "../src/core/utils/concurrency.ts";
import { sha256Hex } from "../src/core/utils/hash.ts";
import {
  HOST_MAX_LENGTH,
  isHost,
  normalizeCustomDomain,
  splitHostLabel,
  wildcardBase,
  wildcardHost,
} from "../src/core/utils/host.ts";
import {
  familyApplication,
  familyLabel,
  isFamilyApplication,
} from "../src/core/placement/hosts.ts";
import { stableStringify } from "../src/core/utils/json.ts";
import { assertPositiveSafeInteger } from "../src/core/utils/number.ts";
import { assertSlug, isSlug, SLUG_MAX_LENGTH } from "../src/core/utils/slug.ts";
import { randomSlug, rejectsWith, seededRng } from "./_helpers.ts";

const PROPERTY_ITERATIONS = 2000;

describe("positive safe integers", () => {
  it("rejects objects without invoking their coercion hooks", () => {
    let coercions = 0;
    const hostile = {
      toString(): never {
        coercions += 1;
        throw new Error("toString called");
      },
      valueOf(): never {
        coercions += 1;
        throw new Error("valueOf called");
      },
      [Symbol.toPrimitive](): never {
        coercions += 1;
        throw new Error("toPrimitive called");
      },
    };

    for (const value of [Object.create(null), hostile]) {
      const error = rejectedInteger(value);
      expect(error).toMatchObject({
        code: "invalid-input",
        detail: '"limit" must be a positive safe integer, got <object>',
      });
    }
    expect(coercions).toBe(0);
  });

  it.each([
    [null, "null"],
    [undefined, "undefined"],
    [false, "false"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    ["unlimited", '"unlimited"'],
    [1n, "1n"],
    [Symbol.for("limit"), "Symbol(limit)"],
  ])("keeps the invalid primitive %s precise", (value, displayed) => {
    expect(rejectedInteger(value).detail).toBe(
      `"limit" must be a positive safe integer, got ${String(displayed)}`,
    );
  });
});

function rejectedInteger(value: unknown): ScafoError {
  let rejection: unknown;
  try {
    assertPositiveSafeInteger(value, "limit");
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(ScafoError);
  return rejection as ScafoError;
}

describe("application names", () => {
  it("accepts every generated name, and the host it is served at", () => {
    const rng = seededRng(0x5ca10_001);

    for (let i = 0; i < PROPERTY_ITERATIONS; i++) {
      const name = randomSlug(rng, 20);

      expect(isSlug(name)).toBe(true);
      expect(() => assertSlug(name)).not.toThrow();
      expect(isHost(`${name}.example.com`)).toBe(true);
    }
  });

  it("rejects anything that is not one run of hyphen-separated alphanumerics", () => {
    for (const name of ["a--b", "a---b", "--a", "a--", "-a", "a-", "A", "a_b", "", "a.b"]) {
      expect({ name, slug: isSlug(name) }).toEqual({ name, slug: false });
      expect(() => assertSlug(name), name).toThrow(ScafoError);
    }
  });

  it("refuses a name past the DNS label limit", () => {
    expect(isSlug("a".repeat(SLUG_MAX_LENGTH))).toBe(true);
    expect(isSlug("a".repeat(SLUG_MAX_LENGTH + 1))).toBe(false);
    expect(() => assertSlug("a".repeat(SLUG_MAX_LENGTH + 1))).toThrow(ScafoError);
  });

  it("holds hosts to their own grammar", () => {
    expect(isHost("Example.com")).toBe(false);
    expect(isHost("example.com.")).toBe(false);
  });
});

describe("hosts an application may claim", () => {
  /* Accepted, and what each one is stored as. Case is the only thing repaired:
     DNS is case-insensitive, so one name has one spelling in the registry. */
  const accepted: Array<[written: string, stored: string]> = [
    ["shop.example.com", "shop.example.com"],
    ["Shop.Example.COM", "shop.example.com"],
    ["example.com", "example.com"],
    ["a.b.c.d.example.com", "a.b.c.d.example.com"],
    ["shop-1.example.com", "shop-1.example.com"],
    ["1shop.example.com", "1shop.example.com"],
    /* Punycode is an ordinary label, and an internationalized name is the one
       thing an operator cannot type any other way. */
    ["xn--caf-dma.example.com", "xn--caf-dma.example.com"],
    ["XN--CAF-DMA.example.com", "xn--caf-dma.example.com"],
    ["9.example.com", "9.example.com"],
    [`${"a".repeat(63)}.example.com`, `${"a".repeat(63)}.example.com`],
  ];

  for (const [written, stored] of accepted) {
    it(`takes "${written}" as "${stored}"`, () => {
      expect(normalizeCustomDomain(written)).toBe(stored);
    });
  }

  /* Every refusal class, and the word the detail has to carry so whoever typed
     it reads which rule it broke rather than "invalid". */
  const refused: Array<[written: string, says: string]> = [
    ["", "empty"],
    ["https://shop.example.com", "scheme"],
    ["shop.example.com/cart", "scheme"],
    ["*.example.com", "wildcard"],
    ["shop.example.com:8443", "port"],
    ["2001:db8::1", "port"],
    ["shop.example.com.", "trailing dot"],
    ["localhost", "fully qualified"],
    ["example", "fully qualified"],
    ["shop..example.com", "empty label"],
    [".example.com", "empty label"],
    ["shop_1.example.com", "letters, digits and hyphens"],
    ["shop!.example.com", "letters, digits and hyphens"],
    ["-shop.example.com", "hyphen"],
    ["shop-.example.com", "hyphen"],
    ["203.0.113.7", "all digits"],
    [`${"a".repeat(64)}.example.com`, "63 characters"],
    [`${`${"a".repeat(60)}.`.repeat(5)}example.com`, `${String(HOST_MAX_LENGTH)} a DNS name`],
  ];

  for (const [written, says] of refused) {
    it(`refuses "${written}" and says why`, async () => {
      const error = await rejectsWith(
        () => Promise.resolve(normalizeCustomDomain(written)),
        "invalid-input",
      );

      expect(error.status).toBe(400);
      expect(error.detail, error.detail).toContain(says);
    });
  }
});

describe("the one label below a host", () => {
  it("splits a name into its first label and the base under it", () => {
    expect(splitHostLabel("preview.shop.example.com")).toEqual({
      label: "preview",
      base: "shop.example.com",
    });
    /* One label, exactly as a TLS wildcard covers one: the deeper name splits
       onto a DIFFERENT base, which is a claim nobody made. */
    expect(splitHostLabel("a.b.shop.example.com")).toEqual({
      label: "a",
      base: "b.shop.example.com",
    });
  });

  it("answers null where there is no base to be one label under", () => {
    /* A base has to be fully qualified itself, or `www.example` would put a
       claim on `example` in the way of one on a public suffix. */
    expect(splitHostLabel("shop.example")).toBeNull();
    expect(splitHostLabel("example")).toBeNull();
    expect(splitHostLabel(".example.com")).toBeNull();
    expect(splitHostLabel("sh_op.example.com")).toBeNull();
  });

  it("writes and reads the key a routing document names the set with", () => {
    expect(wildcardHost("shop.example.com")).toBe("*.shop.example.com");
    expect(wildcardBase("*.shop.example.com")).toBe("shop.example.com");
    expect(wildcardBase("shop.example.com")).toBeNull();
  });
});

describe("the family a wildcard base stands for", () => {
  it("joins and splits the name an environment carries under its holder's base", () => {
    expect(familyApplication("shop", "preview")).toBe("shop-preview");
    expect(familyLabel("shop", "shop-preview")).toBe("preview");
    /* A label may itself hold hyphens: `--env pull-request-7` is one name. */
    expect(familyLabel("shop", "shop-pull-request-7")).toBe("pull-request-7");

    expect(familyLabel("shop", "shop")).toBeNull();
    expect(familyLabel("shop", "shopping")).toBeNull();
    expect(familyApplication("shop", "-bad")).toBeNull();
  });

  it("counts the holder and its own environments as the family, and nothing else", () => {
    expect(isFamilyApplication("shop", "shop")).toBe(true);
    expect(isFamilyApplication("shop", "shop-preview")).toBe(true);
    expect(isFamilyApplication("shop", "shopping")).toBe(false);
    expect(isFamilyApplication("shop", "blog")).toBe(false);
  });
});

describe("deploy ids", () => {
  const TOKEN = "0123456789abcdef";

  it("reads back the application name of every id it is given", () => {
    for (const name of ["shop", "shop-preview", "shop2", "shop-2-preview", "a", "a1-b2-c3"]) {
      const id = `${name}.${TOKEN}`;

      expect(parseDeployId(id)).toEqual({ application: name, token: TOKEN });
      expect(() => assertDeployId(id)).not.toThrow();
    }
  });

  it("reads back every generated name, whatever hyphens and digits it carries", () => {
    const rng = seededRng(0x5ca10_002);

    for (let i = 0; i < PROPERTY_ITERATIONS; i++) {
      const name = randomSlug(rng, 20);

      expect(parseDeployId(`${name}.${TOKEN}`)).toEqual({ application: name, token: TOKEN });
    }
  });

  it("refuses an id whose first half is not an application name", () => {
    for (const name of ["-shop", "shop-", "shop--preview", "SHOP", "shop_preview", ""]) {
      expect({ name, parsed: parseDeployId(`${name}.${TOKEN}`) }).toEqual({ name, parsed: null });
    }
  });

  it("refuses an id whose second half is not sixteen hex characters", () => {
    for (const token of ["", "0123456789abcde", "0123456789abcdef0", "0123456789ABCDEF", "zzzz"]) {
      expect({ token, parsed: parseDeployId(`shop.${token}`) }).toEqual({ token, parsed: null });
    }
  });

  it("refuses an id with no separator at all, naming what was typed", async () => {
    expect(parseDeployId(`shop${TOKEN}`)).toBeNull();

    const error = await rejectsWith(() => Promise.resolve(assertDeployId("shop")), "invalid-slug");
    expect(error.detail).toContain('"shop"');
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
        jitter: (windowMs: number) => Math.floor(windowMs * 0.5),
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
          { attempts: 5, baseMs: 10_000, jitter: (windowMs: number) => windowMs, sleep: nap },
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
            jitter: (windowMs: number) => windowMs,
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
          /* Settles last and wins, because a sequential loop would have stopped
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
