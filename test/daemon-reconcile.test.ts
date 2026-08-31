import { describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { createBuild } from "../src/core/registry/builds.ts";
import { createEnvironment, setEnvironmentVarset } from "../src/core/registry/environments.ts";
import { acquireLease } from "../src/core/registry/lease.ts";
import { writePlacement } from "../src/core/registry/placement.ts";
import { createProject } from "../src/core/registry/projects.ts";
import { importVarsetKey, putVarset, sealVarset } from "../src/core/registry/varsets.ts";
import type { RuntimeDriver, RuntimeSpecInput } from "../src/core/types/runtime.ts";
import type { IngressDesired } from "../src/core/types/ingress.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createReconciler } from "../src/daemon/reconcile.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENV = "production";
const BUILD_ONE = "1111aaaa";
const BUILD_TWO = "2222bbbb";

describe("environment-owned reconciliation", () => {
  it("starts one process and routes it as soon as the supervisor reports it running", async () => {
    const world = await seededWorld();
    expect(await world.reconciler.runOnce()).toEqual([
      {
        type: "start",
        project: PROJECT,
        env: ENV,
        ports: { public: 42_000, internal: 42_001 },
      },
    ]);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.events).toEqual(["spec", "start", "ingress:2"]);
    expect(world.reconciler.status().processes[0]).toMatchObject({
      processId: "shop--production",
      configuredVarset: null,
    });
  });

  it("takes no runtime action for a new deployment revision", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    await createBuild(world.daemon.registry, PROJECT, { id: BUILD_TWO, celldVersionId: BUILD_TWO });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    expect(await world.reconciler.runOnce()).toEqual([]);
    expect(world.events).toEqual(["ingress:2"]);
    expect(world.supervisor.started).toHaveLength(1);
  });

  it("prepares a changed varset before stopping, then restarts on the same ports", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    const id = await attachVarset(world, "next");

    expect(await world.reconciler.runOnce()).toEqual([
      {
        type: "restart",
        processId: "shop--production",
        project: PROJECT,
        env: ENV,
        ports: { public: 42_000, internal: 42_001 },
      },
    ]);
    expect(world.events).toEqual(["spec", "stop", "start", "ingress:2"]);
    expect(world.driver.inputs.at(-1)).toMatchObject({
      ports: { public: 42_000, internal: 42_001 },
      vars: { TOKEN: { value: "next", secret: true } },
    });
    expect(world.reconciler.status().processes[0]?.configuredVarset).toBe(id);
  });

  it("does not stop the old process when replacement configuration cannot be opened", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    await attachVarset(world, "next");
    delete world.daemon.varsetKey;

    await world.reconciler.runOnce();
    expect(world.events).toEqual(["ingress:2"]);
    expect(world.supervisor.stopped).toEqual([]);
    expect(world.reconciler.status().processes).toHaveLength(1);
    expect(world.reconciler.status().failures[0]).toMatchObject({ action: "restart" });
  });

  it("stops a replacement whose spawn completes after reconciliation shuts down", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    await attachVarset(world, "next");

    let entered!: () => void;
    let release!: () => void;
    const starting = new Promise<void>((resolve) => (entered = resolve));
    const barrier = new Promise<void>((resolve) => (release = resolve));
    world.supervisor.startBarrier = { entered, wait: barrier };

    const pass = world.reconciler.runOnce();
    await starting;
    const shutdown = world.reconciler.shutdown();
    release();
    await Promise.all([pass, shutdown]);

    expect(world.supervisor.stopped).toEqual(["shop--production", "shop--production"]);
    expect(world.supervisor.list()).toEqual([]);
  });

  it("quarantines a failed stop before considering another restart", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    await attachVarset(world, "next");
    world.supervisor.stopFailures = 1;

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({ teardownPending: true });
    expect((await world.reconciler.runOnce())[0]).toMatchObject({
      type: "stop",
      reason: "runtime teardown is pending",
    });
    expect(world.reconciler.status().processes).toEqual([]);
  });

  it("stops the process when placement removes this node", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    const lease = await acquireLease(world.daemon.registry, "coordinator");
    if (lease === null) throw new Error("lease unavailable");
    await writePlacement(world.daemon.registry, PROJECT, ENV, ["node-b"], lease);

    await world.reconciler.runOnce();
    expect(world.supervisor.stopped).toEqual(["shop--production"]);
    expect(world.reconciler.status().processes).toEqual([]);
  });
});

