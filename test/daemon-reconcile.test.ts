import { describe, expect, it, vi } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { createApplication } from "../src/core/registry/applications.ts";
import { createDeployment } from "../src/core/registry/deployments.ts";
import { acquireLease } from "../src/core/registry/lease.ts";
import { getNode, registerNode } from "../src/core/registry/nodes.ts";
import { applicationKey, nodeKey } from "../src/core/registry/paths.ts";
import { retireApplication } from "../src/core/registry/retirement.ts";
import { ScafoError } from "../src/core/error.ts";
import { writePlacement } from "../src/core/registry/placement.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { PortPair } from "../src/core/placement/ports.ts";
import type {
  RuntimeDriver,
  RuntimePorts,
  RuntimeProcess,
  RuntimeSpecInput,
} from "../src/core/types/runtime.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import type { RoutingAttribution } from "../src/daemon/access-counters.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createHeartbeat } from "../src/daemon/heartbeat.ts";
import { createReconciler } from "../src/daemon/reconcile.ts";
import { hintingStore, readChangeHint } from "../src/core/registry/changes.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const APP = "shop";
const VERSION_ONE = "1111aaaa";
const VERSION_TWO = "2222bbbb";
/** The Celld this node booted with; what every other node's is compared against. */
const CELLD_VERSION = "0.5.0";

describe("application-owned reconciliation", () => {
  it("starts one process and routes it as soon as the supervisor reports it running", async () => {
    const world = await seededWorld();
    expect(await world.reconciler.runOnce()).toEqual([{ type: "start", application: APP }]);
    expect(world.supervisor.started).toHaveLength(1);
    /* The directories the process works out of are made before it runs. */
    expect(world.events).toEqual(["spec", `prepare:${APP}`, "start", "ingress:1"]);
    expect(world.reconciler.status().processes[0]).toMatchObject({ application: APP });
  });

  it("forgets a process that ended on its own once a pass has read its exit", async () => {
    const world = await seededWorld();
    /* Left behind by an application this node no longer serves, so nothing in
       the plan would name it: the pass reads it, and that is the whole of it. */
    world.supervisor.exited("shop-retired");

    await world.reconciler.runOnce();

    expect(world.supervisor.list().map((status) => status.id)).toEqual([APP]);
    expect(world.reconciler.status().processes.map((process) => process.application)).toEqual([
      APP,
    ]);
  });

  it("asks the running process to adopt a new deployment rather than restarting it", async () => {
    /* A deploy another node accepted: the process here is still serving what it
       adopted last, and it is told to adopt now instead of waiting out its own
       pointer poll. Nothing is started, stopped or replaced. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;
    await createDeployment(world.daemon.registry, APP, { version: VERSION_TWO });
    await recordRevision(world.daemon.registry, APP, VERSION_TWO);

    expect(await world.reconciler.runOnce()).toEqual([]);
    expect(world.events).toEqual(["ingress:1", `reload:${APP}`]);
    expect(world.driver.reloaded).toEqual([APP]);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.supervisor.stopped).toEqual([]);
  });

  it("asks nothing of a process it has just started, which booted onto the pointer", async () => {
    const world = await seededWorld();

    await world.reconciler.runOnce();

    expect(world.driver.reloaded).toEqual([]);
  });

  it("asks only once per revision, however many passes see it", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    await createDeployment(world.daemon.registry, APP, { version: VERSION_TWO });
    await recordRevision(world.daemon.registry, APP, VERSION_TWO);

    await world.reconciler.runOnce();
    await world.reconciler.runOnce();

    expect(world.driver.reloaded).toEqual([APP]);
  });

  it("carries on when the process will not take the reload", async () => {
    /* The runtime adopts a moved pointer on its own poll, so a listener that is
       busy or gone costs latency and nothing else. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.driver.reloadFails = true;
    await createDeployment(world.daemon.registry, APP, { version: VERSION_TWO });
    await recordRevision(world.daemon.registry, APP, VERSION_TWO);

    expect(await world.reconciler.runOnce()).toEqual([]);
    expect(world.reconciler.status().failures).toEqual([]);
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

    expect(world.supervisor.stopped).toEqual([APP]);
    expect(world.supervisor.list()).toEqual([]);
  });

  it("quarantines a failed stop and retries it before serving again", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    const lease = await acquireLease(world.daemon.registry, "coordinator");
    if (lease === null) throw new Error("lease unavailable");
    await writePlacement(world.daemon.registry, APP, ["node-b"], lease);
    world.supervisor.stopFailures = 1;

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({ teardownPending: true });

    /* Placed here again while the stop is still owed: the teardown is retried
       before anything else, and only then may the application be served. */
    await writePlacement(world.daemon.registry, APP, ["node-a"], lease);
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
    await writePlacement(world.daemon.registry, APP, ["node-b"], lease);

    await world.reconciler.runOnce();
    expect(world.supervisor.stopped).toEqual([APP]);
    expect(world.reconciler.status().processes).toEqual([]);
  });
});

