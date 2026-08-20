/*
 * The runtime driver for celld: the process spec one environment runs under, the
 * deployment pointer that decides which version a starting process loads, and
 * the readiness gate that says when it may take traffic.
 *
 * Nothing here starts a process or opens a socket. The bucket is a memory store,
 * and the gate is driven by an injected `fetch` that answers whatever a case
 * needs it to.
 */

import { describe, expect, it } from "vitest";
import type { CapacityPlan } from "../src/core/capacity/compute.ts";
import { ScaloError } from "../src/core/error.ts";
import { putJson, readJson } from "../src/core/registry/cas.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { fleetPrefix } from "../src/core/registry/paths.ts";
import type { BuildRecord, EnvironmentRecord, PlainVarset } from "../src/core/types/registry.ts";
import type { RuntimeDriver, RuntimeProcess, RuntimeSpecInput } from "../src/core/types/runtime.ts";
import type { CasStore } from "../src/core/types/store.ts";
import {
  createCelldDriver,
  DEFAULT_STOP_GRACE_MS,
  HEALTH_PATH,
} from "../src/drivers/runtime/celld.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, rejectsWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENVIRONMENT = "prod";
const BUILD_ID = "1111aaaa";

/** Where this environment's fleet state lives, and the name it deploys under. */
const FLEET = fleetPrefix(PROJECT, ENVIRONMENT);
const SCRIPT = "shop-prod";

const CURRENT_VERSION = "20260101-aaaa";
const NEXT_VERSION = "20260102-bbbb";

/** The two objects an activation moves, in the order it must move them. */
const NAMED_POINTER = `${FLEET}/deploy/${SCRIPT}/current.json`;
const FLEET_POINTER = `${FLEET}/deploy/current.json`;

/** Variables the driver derives itself and refuses from a caller. */
const RESERVED_ENV = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "CELLD_BUCKET",
  "CELLD_ADDR",
  "CELLD_INTERNAL_ADDR",
  "CELLD_ADVERTISE",
  "CELLD_SHUTDOWN_DRAIN_MS",
  "CELLD_DURABILITY",
  "CELLD_LTX_S3_BUCKET",
  "CELLD_LTX_S3_ENDPOINT",
  "CELLD_NODE",
  "CELLD_CLOUD",
  "CELLD_CONTROL_URL",
  "CELLD_UNSAFE_PUBLIC_ADVERTISE",
];

/** Never set, in any version of a spec: it corrupts cells that are evicted while idle. */
const IDLE_EVICT_ENV = "CELLD_IDLE_EVICT_S";

