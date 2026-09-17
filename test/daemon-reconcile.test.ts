import { describe, expect, it, vi } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { createDeployment } from "../src/core/registry/deployments.ts";
import { createEnvironment } from "../src/core/registry/environments.ts";
import { acquireLease } from "../src/core/registry/lease.ts";
import { getNode, registerNode } from "../src/core/registry/nodes.ts";
import { nodeKey } from "../src/core/registry/paths.ts";
import { writePlacement } from "../src/core/registry/placement.ts";
import { createProject } from "../src/core/registry/projects.ts";
import { putVarset, setEnvironmentVarset } from "../src/core/registry/varsets.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { RuntimeDriver, RuntimeSpecInput } from "../src/core/types/runtime.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import type { RoutingAttribution } from "../src/daemon/access-counters.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createHeartbeat } from "../src/daemon/heartbeat.ts";
import { createReconciler } from "../src/daemon/reconcile.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENV = "production";
const VERSION_ONE = "1111aaaa";
const VERSION_TWO = "2222bbbb";
/** The Celld this node booted with; what every other node's is compared against. */
const CELLD_VERSION = "0.5.0";

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
    });
  });

  it("forgets a process that ended on its own once a pass has read its exit", async () => {
    const world = await seededWorld();
    /* Left behind by an environment this node no longer serves, so nothing in
       the plan would name it: the pass reads it, and that is the whole of it. */
    world.supervisor.exited("shop--retired");

    await world.reconciler.runOnce();

    expect(world.supervisor.list().map((status) => status.id)).toEqual(["shop--production"]);
    expect(world.reconciler.status().processes.map((process) => process.processId)).toEqual([
      "shop--production",
    ]);
  });

  it("takes no runtime action for a new deployment revision", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    await createDeployment(world.daemon.registry, PROJECT, { version: VERSION_TWO });
    await recordRevision(world.daemon.registry, PROJECT, ENV, VERSION_TWO);

    expect(await world.reconciler.runOnce()).toEqual([]);
    expect(world.events).toEqual(["ingress:2"]);
    expect(world.supervisor.started).toHaveLength(1);
  });

  it("takes no runtime action when the environment's varset changes", async () => {
    /* A varset travels with the next deploy, so nothing running is touched. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    await putVarset(world.daemon.registry, PROJECT, { name: "shared", vars: { TOKEN: "next" } });
    await setEnvironmentVarset(world.daemon.registry, PROJECT, ENV, "shared");

    expect(await world.reconciler.runOnce()).toEqual([]);
    expect(world.events).toEqual(["ingress:2"]);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.supervisor.stopped).toEqual([]);
  });

  it("stops a process whose spawn completes after reconciliation shuts down", async () => {
    const world = await seededWorld();

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

    expect(world.supervisor.stopped).toEqual(["shop--production"]);
    expect(world.supervisor.list()).toEqual([]);
  });

  it("quarantines a failed stop and retries it before serving again", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    const lease = await acquireLease(world.daemon.registry, "coordinator");
    if (lease === null) throw new Error("lease unavailable");
    await writePlacement(world.daemon.registry, PROJECT, ENV, ["node-b"], lease);
    world.supervisor.stopFailures = 1;

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({ teardownPending: true });

    /* Placed here again while the stop is still owed: the teardown is retried
       before anything else, and only then may the environment be served. */
    await writePlacement(world.daemon.registry, PROJECT, ENV, ["node-a"], lease);
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

describe("what a node tells the fleet it serves", () => {
  it("says nothing until it has looked at its own processes", async () => {
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);

    await heartbeat.beat();

    const record = await getNode(world.daemon.registry, "node-a");
    expect(record.heartbeatAt).toBeDefined();
    expect(record.serving).toBeUndefined();
  });

  it("publishes a started process at once, and drops a stopped one at once", async () => {
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);

    await world.reconciler.runOnce();
    /* The pass beat the heartbeat out of turn; let that beat land. */
    await heartbeat.beat();
    expect((await getNode(world.daemon.registry, "node-a")).serving).toEqual({
      "shop/production": { port: 42_000 },
    });

    const lease = await acquireLease(world.daemon.registry, "coordinator");
    if (lease === null) throw new Error("lease unavailable");
    await writePlacement(world.daemon.registry, PROJECT, ENV, ["node-b"], lease);
    await world.reconciler.runOnce();
    await heartbeat.beat();
    expect((await getNode(world.daemon.registry, "node-a")).serving).toEqual({});
  });

  it("beats out of turn only when what it serves has changed", async () => {
    const world = await seededWorld();
    let beats = 0;
    world.daemon.heartbeat = {
      start() {},
      stop() {},
      beat: async () => {
        beats++;
      },
      status: () => ({ lastBeatAt: null, lastFailure: null }),
    };

    await world.reconciler.runOnce();
    expect(beats).toBe(1);
    await world.reconciler.runOnce();
    await world.reconciler.runOnce();
    expect(beats).toBe(1);
  });

  it("runs one more beat for a call that arrived while a beat was in flight", async () => {
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);
    const store = world.daemon.registry.store;
    let writes = 0;
    const put = store.put.bind(store);
    store.put = async (...args) => {
      writes++;
      return put(...args);
    };

    const first = heartbeat.beat();
    const second = heartbeat.beat();
    const third = heartbeat.beat();
    await Promise.all([first, second, third]);

    /* Three calls, two beats: the second and third had the same thing to say. */
    expect(writes).toBe(2);
  });
});

