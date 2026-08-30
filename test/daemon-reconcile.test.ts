import { describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { createBuild } from "../src/core/registry/builds.ts";
import { createEnvironment } from "../src/core/registry/environments.ts";
import { acquireLease } from "../src/core/registry/lease.ts";
import { writePlacement } from "../src/core/registry/placement.ts";
import { createProject } from "../src/core/registry/projects.ts";
import type { RuntimeAdoption, RuntimeDriver, RuntimeProcess } from "../src/core/types/runtime.ts";
import type { IngressDesired } from "../src/core/types/ingress.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { createCreditController, type CreditController } from "../src/daemon/_credit-controller.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createReconciler } from "../src/daemon/reconcile.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENV = "production";
const BUILD_ONE = "1111aaaa";
const BUILD_TWO = "2222bbbb";
const VERSION_ONE = `version-${BUILD_ONE}`;
const VERSION_TWO = `version-${BUILD_TWO}`;

describe("environment-owned reconciliation", () => {
  it("starts, gates and confirms one stable environment process", async () => {
    const world = await seededWorld();
    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([
      {
        type: "start",
        project: PROJECT,
        env: ENV,
        revision: 1,
        ports: { public: 42_000, internal: 42_001 },
      },
    ]);
    expect(world.supervisor.started.map((spec) => spec.id)).toEqual(["shop--production"]);
    expect(world.reconciler.status().processes).toEqual([
      expect.objectContaining({
        processId: "shop--production",
        attemptedRevision: 1,
        appliedRevision: 1,
        deployment: expect.objectContaining({ version: VERSION_ONE }),
        ready: true,
      }),
    ]);
    expect(world.credits.account).toMatchObject({ runtimeMb: 512, transitionMb: 0 });
  });

  it("adopts the next deployment in place under transient credit", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.driver.nextDeployment = deployment(VERSION_TWO, 2);
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    expect(await world.reconciler.runOnce()).toEqual([
      { type: "adopt", processId: "shop--production", revision: 2 },
    ]);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.driver.adoptions).toHaveLength(1);
    expect(world.reconciler.status().processes[0]).toMatchObject({
      attemptedRevision: 2,
      appliedRevision: 2,
      deployment: { version: VERSION_TWO },
      ready: true,
    });
    expect(world.credits.account).toMatchObject({ runtimeMb: 512, transitionMb: 0 });
  });

  it("gates an adopted deployment before routing it", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.driver.nextDeployment = deployment(VERSION_TWO, 2);
    world.driver.ready = false;
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({
      attemptedRevision: 2,
      appliedRevision: 2,
      deployment: { version: VERSION_TWO },
      ready: false,
    });
    expect(world.reconciler.status().failures).toContainEqual(
      expect.objectContaining({
        action: "await-ready",
        subject: "shop--production",
      }),
    );

    world.driver.ready = true;
    expect(await world.reconciler.runOnce()).toEqual([
      { type: "await-ready", processId: "shop--production" },
    ]);
    expect(world.reconciler.status().processes[0]).toMatchObject({ ready: true });
    expect(world.driver.adoptions).toHaveLength(1);
  });

  it("adopts a fixed revision after the preceding generation failed its gate", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.driver.nextDeployment = deployment(VERSION_TWO, 2);
    world.driver.ready = false;
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);
    await world.reconciler.runOnce();

    const buildThree = "3333cccc";
    const versionThree = `version-${buildThree}`;
    world.driver.adoption = {
      outcome: "confirmed",
      deployment: deployment(versionThree, 3),
    };
    world.driver.ready = true;
    await createBuild(world.daemon.registry, PROJECT, {
      id: buildThree,
      celldVersionId: versionThree,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, buildThree);

    expect(await world.reconciler.runOnce()).toEqual([
      { type: "adopt", processId: "shop--production", revision: 3 },
    ]);
    expect(world.reconciler.status().processes[0]).toMatchObject({
      appliedRevision: 3,
      deployment: { version: versionThree },
      ready: true,
    });
    expect(world.driver.adoptions).toHaveLength(2);
  });

  it("withdraws ingress before reloading and restores it only after the gate", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    world.driver.nextDeployment = deployment(VERSION_TWO, 2);
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    await world.reconciler.runOnce();
    expect(world.events).toEqual(["ingress:0", "adopt", "ingress:2"]);
  });

  it("suppresses a conclusively rejected revision while retaining the old ready generation", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.driver.adoption = {
      outcome: "rejected",
      version: VERSION_TWO,
      prefix: `deployments/main/${VERSION_TWO}`,
      error: "compile failed",
    };
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({
      attemptedRevision: 2,
      appliedRevision: 1,
      deployment: { version: VERSION_ONE },
      ready: true,
    });
    expect(world.reconciler.status().failures[0]).toMatchObject({ action: "adopt" });

    await world.reconciler.runOnce();
    expect(world.driver.adoptions).toHaveLength(1);
  });

  it("retries a transient adoption failure without changing confirmed state", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.driver.adoptionError = new Error("operator unavailable");
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    await world.reconciler.runOnce();
    await world.reconciler.runOnce();
    expect(world.driver.adoptions).toHaveLength(2);
    expect(world.reconciler.status().processes[0]).toMatchObject({
      attemptedRevision: 1,
      appliedRevision: 1,
      ready: true,
    });
    expect(world.credits.account).toMatchObject({ transitionMb: 0 });
  });

  it("leaves adoption pending when surge credit is unavailable", async () => {
    const credits = createCreditController({ allocatableMb: 512, surgeMb: 1 });
    const world = await seededWorld(credits);
    await world.reconciler.runOnce();
    world.events.length = 0;
    await createBuild(world.daemon.registry, PROJECT, {
      id: BUILD_TWO,
      celldVersionId: VERSION_TWO,
      runtimeConfigurable: true,
    });
    await recordDeployment(world.daemon.registry, PROJECT, ENV, BUILD_TWO);

    await world.reconciler.runOnce();
    expect(world.driver.adoptions).toEqual([]);
    expect(world.events).toEqual(["ingress:2"]);
    expect(world.reconciler.status().failures[0]).toMatchObject({
      action: "adopt",
      code: "capacity-unavailable",
    });
  });

  it("retries quarantined teardown before considering adoption", async () => {
    const world = await seededWorld();
    world.driver.ready = false;
    world.supervisor.stopFailures = 1;

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({ ready: false });
    expect(world.supervisor.stopped).toEqual(["shop--production"]);

    world.driver.ready = true;
    expect(await world.reconciler.runOnce()).toEqual([
      {
        type: "stop",
        processId: "shop--production",
        reason: "runtime teardown is pending",
      },
    ]);
    expect(world.supervisor.stopped).toEqual(["shop--production", "shop--production"]);
    expect(world.driver.adoptions).toEqual([]);
    expect(world.reconciler.status().processes).toEqual([]);
    expect(world.credits.account).toMatchObject({ runtimeMb: 0, transitionMb: 0 });
  });

  it("stops the stable process when placement removes this node", async () => {
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

async function seededWorld(credits?: CreditController) {
  const registry = ctxWith(new MemoryCasStore());
  await createProject(registry.ctx, { slug: PROJECT });
  await createEnvironment(registry.ctx, PROJECT, { name: ENV });
  await createBuild(registry.ctx, PROJECT, {
    id: BUILD_ONE,
    celldVersionId: VERSION_ONE,
    runtimeConfigurable: true,
  });
  await recordDeployment(registry.ctx, PROJECT, ENV, BUILD_ONE);
  const lease = await acquireLease(registry.ctx, "coordinator");
  if (lease === null) throw new Error("lease unavailable");
  await writePlacement(registry.ctx, PROJECT, ENV, ["node-a"], lease);

  const events: string[] = [];
  const supervisor = fakeSupervisor();
  const driver = fakeDriver(events);
  const controller = credits ?? createCreditController({ allocatableMb: 4096, surgeMb: 512 });
  const daemon: DaemonContext = {
    config: config(),
    nodeId: "node-a",
    registry: registry.ctx,
    supervisor,
    version: "test",
    credits: controller,
    ingress: {
      async apply(desired: IngressDesired) {
        events.push(`ingress:${String(desired.routes.length)}`);
      },
    },
  };
  const reconciler = createReconciler(daemon, driver, { baseEnv: { PATH: "/bin" } });
  daemon.reconciler = reconciler;
  return { daemon, reconciler, supervisor, driver, credits: controller, events };
}

interface FakeSupervisor extends Supervisor {
  started: ProcessSpec[];
  stopped: string[];
  stopFailures: number;
}

function fakeSupervisor(): FakeSupervisor {
  const statuses = new Map<string, ProcessStatus>();
  const supervisor: FakeSupervisor = {
    started: [],
    stopped: [],
    stopFailures: 0,
    async start(spec) {
      supervisor.started.push(spec);
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
  adoptions: RuntimeProcess[];
  adoption: RuntimeAdoption;
  adoptionError?: Error;
  nextDeployment: ReturnType<typeof deployment>;
  ready: boolean;
}

function fakeDriver(events: string[]): FakeDriver {
  const driver: FakeDriver = {
    stopGraceMs: 30_000,
    adoptions: [],
    adoption: { outcome: "confirmed", deployment: deployment(VERSION_TWO, 2) },
    nextDeployment: deployment(VERSION_ONE, 1),
    ready: true,
    processSpec(input) {
      return { id: `${input.project}--${input.env.name}`, command: "celld", args: [], env: {} };
    },
    async adoptCurrent(process) {
      events.push("adopt");
      driver.adoptions.push(process);
      if (driver.adoptionError !== undefined) throw driver.adoptionError;
      return driver.adoption;
    },
    async currentDeployment() {
      return driver.nextDeployment;
    },
    async probeReady() {
      return driver.ready;
    },
  };
  return driver;
}

function deployment(version: string, generation: number) {
  return { version, prefix: `deployments/main/${version}`, generation };
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
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 0,
      creditMb: 512,
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}