describe("the spec one environment runs under", () => {
  it("names the process after what it serves and runs the configured executable", () => {
    const driver = createCelldDriver({ store: new MemoryCasStore(), binPath: "/opt/celld/bin" });

    const spec = driver.processSpec(specInput());

    expect(spec.id).toBe(`${PROJECT}--${ENVIRONMENT}--${BUILD_ID}`);
    expect(spec.command).toBe("/opt/celld/bin");
  });

  it("falls back to resolving the runtime against PATH", () => {
    const spec = driver().processSpec(specInput());

    expect(spec.command).toBe("celld");
  });

  it("points the process at its own fleet, its listeners and the address peers use", () => {
    const spec = driver().processSpec(specInput({ ports: { public: 42_010, internal: 42_011 } }));

    expect(spec.args).toEqual([
      "--bucket",
      `registry/${FLEET}`,
      "--endpoint",
      "http://store.test:9000",
      "--listen",
      "127.0.0.1:42010",
      "--internal-listen",
      "127.0.0.1:42011",
      "--advertise",
      "10.0.0.4:42011",
    ]);
  });

  it("binds both listeners to the address the node configured", () => {
    const spec = driver().processSpec(
      specInput({ ports: { public: 42_010, internal: 42_011 }, node: { bindHost: "0.0.0.0" } }),
    );

    /*
     * What makes a fleet spread over several nodes work at all: peers dial the
     * advertised address to reach the process that owns a cell, and a listener
     * on loopback answers nothing that is not on the same host.
     */
    expect(spec.args).toEqual([
      "--bucket",
      `registry/${FLEET}`,
      "--endpoint",
      "http://store.test:9000",
      "--listen",
      "0.0.0.0:42010",
      "--internal-listen",
      "0.0.0.0:42011",
      "--advertise",
      "10.0.0.4:42011",
    ]);
  });

  it("puts the installation's key prefix in front of the fleet, however it is written", () => {
    for (const keyPrefix of ["tenant-a", "/tenant-a", "tenant-a/", "//tenant-a//"]) {
      const spec = driver().processSpec(specInput({ node: { keyPrefix } }));

      expect(spec.args[1], `for key prefix ${JSON.stringify(keyPrefix)}`).toBe(
        `registry/tenant-a/${FLEET}`,
      );
    }
  });

  it("carries the node's credentials, its region and the drain it must finish within", () => {
    const spec = driver().processSpec(specInput());

    expect(spec.env).toMatchObject({
      AWS_ACCESS_KEY_ID: "key-id",
      AWS_SECRET_ACCESS_KEY: "key-secret",
      AWS_REGION: "us-east-1",
      /* Five seconds below the grace, so a draining process is never killed
         mid-flight by the stop that follows. */
      CELLD_SHUTDOWN_DRAIN_MS: "25000",
      CELLD_TRUST_FORWARDED_HEADERS: "1",
      /* An acknowledged write is in the bucket — never a runtime default's
         call, whatever that default becomes. */
      CELLD_DURABILITY: "bucket",
    });
  });

  it("keeps the drain in step with a configured stop grace, never below its floor", () => {
    const cases: [number, string][] = [
      [DEFAULT_STOP_GRACE_MS, "25000"],
      [60_000, "55000"],
      [10_000, "5000"],
    ];

    for (const [graceMs, drainMs] of cases) {
      const configured = createCelldDriver({ store: new MemoryCasStore(), graceMs });
      const spec = configured.processSpec(specInput());

      expect(configured.stopGraceMs, `for a grace of ${String(graceMs)}ms`).toBe(graceMs);
      expect(spec.env.CELLD_SHUTDOWN_DRAIN_MS, `for a grace of ${String(graceMs)}ms`).toBe(drainMs);
      expect(Number(spec.env.CELLD_SHUTDOWN_DRAIN_MS)).toBeLessThan(graceMs);
    }
  });

  it("hands every variable of the environment's varset to the application verbatim", () => {
    const vars: PlainVarset = {
      DATABASE_URL: { value: "postgres://db.test/app", secret: true },
      FEATURE_FLAGS: { value: "beta", secret: false },
    };

    const spec = driver().processSpec(specInput({ vars }));

    expect(spec.env.CELLD_VAR_DATABASE_URL).toBe("postgres://db.test/app");
    expect(spec.env.CELLD_VAR_FEATURE_FLAGS).toBe("beta");
  });

  it("skips a variable with no name at all", () => {
    const spec = driver().processSpec(specInput({ vars: { "": { value: "x", secret: false } } }));

    expect(Object.keys(spec.env).filter((name) => name.startsWith("CELLD_VAR_"))).toEqual([]);
  });

  it("bounds the process by this node's capacity when a plan is given", () => {
    const spec = driver().processSpec(specInput({ capacity: capacityPlan() }));

    expect(spec.env).toMatchObject({ CELLD_MAX_RSS_MB: "1400", CELLD_MAX_RESIDENT_CELLS: "2000" });
  });

  it("leaves the runtime's own defaults in place without a plan, or with a degenerate one", () => {
    const withoutPlan = driver().processSpec(specInput());
    const degenerate = driver().processSpec(
      specInput({ capacity: { ...capacityPlan(), maxRssMbPerProcess: 0, maxResidentCells: 0 } }),
    );

    for (const env of [withoutPlan.env, degenerate.env]) {
      expect(Object.hasOwn(env, "CELLD_MAX_RSS_MB")).toBe(false);
      expect(Object.hasOwn(env, "CELLD_MAX_RESIDENT_CELLS")).toBe(false);
    }
  });

  it("starts from the environment the caller supplies, so a bare command still resolves", () => {
    /* A spec's environment replaces the child's rather than extending it: without
       the PATH carried through here, a runtime named without a directory could
       not be found at all. */
    const spec = driver().processSpec(specInput({ baseEnv: { PATH: "/usr/bin:/bin", TZ: "UTC" } }));

    expect(spec.env.PATH).toBe("/usr/bin:/bin");
    expect(spec.env.TZ).toBe("UTC");
  });

  it("overrides an inherited value that would disagree with the node's own settings", () => {
    const spec = driver().processSpec(
      specInput({ baseEnv: { PATH: "/usr/bin", AWS_REGION: "eu-west-1" } }),
    );

    expect(spec.env.AWS_REGION).toBe("us-east-1");
  });

  it("applies the caller's extra variables last, except the ones the driver derives", () => {
    const spec = driver().processSpec(
      specInput({ capacity: capacityPlan(), extraEnv: { CELLD_LOG_LEVEL: "debug" } }),
    );
    expect(spec.env.CELLD_LOG_LEVEL).toBe("debug");

    /* The derived caps and the forwarded-headers trust flag are refused, not
       silently overridden: they carry the node's resource and trust decisions. */
    for (const name of [
      "CELLD_MAX_RSS_MB",
      "CELLD_MAX_RESIDENT_CELLS",
      "CELLD_TRUST_FORWARDED_HEADERS",
    ]) {
      expect(() =>
        driver().processSpec(specInput({ capacity: capacityPlan(), extraEnv: { [name]: "1" } })),
      ).toThrowError(expect.objectContaining({ code: "invalid-input" }));
    }
  });
});

