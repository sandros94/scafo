import { describe, expect, it } from "vitest";
import { createCelldDriver, OPERATOR_RESERVED_ENV } from "../src/drivers/runtime/celld.ts";
import type { RuntimeSpecInput } from "../src/core/types/runtime.ts";

describe("celld process specs", () => {
  it("leaves celld shutdown policy upstream-owned and waits beyond its default", () => {
    const driver = createCelldDriver({});
    const spec = driver.processSpec(specInput());

    expect(driver.stopGraceMs).toBe(45_000);
    expect(spec.env).not.toHaveProperty("CELLD_SHUTDOWN_TOTAL_MS");
    expect(spec.env).not.toHaveProperty("CELLD_IDLE_EVICT_S");
  });

  it("derives supervisor grace from the operator's celld shutdown bound", () => {
    const operatorEnv = {
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
      CELLD_IDLE_EVICT_S: "900",
    };
    const driver = createCelldDriver({ operatorEnv });
    operatorEnv.CELLD_SHUTDOWN_TOTAL_MS = "120000";
    const spec = driver.processSpec(specInput());

    expect(driver.stopGraceMs).toBe(65_000);
    expect(spec.env).toMatchObject({
      CELLD_SHUTDOWN_TOTAL_MS: "60000",
      CELLD_IDLE_EVICT_S: "900",
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

  it("owns one stable process per application", () => {
    const spec = createCelldDriver({ binPath: "/opt/celld" }).processSpec(specInput());
    expect(spec.id).toBe("shop");
    expect(spec.command).toBe("/opt/celld");
    expect(spec.args).toContain("bucket/fleets/shop");
    expect(spec.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(spec.env).not.toHaveProperty("CELLD_MAX_RSS_MB");
    expect(spec.env).not.toHaveProperty("CELLD_MAX_RESIDENT_CELLS");
  });

  it("hands the process no variables of its own", () => {
    /* An application's variables travel in its deployed configuration, so a
       process is started with none of them in its own process environment. */
    const spec = createCelldDriver({
      operatorEnv: { CELLD_IDLE_EVICT_S: "900" },
    }).processSpec(specInput());

    expect(Object.keys(spec.env ?? {}).filter((name) => name.startsWith("CELLD_VAR_"))).toEqual([]);
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

  it("reserves only the variables it derives itself", () => {
    /* Scafo keeps no list of names upstream has stopped reading: a variable it
       does not derive is the operator's to set, and celld answers for its own. */
    expect(OPERATOR_RESERVED_ENV).not.toContain("CELLD_VARS_FILE");

    const spec = createCelldDriver({
      operatorEnv: { CELLD_VARS_FILE: "/shared/vars" },
    }).processSpec(specInput());
    expect(spec.env).toHaveProperty("CELLD_VARS_FILE", "/shared/vars");
  });
});

function specInput(overrides?: Partial<RuntimeSpecInput>): RuntimeSpecInput {
  return {
    application: {
      v: 1,
      name: "shop",
      deployment: { revision: 1, deployedAt: "2026-01-01T00:00:00.000Z" },
      domains: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
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
