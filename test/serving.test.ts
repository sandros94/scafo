import { describe, expect, it } from "vitest";
import { sameServing, servingOf } from "../src/core/placement/serving.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

function process(application: string, port: number): RuntimeProcess {
  return { application, port, internalPort: port + 1 };
}

describe("what a node publishes as served", () => {
  it("lists every process by application name with its public port, in one order", () => {
    const serving = servingOf([process("shop", 42_002), process("blog", 42_000)]);

    expect(Object.keys(serving)).toEqual(["blog", "shop"]);
    expect(serving).toEqual({
      blog: { port: 42_000 },
      shop: { port: 42_002 },
    });
  });

  it("keeps a process whose stop is still pending: it may still be answering", () => {
    const stuck: RuntimeProcess = { ...process("shop", 42_000), teardownPending: true };

    expect(servingOf([stuck])).toEqual({ shop: { port: 42_000 } });
  });

  it("compares by content, treating an absent set as an empty one", () => {
    const a = servingOf([process("shop", 42_000)]);

    expect(sameServing(a, { shop: { port: 42_000 } })).toBe(true);
    expect(sameServing(a, { shop: { port: 42_002 } })).toBe(false);
    expect(sameServing(a, {})).toBe(false);
    expect(sameServing(undefined, {})).toBe(true);
    expect(sameServing(servingOf([]), undefined)).toBe(true);
  });
});