describe("a node that comes back after it died", () => {
  it("never routes an application's host to a port another application now holds", async () => {
    /* Two applications that arrived over time, so the ports they hold are not
       the ports a single pass would hand out in name order. */
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);
    await world.reconciler.runOnce();

    const lease = await acquireLease(world.daemon.registry, "coordinator");
    if (lease === null) throw new Error("lease unavailable");
    await createApplication(world.daemon.registry, { name: "blog" });
    await createDeployment(world.daemon.registry, "blog", { version: VERSION_ONE });
    await recordRevision(world.daemon.registry, "blog", VERSION_ONE);
    await writePlacement(world.daemon.registry, "blog", ["node-a"], lease);
    await world.reconciler.runOnce();
    await heartbeat.beat();

    const before = portsOf(world.reconciler.status().processes);
    expect(Object.keys(before).sort()).toEqual(["blog", APP]);

    /* The machine dies and comes back: the same registry, the same node record
       — still saying what it served before — and no process at all. */
    const events: string[] = [];
    const revived: DaemonContext = { ...world.daemon, supervisor: fakeSupervisor(events) };
    const reconciler = createReconciler(revived, fakeDriver(events, world.book), {
      baseEnv: { PATH: "/bin" },
    });
    revived.reconciler = reconciler;
    await reconciler.runOnce();

    const after = portsOf(reconciler.status().processes);
    const routed = Object.fromEntries(
      (reconciler.fleetRouting()?.routes ?? []).flatMap((route) =>
        route.upstreams
          .filter((upstream) => upstream.node === "node-a")
          .map((upstream) => [route.application, Number(upstream.address.split(":").at(-1))]),
      ),
    );

    /* Whatever this node's routing says about one of its own applications is the
       port that application's process is really on — a host proxied to anything
       else is answered by whichever application holds that port. */
    for (const [application, port] of Object.entries(routed)) {
      expect(port, `${application} is routed to a port it does not hold`).toBe(after[application]);
    }
    /* And an application keeps the port it had: every peer still routes there. */
    expect(after).toEqual(before);
  });
});