async function seededWorld() {
  const registry = ctxWith(new MemoryCasStore());
  await createProject(registry.ctx, { slug: PROJECT });
  await createEnvironment(registry.ctx, PROJECT, { name: ENV });
  await createBuild(registry.ctx, PROJECT, { id: BUILD_ONE, celldVersionId: BUILD_ONE });
  await recordDeployment(registry.ctx, PROJECT, ENV, BUILD_ONE);
  const lease = await acquireLease(registry.ctx, "coordinator");
  if (lease === null) throw new Error("lease unavailable");
  await writePlacement(registry.ctx, PROJECT, ENV, ["node-a"], lease);

  const events: string[] = [];
  const supervisor = fakeSupervisor(events);
  const driver = fakeDriver(events);
  const daemon: DaemonContext = {
    config: config(),
    nodeId: "node-a",
    registry: registry.ctx,
    supervisor,
    version: "test",
    ingress: {
      async apply(desired: IngressDesired) {
        events.push(`ingress:${String(desired.routes.length)}`);
      },
    },
  };
  daemon.varsetKey = await importVarsetKey(new Uint8Array(32).fill(7));
  const reconciler = createReconciler(daemon, driver, { baseEnv: { PATH: "/bin" } });
  daemon.reconciler = reconciler;
  return { daemon, reconciler, supervisor, driver, events };
}

async function attachVarset(world: Awaited<ReturnType<typeof seededWorld>>, value: string) {
  const sealed = await sealVarset(
    { TOKEN: { value, secret: true } },
    world.daemon.varsetKey as CryptoKey,
  );
  await putVarset(world.daemon.registry, PROJECT, sealed);
  await setEnvironmentVarset(world.daemon.registry, PROJECT, ENV, sealed.id);
  return sealed.id;
}

interface FakeSupervisor extends Supervisor {
  started: ProcessSpec[];
  stopped: string[];
  stopFailures: number;
  startBarrier?: { entered: () => void; wait: Promise<void> };
}

function fakeSupervisor(events: string[]): FakeSupervisor {
  const statuses = new Map<string, ProcessStatus>();
  const supervisor: FakeSupervisor = {
    started: [],
    stopped: [],
    stopFailures: 0,
    async start(spec) {
      events.push("start");
      supervisor.started.push(spec);
      const barrier = supervisor.startBarrier;
      supervisor.startBarrier = undefined;
      barrier?.entered();
      await barrier?.wait;
      const status: ProcessStatus = {
        id: spec.id,
        state: "running",
        pid: 1000,
        startedAt: new Date().toISOString(),
      };
      statuses.set(spec.id, status);
      return status;
    },
    async stop(id) {
      events.push("stop");
      supervisor.stopped.push(id);
      if (supervisor.stopFailures > 0) {
        supervisor.stopFailures--;
        throw new Error("stop failed");
      }
      statuses.delete(id);
    },
    status: (id) => statuses.get(id) ?? null,
    list: () => [...statuses.values()],
    onExit: () => {},
  };
  return supervisor;
}

interface FakeDriver extends RuntimeDriver {
  inputs: RuntimeSpecInput[];
}

function fakeDriver(events: string[]): FakeDriver {
  return {
    stopGraceMs: 30_000,
    inputs: [],
    processSpec(input) {
      events.push("spec");
      this.inputs.push(input);
      return { id: `${input.project}--${input.env.name}`, command: "celld", args: [], env: {} };
    },
  };
}

function config(): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "access",
      secretKey: "secret",
    },
    node: { id: "node-a", listen: "127.0.0.1:7400", advertise: "127.0.0.1:7401" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}