describe("an environment another node serves on a different Celld", () => {
  it("is not started here, and says which node holds it on what", async () => {
    const world = await seededWorld();
    await registerNode(world.daemon.registry, otherNode("node-b", "0.4.1"));

    await world.reconciler.runOnce();

    expect(world.supervisor.started).toEqual([]);
    /* Not even a spec: nothing about the process is built before the refusal. */
    expect(world.events).not.toContain("spec");
    const [failure] = world.reconciler.status().failures;
    expect(failure).toMatchObject({
      action: "start",
      subject: "shop--production",
      code: "version-skew",
    });
    expect(failure?.detail).toContain("node-b");
    expect(failure?.detail).toContain("0.4.1");
  });

  it("leaves nothing behind for the fleet to route to", async () => {
    /* A start that did not happen must not reach the heartbeat: a node that
       announced this environment would take traffic it cannot answer. */
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);
    await registerNode(world.daemon.registry, otherNode("node-b", "0.4.1"));

    await world.reconciler.runOnce();
    await heartbeat.beat();

    expect(world.reconciler.status().processes).toEqual([]);
    expect((await getNode(world.daemon.registry, "node-a")).serving).toEqual({});
  });

  it("is written to the log once, and once more when it clears", async () => {
    const world = await seededWorld();
    await registerNode(world.daemon.registry, otherNode("node-b", "0.4.1"));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await world.reconciler.runOnce();
      await world.reconciler.runOnce();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("scafo: reconcile start shop--production failed [version-skew]");
      expect(lines[0]).toContain("node-b");

      await world.daemon.registry.store.del(nodeKey("node-b"));
      await world.reconciler.runOnce();
      await world.reconciler.runOnce();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe("scafo: reconcile start shop--production no longer fails");
    } finally {
      spy.mockRestore();
    }
  });

  it("starts on the next pass once that node is gone", async () => {
    const world = await seededWorld();
    await registerNode(world.daemon.registry, otherNode("node-b", "0.4.1"));
    await world.reconciler.runOnce();

    await world.daemon.registry.store.del(nodeKey("node-b"));

    await world.reconciler.runOnce();
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.reconciler.status().failures).toEqual([]);
  });

  it("starts while that node runs the same Celld", async () => {
    const world = await seededWorld();
    await registerNode(world.daemon.registry, otherNode("node-b", CELLD_VERSION));

    await world.reconciler.runOnce();

    expect(world.supervisor.started).toHaveLength(1);
    expect(world.reconciler.status().failures).toEqual([]);
  });
});

