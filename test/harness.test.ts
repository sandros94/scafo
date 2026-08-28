import { describe, expect, it } from "vitest";
import { createBucket, run } from "./integration/_harness.ts";

describe("createBucket", () => {
  it("bounds a blocked request before it can consume store readiness", async () => {
    const blocked: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });

    await expect(
      createBucket("http://store.test", "scafo", {
        fetchFn: blocked,
        deadlineMs: 5,
        attemptTimeoutMs: 1,
      }),
    ).rejects.toThrow("bucket request timed out");
  });
});

describe("run", () => {
  it("returns a bounded timeout for a command that never exits", async () => {
    const result = await run(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      process.cwd(),
      process.env as Record<string, string>,
      { timeoutMs: 10 },
    );

    expect(result).toEqual({ code: -1, output: "command timed out after 10ms" });
  });
});
