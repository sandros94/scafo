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

  it("carries the engine client and image platform an operator named to the publish alone", () => {
    const named = {
      PATH: "/usr/bin",
      CELLD_DOCKER: "podman",
      CELLD_CONTAINER_PLATFORM: "linux/arm64",
    };

    expect(deployBaseEnv(named)).toEqual(named);
    expect(runtimeBaseEnv(named)).toEqual({ PATH: "/usr/bin" });
  });

  it("carries the Python runtime cache and the per-file asset limit an operator named to the publish alone", () => {
    const named = {
      PATH: "/usr/bin",
      CELLD_PYTHON_RUNTIME_DIR: "/var/lib/scafo/pyodide",
      CELLD_MAX_ASSET_FILE_BYTES: "52428800",
    };

    expect(deployBaseEnv(named)).toEqual(named);
    expect(runtimeBaseEnv(named)).toEqual({ PATH: "/usr/bin" });
  });

  it("names no Python runtime cache or asset limit when the daemon was given none", () => {
    const base = deployBaseEnv({ PATH: "/usr/bin" });

    expect(base).not.toHaveProperty("CELLD_PYTHON_RUNTIME_DIR");
    expect(base).not.toHaveProperty("CELLD_MAX_ASSET_FILE_BYTES");
  });

  it("names no engine client or platform when the daemon was given none", () => {
    const base = deployBaseEnv({ PATH: "/usr/bin" });

    expect(base).not.toHaveProperty("CELLD_DOCKER");
    expect(base).not.toHaveProperty("CELLD_CONTAINER_PLATFORM");
  });
});