describe("an application whose ports something else has taken", () => {
  it("comes back on a new pair, says so once, and the fleet is told where it is", async () => {
    /* A foreign process bound one of the ports while the application was
       stopped. Starting it there for ever is an outage; the node moves it. */
    const world = await seededWorld();
    const heartbeat = await attachHeartbeat(world);
    await world.reconciler.runOnce();
    await heartbeat.beat();
    const before = portsOf(world.reconciler.status().processes);

    world.supervisor.exited(APP);
    world.driver.replaceNext.add(APP);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await world.reconciler.runOnce();
    } finally {
      spy.mockRestore();
    }
    await heartbeat.beat();

    const after = portsOf(world.reconciler.status().processes);
    expect(after[APP]).not.toBe(before[APP]);
    expect(world.reconciler.status().failures).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(APP);
    expect(lines[0]).toContain(String(before[APP]));
    expect(lines[0]).toContain(String(after[APP]));
    /* And the fleet routes to where it is now, not where it was. */
    expect((await getNode(world.daemon.registry, "node-a")).serving).toEqual({
      [APP]: { port: after[APP] as number },
    });
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
      [APP]: { port: 42_000 },
    });

    const lease = await acquireLease(world.daemon.registry, "coordinator");
    if (lease === null) throw new Error("lease unavailable");
    await writePlacement(world.daemon.registry, APP, ["node-b"], lease);
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

  it("mints the change token for what it serves only once the beat has landed", async () => {
    /* A token that beats the record to the bucket sends every node to read the
       record as it WAS, and nothing sends them back: the route then waits for
       the node-refresh timer instead of the next pass. */
    const world = await seededWorld();
    let landed = false;
    let release: () => void = () => {};
    const held = new Promise<void>((settle) => {
      release = settle;
    });
    world.daemon.heartbeat = {
      start() {},
      stop() {},
      beat: async () => {
        await held;
        landed = true;
      },
      status: () => ({ lastBeatAt: null, lastFailure: null }),
    };

    await world.reconciler.runOnce();
    const before = await readChangeHint(world.daemon.registry);

    /* The beat is still in flight: nothing has been said yet. */
    await new Promise((settle) => setTimeout(settle, 20));
    expect(landed).toBe(false);
    expect(await readChangeHint(world.daemon.registry)).toBe(before);

    release();
    await vi.waitFor(async () => {
      expect(landed).toBe(true);
      expect(await readChangeHint(world.daemon.registry)).not.toBe(before);
    });
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

describe("the local state a node holds for an application", () => {
  it("outlives every stop but the one the registry made final", async () => {
    /* A process stops for many reasons — retirement, blocking, reassignment, a
       drain, a restart — and every one of them is a state the application can
       come back from, with a follower disk that may hold writes a peer already
       acknowledged. Only a deletion is not. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    expect(await world.driver.heldLocalState()).toEqual([APP]);

    await retireApplication(world.daemon.registry, APP);
    await world.reconciler.runOnce();

    expect(world.supervisor.stopped).toEqual([APP]);
    expect(await world.driver.heldLocalState()).toEqual([APP]);
    expect(world.driver.removed).toEqual([]);
  });

  it("goes on the pass that reads the deletion, once the process it fed has stopped", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();

    await world.daemon.registry.store.del(applicationKey(APP));
    await world.reconciler.runOnce();

    expect(world.supervisor.stopped).toEqual([APP]);
    expect(world.driver.removed).toEqual([APP]);
    expect(await world.driver.heldLocalState()).toEqual([]);
  });

  it("stays while a process for it is still up, however gone the application is", async () => {
    /* The stop failed, so the process is still there with those files open and
       still answering peers out of them. The pass that gets it stopped is the
       first one that may take the directory. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    await world.daemon.registry.store.del(applicationKey(APP));
    world.supervisor.stopFailures = 1;

    await world.reconciler.runOnce();
    expect(world.reconciler.status().processes[0]).toMatchObject({ teardownPending: true });
    expect(world.driver.removed).toEqual([]);
    expect(await world.driver.heldLocalState()).toEqual([APP]);

    await world.reconciler.runOnce();
    expect(world.driver.removed).toEqual([APP]);
  });

  it("is kept by a pass that could not read the registry", async () => {
    /* A registry that could not be read is never "every application was
       deleted": the pass reports the read and touches nothing local. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    await world.daemon.registry.store.del(applicationKey(APP));
    world.supervisor.stopFailures = 1;
    await world.reconciler.runOnce();

    world.daemon.registry.store.get = (): Promise<never> =>
      Promise.reject(new ScafoError("store-unavailable", "The bucket is not answering"));
    await world.reconciler.runOnce();

    expect(world.driver.removed).toEqual([]);
    expect(await world.driver.heldLocalState()).toEqual([APP]);
    expect(world.reconciler.status().failures).toMatchObject([{ code: "store-unavailable" }]);
  });

  it("is reported as a failure of the pass when it will not go, and tried again", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    await world.daemon.registry.store.del(applicationKey(APP));

    world.driver.removeFails = true;
    await world.reconciler.runOnce();
    expect(world.reconciler.status().failures).toMatchObject([{ action: "discard", subject: APP }]);

    world.driver.removeFails = false;
    await world.reconciler.runOnce();
    expect(world.driver.removed).toEqual([APP]);
    expect(world.reconciler.status().failures).toEqual([]);
  });
});

describe("a process that will not start yet", () => {
  it("is started again on the very next pass, with nothing held against it", async () => {
    /* What a restarted process meets is its predecessor's own lease, which the
       runtime waits out with a retry ladder of its own and may exhaust once.
       The node's answer is the plain one: the exit is read, the id is freed,
       and the next pass starts it again at the interval every pass runs at. */
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.supervisor.exited(APP);

    expect(await world.reconciler.runOnce()).toEqual([{ type: "start", application: APP }]);
    expect(world.supervisor.started).toHaveLength(2);
    expect(world.reconciler.status().failures).toEqual([]);
    expect(world.reconciler.status().processes).toMatchObject([{ application: APP }]);
  });

  it("keeps the directories its predecessor left for it to recover from", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    world.supervisor.exited(APP);

    await world.reconciler.runOnce();

    expect(world.driver.removed).toEqual([]);
    expect(await world.driver.heldLocalState()).toEqual([APP]);
  });

  it("reports a spawn that failed, and clears it on the pass that succeeds", async () => {
    const world = await seededWorld();
    world.supervisor.startFailures = 1;

    await world.reconciler.runOnce();
    expect(world.reconciler.status().failures).toMatchObject([{ action: "start", subject: APP }]);

    await world.reconciler.runOnce();
    expect(world.events.filter((event) => event === "start")).toHaveLength(2);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.reconciler.status().failures).toEqual([]);
  });
});

describe("an application another node serves on a different Celld", () => {
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
      subject: APP,
      code: "version-skew",
    });
    expect(failure?.detail).toContain("node-b");
    expect(failure?.detail).toContain("0.4.1");
  });

  it("leaves nothing behind for the fleet to route to", async () => {
    /* A start that did not happen must not reach the heartbeat: a node that
       announced this application would take traffic it cannot answer. */
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
      expect(lines[0]).toContain(`scafo: reconcile start ${APP} failed [version-skew]`);
      expect(lines[0]).toContain("node-b");

      await world.daemon.registry.store.del(nodeKey("node-b"));
      await world.reconciler.runOnce();
      await world.reconciler.runOnce();
      expect(lines).toHaveLength(2);
      expect(lines[1]).toBe(`scafo: reconcile start ${APP} no longer fails`);
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
      serving: { [APP]: { port: 42_010 } },
    });
    /* Not the empty document: that one says the fleet answers on nothing, which
       is something this node has not read yet and an ingress would act on. */
    expect(world.reconciler.fleetRouting()).toBeUndefined();

    await world.reconciler.runOnce();
    /* This node's own process reaches the routing the way every node's does:
       through its record, so it shows up one pass after it started. */
    expect(world.reconciler.fleetRouting()?.routes.map((route) => route.upstreams)).toEqual([
      [{ node: "node-b", address: "10.0.0.2:42010" }],
    ]);

    await heartbeat.beat();
    await world.reconciler.runOnce();
    expect(world.reconciler.fleetRouting()?.routes[0]).toEqual({
      host: `${APP}.apps.test`,
      application: APP,
      upstreams: [
        { node: "node-a", address: "127.0.0.1:42000" },
        { node: "node-b", address: "10.0.0.2:42010" },
      ],
    });
  });
});