describe("what a caller may not put in a process's environment", () => {
  it("refuses to enable idle eviction, which would corrupt a cell that is evicted", async () => {
    const error = await rejectsWith(
      async () => driver().processSpec(specInput({ extraEnv: { [IDLE_EVICT_ENV]: "60" } })),
      "invalid-input",
    );

    expect(error.detail).toContain(IDLE_EVICT_ENV);
  });

  it("refuses every variable it derives from the node and from the process's listeners", async () => {
    for (const name of RESERVED_ENV) {
      const error = await rejectsWith(
        async () => driver().processSpec(specInput({ extraEnv: { [name]: "anything" } })),
        "invalid-input",
      );

      expect(error.detail, `for ${name}`).toContain(name);
    }
  });

  it("drops idle eviction out of an inherited environment without complaining", () => {
    const spec = driver().processSpec(
      specInput({ baseEnv: { PATH: "/usr/bin", [IDLE_EVICT_ENV]: "60" } }),
    );

    expect(Object.hasOwn(spec.env, IDLE_EVICT_ENV)).toBe(false);
    expect(spec.env.PATH).toBe("/usr/bin");
  });
});

describe("the grace a caller must give one of these processes", () => {
  it("is half a minute unless it is configured", () => {
    expect(driver().stopGraceMs).toBe(DEFAULT_STOP_GRACE_MS);
    expect(DEFAULT_STOP_GRACE_MS).toBe(30_000);
  });

  it("refuses a grace too short to contain a drain, or one that is not whole", async () => {
    for (const graceMs of [9_999, 5_000, 0, -1, 10_000.5, Number.NaN]) {
      const error = await rejectsWith(
        async () => createCelldDriver({ store: new MemoryCasStore(), graceMs }),
        "invalid-input",
      );

      expect(error.detail, `for a grace of ${String(graceMs)}ms`).toContain("10000");
    }
  });
});