describe("the fleet routing a pass leaves behind", () => {
  it("is unknown before the first pass, then lists every live node serving, this one included", async () => {
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);
    await registerNode(world.daemon.registry, {
      v: 1,
      id: "node-b",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "b" },
      addresses: { internal: "10.0.0.2", apiPort: 7400 },
      heartbeatAt: new Date().toISOString(),
      versions: { scafo: "test", celld: CELLD_VERSION },
      serving: { "shop/production": { port: 42_010 } },
    });
    /* Not the empty document: that one says the fleet answers on nothing, which
       is something this node has not read yet and an ingress would act on. */
    expect(world.reconciler.fleetRouting()).toBeUndefined();

    await world.reconciler.runOnce();
    /* This node's own process reaches the routing the way every node's does:
       through its record, so it shows up one pass after it started. */
    expect(world.reconciler.fleetRouting()?.routes.map((route) => route.upstreams)).toEqual([
      [{ node: "node-b", address: "10.0.0.2:42010" }],
      [{ node: "node-b", address: "10.0.0.2:42010" }],
    ]);

    await heartbeat.beat();
    await world.reconciler.runOnce();
    expect(world.reconciler.fleetRouting()?.routes[0]).toEqual({
      host: "shop--production.apps.test",
      project: PROJECT,
      env: ENV,
      upstreams: [
        { node: "node-a", address: "127.0.0.1:42000" },
        { node: "node-b", address: "10.0.0.2:42010" },
      ],
    });
  });
});

/** Another machine, answering now and telling the fleet it serves this environment. */
function otherNode(id: string, celld: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: id },
    addresses: { internal: "10.0.0.2", apiPort: 7400 },
    heartbeatAt: new Date().toISOString(),
    versions: { scafo: "test", celld },
    serving: { [`${PROJECT}/${ENV}`]: { port: 42_010 } },
  };
}

async function attachHeartbeat(world: Awaited<ReturnType<typeof seededWorld>>) {
  await registerNode(world.daemon.registry, {
    v: 1,
    id: "node-a",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "a" },
    addresses: { internal: "127.0.0.1", apiPort: 7401 },
  });
  const heartbeat = createHeartbeat(world.daemon);
  world.daemon.heartbeat = heartbeat;
  return heartbeat;
}

async function seededWorld() {
  const registry = ctxWith(new MemoryCasStore());
  await createProject(registry.ctx, { slug: PROJECT });
  await createEnvironment(registry.ctx, PROJECT, { name: ENV });
  await createDeployment(registry.ctx, PROJECT, { version: VERSION_ONE });
  await recordRevision(registry.ctx, PROJECT, ENV, VERSION_ONE);
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
    versions: { scafo: "test", celld: CELLD_VERSION },
    /* The one thing a pass still does with its own routing once execution is
       over: hand it to the counters, so a host is counted as whoever the pass
       decided it belongs to. Recording it here is what puts the routing in the
       event order below, where the driver call used to be. */
    ingressCounters: {
      ingest: () => {},
      snapshot: () => {
        throw new Error("no snapshot is taken here");
      },
      observeRouting(routing: RoutingAttribution) {
        events.push(`ingress:${String(routing.routes.length)}`);
      },
    },
  };
  const reconciler = createReconciler(daemon, driver, { baseEnv: { PATH: "/bin" } });
  daemon.reconciler = reconciler;
  return { daemon, reconciler, supervisor, driver, events };
}

interface FakeSupervisor extends Supervisor {
  started: ProcessSpec[];
  stopped: string[];
  stopFailures: number;
  startBarrier?: { entered: () => void; wait: Promise<void> };
  /** Records `id` as a process that ended without the supervisor asking. */
  exited: (id: string) => void;
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
    forget(id) {
      if (statuses.get(id)?.state === "running") return;
      statuses.delete(id);
    },
    onExit: () => {},
    exited(id) {
      statuses.set(id, {
        id,
        state: "exited",
        exitCode: 1,
        startedAt: new Date().toISOString(),
      });
    },
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
