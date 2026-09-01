import { describe, expect, it } from "vitest";
import { deployBaseEnv } from "../src/cli/commands/sail.ts";

describe("the deploy process environment", () => {
  it("inherits the bounded runtime context and Celld's builder path only", () => {
    expect(
      deployBaseEnv({
        PATH: "/usr/bin",
        HOME: "/home/scafo",
        TMPDIR: "/tmp",
        TZ: "UTC",
        RUST_LOG: "info",
        CELLD_ESBUILD: "/opt/esbuild",
        CELLD_TTL_MS: "60000",
        SCAFO_S3_SECRET_KEY: "secret",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/scafo",
      TMPDIR: "/tmp",
      TZ: "UTC",
      RUST_LOG: "info",
      CELLD_ESBUILD: "/opt/esbuild",
    });
  });
});
