import { describe, expect, it } from "vitest";
import { deployBaseEnv } from "../src/cli/commands/sail.ts";
import { runtimeBaseEnv } from "../src/daemon/reconcile.ts";

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

  it("carries the engine socket an operator named to the processes and to the publish", () => {
    const named = { PATH: "/usr/bin", DOCKER_HOST: "unix:///run/user/1000/docker.sock" };

    expect(runtimeBaseEnv(named)).toEqual(named);
    expect(deployBaseEnv(named)).toEqual(named);
  });

  it("names no socket when the daemon was given none", () => {
    expect(runtimeBaseEnv({ PATH: "/usr/bin" })).not.toHaveProperty("DOCKER_HOST");
    expect(deployBaseEnv({ PATH: "/usr/bin" })).not.toHaveProperty("DOCKER_HOST");
  });
});