/** Another machine, answering now and telling the fleet it serves this application. */
function otherNode(id: string, celld: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: id },
    addresses: { internal: "10.0.0.2", apiPort: 7400 },
    heartbeatAt: new Date().toISOString(),
    versions: { scafo: "test", celld },
    serving: { [APP]: { port: 42_010 } },
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
  /* Hinting, exactly as `createRegistry` builds one: a pass only re-reads what
     it is told has moved, so a registry a test writes into by hand has to say
     so the same way the real one does. */
  const registry = ctxWith(hintingStore(new MemoryCasStore()));
  await createApplication(registry.ctx, { name: APP });
  await createDeployment(registry.ctx, APP, { version: VERSION_ONE });
  await recordRevision(registry.ctx, APP, VERSION_ONE);
  const lease = await acquireLease(registry.ctx, "coordinator");
  if (lease === null) throw new Error("lease unavailable");
  await writePlacement(registry.ctx, APP, ["node-a"], lease);

  const events: string[] = [];
  const supervisor = fakeSupervisor(events);
  /* The node's disk, kept apart from the driver so a revived node reads it. */
  const book = new Map<string, PortPair>();
  const driver = fakeDriver(events, book);
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
  return { daemon, reconciler, supervisor, driver, events, book };
}

interface FakeSupervisor extends Supervisor {
  started: ProcessSpec[];
  stopped: string[];
  stopFailures: number;
  /** Spawns refused before any run, as a command that cannot be executed is. */
  startFailures: number;
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
    startFailures: 0,
    async start(spec) {
      events.push("start");
      if (supervisor.startFailures > 0) {
        supervisor.startFailures--;
        throw new Error("the process could not be spawned");
      }
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
  /** The ports each application holds here, as a state directory keeps them. */
  book: Map<string, PortPair>;
  /** Applications whose next pair is re-chosen, as an unusable one is. */
  replaceNext: Set<string>;
  /** Applications asked to adopt their new deployment, in the order they were. */
  reloaded: string[];
  /** Made to fail every reload, as a listener that is gone does. */
  reloadFails: boolean;
  /** Applications this node holds a local directory for. */
  held: Set<string>;
  /** Applications whose directory was removed, in the order they were. */
  removed: string[];
  /** Made to fail every removal, as a directory that will not go does. */
  removeFails: boolean;
}

/**
 * `book` stands in for the state directory: it is handed to the driver rather
 * than made by it, so a driver built for a node that came back reads what the
 * node before it wrote, the way a kept volume does.
 */
function fakeDriver(events: string[], book: Map<string, PortPair>): FakeDriver {
  /* Handed out in the order applications first ask, which is what makes the
     ports of two applications that arrived over time not the ports one pass
     would give them in name order. */
  let next = 42_000;
  return {
    stopGraceMs: 30_000,
    book,
    replaceNext: new Set<string>(),
    inputs: [],
    reloaded: [],
    reloadFails: false,
    held: new Set<string>(),
    removed: [],
    removeFails: false,
    processSpec(input) {
      events.push("spec");
      this.inputs.push(input);
      return { id: input.application.name, command: "celld", args: [], env: {} };
    },
    ports(application): Promise<RuntimePorts> {
      const kept = this.book.get(application);
      if (kept !== undefined && !this.replaceNext.has(application)) {
        return Promise.resolve({ ports: kept });
      }
      this.replaceNext.delete(application);
      const ports = { public: next, internal: next + 1 };
      next += 2;
      this.book.set(application, ports);
      return Promise.resolve(kept === undefined ? { ports } : { ports, replaced: kept });
    },
    prepareLocalState(application): Promise<void> {
      events.push(`prepare:${application}`);
      this.held.add(application);
      return Promise.resolve();
    },
    heldLocalState(): Promise<string[]> {
      return Promise.resolve([...this.held]);
    },
    removeLocalState(application): Promise<void> {
      if (this.removeFails) return Promise.reject(new Error("the directory will not go"));
      this.removed.push(application);
      this.held.delete(application);
      this.book.delete(application);
      return Promise.resolve();
    },
    reload(input): Promise<void> {
      this.reloaded.push(input.application);
      events.push(`reload:${input.application}`);
      return this.reloadFails
        ? Promise.reject(new Error("nothing is listening there"))
        : Promise.resolve();
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
      portRangeEnd: 42_998,
      portQuarantineMs: 600_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** The public port each application's process holds. */
function portsOf(processes: RuntimeProcess[]): Record<string, number> {
  return Object.fromEntries(processes.map((process) => [process.application, process.port]));
}