describe("pointing a fleet at a version", () => {
  it("moves the named pointer before the fleet-wide one", async () => {
    const { store, ctx } = await seededFleet();
    const written: string[] = [];
    store.onBeforePut = (key: string): void => {
      written.push(key);
    };

    await createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION);

    /* celld reads the named pointer to select the application, so a writer that
       loses a race must lose it there rather than half-way through. */
    expect(written).toEqual([NAMED_POINTER, FLEET_POINTER]);
    expect(await pointerAt(ctx, FLEET_POINTER)).toMatchObject({
      script_name: SCRIPT,
      version: NEXT_VERSION,
      prefix: `deploy/${SCRIPT}/${NEXT_VERSION}`,
    });
    expect(await pointerAt(ctx, NAMED_POINTER)).toMatchObject({
      version: NEXT_VERSION,
      prefix: `deploy/${SCRIPT}/${NEXT_VERSION}`,
    });
  });

  it("keeps every field of a pointer it does not select a version with", async () => {
    const { store, ctx } = await seededFleet();

    await createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION);

    /* The pointer format belongs to the runtime, not to this platform: anything
       a newer runtime writes into it has to survive an activation. */
    expect(await pointerAt(ctx, FLEET_POINTER)).toMatchObject({
      rollout: { percent: 100 },
      written_by: "celld/0.2.1",
    });
    expect(await pointerAt(ctx, NAMED_POINTER)).toMatchObject({ rollout: { percent: 100 } });
  });

  it("creates a missing named pointer from the fleet-wide one", async () => {
    const { store, ctx } = await seededFleet({ namedPointer: false });

    await createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION);

    expect(await pointerAt(ctx, NAMED_POINTER)).toEqual({
      script_name: SCRIPT,
      version: NEXT_VERSION,
      prefix: `deploy/${SCRIPT}/${NEXT_VERSION}`,
      rollout: { percent: 100 },
      written_by: "celld/0.2.1",
    });
  });

  it("writes nothing when the fleet already serves the version", async () => {
    const { store } = await seededFleet({ pointerVersion: NEXT_VERSION });

    await createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION);

    /* Activation is planned again on every pass until a process for the build is
       running, so rewriting identical bytes would be pure bucket churn — and a
       race lost for nothing. */
    expect(store.puts).toBe(0);
  });

  it("recovers the deployment name from a pointer written without one", async () => {
    const { store, ctx } = await seededFleet({ scriptName: false });

    await createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION);

    expect(await pointerAt(ctx, NAMED_POINTER)).toMatchObject({ script_name: SCRIPT });
    expect(await pointerAt(ctx, FLEET_POINTER)).toMatchObject({ script_name: SCRIPT });
  });

  it("refuses a version whose modules were never uploaded", async () => {
    const { store } = await seededFleet({ manifest: false });

    const error = await rejectsWith(
      async () => createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION),
      "not-found",
    );

    expect(error.detail).toContain(`${FLEET}/deploy/${SCRIPT}/${NEXT_VERSION}/manifest.json`);
    expect(store.puts).toBe(0);
  });

  it("refuses a fleet that has never been deployed to", async () => {
    const store = new FaultStore(new MemoryCasStore());

    const error = await rejectsWith(
      async () => createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION),
      "not-found",
    );

    expect(error.detail).toContain(FLEET_POINTER);
    expect(store.puts).toBe(0);
  });

  it("refuses a pointer that names no deployment at all", async () => {
    const { store } = await seededFleet({ scriptName: false, pointerPrefix: "somewhere/else" });

    const error = await rejectsWith(
      async () => createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION),
      "store-nonconforming",
    );

    expect(error.detail).toContain(FLEET_POINTER);
    expect(store.puts).toBe(0);
  });

  it("surfaces a write it lost to a concurrent writer, once retrying stops helping", async () => {
    const { store, ctx } = await seededFleet();
    /* The named pointer goes through; every attempt at the fleet-wide one is
       taken by somebody else. */
    store.failAfter(1, conflict());

    const error = await rejectsWith(
      async () => createCelldDriver({ store }).activateVersion(FLEET, NEXT_VERSION),
      "cas-conflict",
    );

    expect(error.message).toContain(FLEET_POINTER);
    /* A lost activation is not atomic: the named pointer already moved, and the
       fleet-wide one still names the version it did before. */
    expect(await pointerAt(ctx, NAMED_POINTER)).toMatchObject({ version: NEXT_VERSION });
    expect(await pointerAt(ctx, FLEET_POINTER)).toMatchObject({ version: CURRENT_VERSION });
  });
});

