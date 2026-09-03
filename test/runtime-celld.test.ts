import { describe, expect, it } from "vitest";
import { createCelldDriver, RESERVED_ENV } from "../src/drivers/runtime/celld.ts";
import type { RuntimeSpecInput } from "../src/core/types/runtime.ts";

describe("celld process specs", () => {
  it("leaves celld shutdown policy upstream-owned and waits beyond its default", () => {
    const driver = createCelldDriver({});
    const spec = driver.processSpec(specInput());

    expect(driver.stopGraceMs).toBe(45_000);
    expect(spec.env).not.toHaveProperty("CELLD_SHUTDOWN_TOTAL_MS");
    expect(spec.env).not.toHaveProperty("CELLD_SHUTDOWN_DRAIN_MS");
  });

  it("derives supervisor grace from the operator's celld shutdown bound", () => {
    const operatorEnv = {
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
      CELLD_SHUTDOWN_DRAIN_MS: "25000",
    };
    const driver = createCelldDriver({ operatorEnv });
    operatorEnv.CELLD_SHUTDOWN_TOTAL_MS = "120000";
    const spec = driver.processSpec(specInput());

    expect(driver.stopGraceMs).toBe(65_000);
    expect(spec.env).toMatchObject({
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
      CELLD_SHUTDOWN_DRAIN_MS: "25000",
    });
  });

  it.each(["", "0", "-1", "1.5", "unbounded", "2147478648"])(
    "refuses untimable CELLD_SHUTDOWN_TOTAL_MS=%j",
    (value) => {
      expect(() => createCelldDriver({ operatorEnv: { CELLD_SHUTDOWN_TOTAL_MS: value } })).toThrow(
        expect.objectContaining({ code: "invalid-input" }),
      );
    },
  );

  it("owns one stable process per environment and injects its varset", () => {
    const spec = createCelldDriver({ binPath: "/opt/celld" }).processSpec(specInput());
    expect(spec.id).toBe("shop--production");
    expect(spec.command).toBe("/opt/celld");
    expect(spec.args).toContain("bucket/fleets/shop/production");
    expect(spec.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      CELLD_VAR_TOKEN: "secret-token",
    });
    expect(spec.env).not.toHaveProperty("CELLD_MAX_RSS_MB");
    expect(spec.env).not.toHaveProperty("CELLD_MAX_RESIDENT_CELLS");
  });

  it("passes operator-owned celld policy through unchanged", () => {
    const spec = createCelldDriver({
      operatorEnv: {
        CELLD_DURABILITY: "bucket",
        CELLD_IDLE_EVICT_S: "900",
        CELLD_MAX_RSS_MB: "384",
        CELLD_MAX_RESIDENT_CELLS: "12",
      },
    }).processSpec(specInput());
    expect(spec.env).toMatchObject({
      CELLD_DURABILITY: "bucket",
      CELLD_IDLE_EVICT_S: "900",
      CELLD_MAX_RSS_MB: "384",
      CELLD_MAX_RESIDENT_CELLS: "12",
    });
  });

  it("drops an inherited vars file in favor of the environment varset", () => {
    const spec = createCelldDriver({
      operatorEnv: { CELLD_VARS_FILE: "/shared/vars" },
    }).processSpec(specInput());
    expect(spec.env).not.toHaveProperty("CELLD_VARS_FILE");
    expect(spec.env).toHaveProperty("CELLD_VAR_TOKEN", "secret-token");
  });

  it("refuses caller values reserved for node policy", () => {
    for (const name of RESERVED_ENV) {
      expect(() =>
        createCelldDriver({}).processSpec(specInput({ extraEnv: { [name]: "override" } })),
      ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    }
    expect(RESERVED_ENV).toContain("CELLD_VARS_FILE");
    expect(RESERVED_ENV).toContain("CELLD_DURABILITY");
    expect(RESERVED_ENV).toContain("CELLD_IDLE_EVICT_S");
    expect(RESERVED_ENV).not.toContain("CELLD_MAX_RSS_MB");
    expect(RESERVED_ENV).not.toContain("CELLD_MAX_RESIDENT_CELLS");
  });
});

function specInput(overrides?: Partial<RuntimeSpecInput>): RuntimeSpecInput {
  return {
    project: "shop",
    env: {
      v: 1,
      name: "production",
      prefix: "fleets/shop/production",
      deployment: { revision: 1, deployedAt: "2026-01-01T00:00:00.000Z" },
      domains: [],
      ephemeral: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    vars: { TOKEN: { value: "secret-token", secret: true } },
    ports: { public: 42010, internal: 42011 },
    node: {
      endpoint: "http://store.test",
      region: "us-east-1",
      bucket: "bucket",
      accessKey: "access",
      secretKey: "secret",
      advertiseHost: "127.0.0.1",
    },
    ...overrides,
  };
}
