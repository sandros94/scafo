import { describe, expect, it } from "vitest";
import { sameServing, servingOf } from "../src/core/placement/serving.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

function process(project: string, env: string, port: number): RuntimeProcess {
  return { processId: `${project}--${env}`, project, env, port, internalPort: port + 1 };
}

describe("what a node publishes as served", () => {
  it("lists every process by project/env with its public port, in one order", () => {
    const serving = servingOf([
      process("shop", "production", 42_002),
      process("blog", "main", 42_000),
    ]);

    expect(Object.keys(serving)).toEqual(["blog/main", "shop/production"]);
    expect(serving).toEqual({
      "blog/main": { port: 42_000 },
      "shop/production": { port: 42_002 },
    });
  });

  it("keeps a process whose stop is still pending: it may still be answering", () => {
    const stuck: RuntimeProcess = {
      ...process("shop", "production", 42_000),
      teardownPending: true,
    };

    expect(servingOf([stuck])).toEqual({ "shop/production": { port: 42_000 } });
  });

  it("compares by content, treating an absent set as an empty one", () => {
    const a = servingOf([process("shop", "production", 42_000)]);

    expect(sameServing(a, { "shop/production": { port: 42_000 } })).toBe(true);
    expect(sameServing(a, { "shop/production": { port: 42_002 } })).toBe(false);
    expect(sameServing(a, {})).toBe(false);
    expect(sameServing(undefined, {})).toBe(true);
    expect(sameServing(servingOf([]), undefined)).toBe(true);
  });
});