describe("the readiness gate", () => {
  it("calls a process ready only once the runtime and the application both answer", async () => {
    const probe = probeFetch(() => 200);

    const ready = await driver().probeReady(runtimeProcess(), {
      ...probeSettings,
      fetchFn: probe.fetchFn,
    });

    expect(ready).toBe(true);
    expect(probe.urls).toEqual([`http://127.0.0.1:42010${HEALTH_PATH}`, "http://127.0.0.1:42010/"]);
  });

  it("refuses a process whose application fails, however healthy the runtime is", async () => {
    /* The runtime answers its own health endpoint from the process itself, so a
       process whose application fails every request still reports 200 there. */
    const probe = probeFetch((url) => (url.endsWith(HEALTH_PATH) ? 200 : 503));

    const ready = await driver().probeReady(runtimeProcess(), {
      ...probeSettings,
      attempts: 3,
      fetchFn: probe.fetchFn,
    });

    expect(ready).toBe(false);
    /* Every attempt asked both questions before giving up. */
    expect(probe.urls).toHaveLength(6);
  });

  it("refuses a process the runtime itself will not answer for, without asking the application", async () => {
    const probe = probeFetch(() => "down");

    const ready = await driver().probeReady(runtimeProcess(), {
      ...probeSettings,
      attempts: 2,
      fetchFn: probe.fetchFn,
    });

    expect(ready).toBe(false);
    expect(probe.urls).toEqual([
      `http://127.0.0.1:42010${HEALTH_PATH}`,
      `http://127.0.0.1:42010${HEALTH_PATH}`,
    ]);
  });

  it("waits out a process that is still starting, up to the attempts it is given", async () => {
    let attempt = 0;
    const probe = probeFetch((url) => {
      if (!url.endsWith(HEALTH_PATH)) return 200;
      attempt++;
      return attempt < 3 ? "down" : 200;
    });

    const ready = await driver().probeReady(runtimeProcess(), {
      ...probeSettings,
      attempts: 5,
      fetchFn: probe.fetchFn,
    });

    expect(ready).toBe(true);
  });

  it("holds the application to a status below the one it is given, boundary included", async () => {
    const cases: [number, number, boolean][] = [
      [499, 500, true],
      [500, 500, false],
      [500, 501, true],
      [404, 500, true],
    ];

    for (const [status, expectBelow, expected] of cases) {
      const probe = probeFetch((url) => (url.endsWith(HEALTH_PATH) ? 200 : status));

      const ready = await driver().probeReady(runtimeProcess(), {
        ...probeSettings,
        expectBelow,
        fetchFn: probe.fetchFn,
      });

      expect(ready, `for status ${String(status)} below ${String(expectBelow)}`).toBe(expected);
    }
  });

  it("asks the application at the path it is configured with, slash or no slash", async () => {
    for (const path of ["/healthz", "healthz"]) {
      const probe = probeFetch(() => 200);

      await driver().probeReady(runtimeProcess(), {
        ...probeSettings,
        path,
        fetchFn: probe.fetchFn,
      });

      expect(probe.urls[1], `for path ${JSON.stringify(path)}`).toBe(
        "http://127.0.0.1:42010/healthz",
      );
    }
  });

  it("probes the public listener of the process, not the one reserved for peers", async () => {
    const probe = probeFetch(() => 200);

    await driver().probeReady(
      { ...runtimeProcess(), port: 42_020, internalPort: 42_021 },
      { ...probeSettings, fetchFn: probe.fetchFn },
    );

    for (const url of probe.urls) expect(url.startsWith("http://127.0.0.1:42020")).toBe(true);
  });

  it("always asks at least once, however few attempts it is given", async () => {
    const probe = probeFetch(() => 500);

    const ready = await driver().probeReady(runtimeProcess(), {
      ...probeSettings,
      attempts: 0,
      fetchFn: probe.fetchFn,
    });

    expect(ready).toBe(false);
    expect(probe.urls).toEqual([`http://127.0.0.1:42010${HEALTH_PATH}`]);
  });
});

/** Gate settings every case shares: one attempt unless it says otherwise, no waiting. */
const probeSettings = { attempts: 1, delayMs: 0 };

/** A driver over an empty bucket; enough for everything but activation. */
function driver(store: CasStore = new MemoryCasStore()): RuntimeDriver {
  return createCelldDriver({ store });
}

interface SpecOverrides {
  vars?: PlainVarset | null;
  ports?: { public: number; internal: number };
  node?: { keyPrefix?: string; bindHost?: string };
  capacity?: CapacityPlan;
  baseEnv?: Record<string, string>;
  extraEnv?: Record<string, string>;
}

/** Everything one runtime process is materialized from. */
function specInput(overrides?: SpecOverrides): RuntimeSpecInput {
  const environment: EnvironmentRecord = {
    v: 1,
    name: ENVIRONMENT,
    prefix: FLEET,
    alias: { build: BUILD_ID, flippedAt: "2026-01-02T00:00:00.000Z" },
    split: null,
    domains: [],
    placement: "auto",
    ephemeral: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const build: BuildRecord = {
    v: 1,
    id: BUILD_ID,
    artifact: `artifacts/${PROJECT}/${BUILD_ID}.tar.zst`,
    celldVersionId: NEXT_VERSION,
    runtimeConfigurable: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const input: RuntimeSpecInput = {
    project: PROJECT,
    env: environment,
    build,
    vars: overrides?.vars ?? null,
    ports: overrides?.ports ?? { public: 42_010, internal: 42_011 },
    node: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key-id",
      secretKey: "key-secret",
      advertiseHost: "10.0.0.4",
      ...overrides?.node,
    },
  };
  if (overrides?.capacity !== undefined) input.capacity = overrides.capacity;
  if (overrides?.baseEnv !== undefined) input.baseEnv = overrides.baseEnv;
  if (overrides?.extraEnv !== undefined) input.extraEnv = overrides.extraEnv;
  return input;
}

/** What a node with a couple of gigabytes to spare would have probed. */
function capacityPlan(): CapacityPlan {
  return {
    cores: 4,
    memMb: 16_384,
    cgroup: false,
    threads: 4,
    isolates: 4,
    rssBudgetMb: 1400,
    maxRssMbPerProcess: 1400,
    maxResidentCells: 2000,
    probedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** One running process, as the gate is asked about it. */
function runtimeProcess(): RuntimeProcess {
  return {
    processId: `${PROJECT}--${ENVIRONMENT}--${BUILD_ID}`,
    project: PROJECT,
    env: ENVIRONMENT,
    build: BUILD_ID,
    port: 42_010,
    internalPort: 42_011,
    ready: false,
  };
}

interface FleetOptions {
  /** Version both pointers name before the activation. */
  pointerVersion?: string;
  /** Directory the pointer resolves modules under; defaults to the conventional one. */
  pointerPrefix?: string;
  /** Whether the pointers carry the deployment name as a field of their own. */
  scriptName?: boolean;
  /** Whether the per-deployment pointer exists yet. */
  namedPointer?: boolean;
  /** Whether the version being activated has its modules in the bucket. */
  manifest?: boolean;
}

/** A bucket holding one deployed fleet, plus the version an activation moves it to. */
async function seededFleet(
  opts?: FleetOptions,
): Promise<{ store: FaultStore; ctx: RegistryContext }> {
  const store = new FaultStore(new MemoryCasStore());
  const { ctx } = ctxWith(store);
  const version = opts?.pointerVersion ?? CURRENT_VERSION;

  const pointer: Record<string, unknown> = {
    version,
    prefix: opts?.pointerPrefix ?? `deploy/${SCRIPT}/${version}`,
    rollout: { percent: 100 },
    /* A field this platform does not know about, written by the runtime. */
    written_by: "celld/0.2.1",
  };
  if (opts?.scriptName !== false) pointer.script_name = SCRIPT;

  await putJson(ctx, FLEET_POINTER, pointer);
  if (opts?.namedPointer !== false) await putJson(ctx, NAMED_POINTER, pointer);
  if (opts?.manifest !== false) {
    await putJson(ctx, `${FLEET}/deploy/${SCRIPT}/${NEXT_VERSION}/manifest.json`, { modules: [] });
  }

  store.puts = 0;
  return { store, ctx };
}

/** The pointer object stored at `key`, whatever fields it carries. */
async function pointerAt(ctx: RegistryContext, key: string): Promise<Record<string, unknown>> {
  const found = await readJson<Record<string, unknown>>(ctx, key);
  expect(found, `no object at "${key}"`).not.toBeNull();
  return found?.value ?? {};
}

/** The failure a writer sees when somebody else got to the object first. */
function conflict(): Error {
  return new ScaloError("cas-conflict", `Conditional write failed for "${FLEET_POINTER}"`, {
    detail: "the object changed under the write",
  });
}

interface ProbeFetch {
  fetchFn: typeof fetch;
  /** URLs the gate requested, in order. */
  urls: string[];
}

/** A `fetch` answering with the status `answer` decides, or refusing to connect. */
function probeFetch(answer: (url: string) => number | "down"): ProbeFetch {
  const urls: string[] = [];
  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);

    const status = answer(url);
    return status === "down"
      ? Promise.reject(new Error(`connection refused by ${url}`))
      : Promise.resolve(new Response(null, { status }));
  };
  return { fetchFn: fetchFn as typeof fetch, urls };
}
