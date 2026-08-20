/*
 * The reconcile loop of a node agent: reading what the registry wants served,
 * carrying out the plan against a supervisor and a runtime driver, and what it
 * reports about the pass afterwards.
 *
 * The driver and the supervisor are stand-ins that record what they were asked
 * for, so nothing here starts a process or opens a socket, and the registry is a
 * memory store seeded through the registry API itself.
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../src/agent/config.ts";
import type { AgentContext } from "../src/agent/app.ts";
import { createReconciler, type Reconciler } from "../src/agent/reconcile.ts";
import type { CapacityPlan } from "../src/core/capacity/compute.ts";
import { ScafoError } from "../src/core/error.ts";
import { formatProcessId } from "../src/core/placement/ids.ts";
import { deleteKey } from "../src/core/registry/cas.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { createBuild } from "../src/core/registry/builds.ts";
import {
  createEnvironment,
  flipAlias,
  setEnvironmentVarset,
  setSplit,
} from "../src/core/registry/environments.ts";
import { acquireLease } from "../src/core/registry/lease.ts";
import { environmentKey } from "../src/core/registry/paths.ts";
import { writePlacement } from "../src/core/registry/placement.ts";
import { createProject } from "../src/core/registry/projects.ts";
import { importVarsetKey, putVarset, sealVarset } from "../src/core/registry/varsets.ts";
import type { PlainVarset, SplitEntry } from "../src/core/types/registry.ts";
import type { IngressDesired, IngressDriver } from "../src/core/types/ingress.ts";
import type { ProbeOptions, RuntimeDriver, RuntimeProcess } from "../src/core/types/runtime.ts";
import type { RuntimeSpecInput } from "../src/core/types/runtime.ts";
import type { CasStore, StoredObject } from "../src/core/types/store.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const PROJECT = "shop";
const ENVIRONMENT = "prod";
const BUILD_ONE = "1111aaaa";
const BUILD_TWO = "2222bbbb";

/** A second environment, for the cases about what one environment's failure costs the others. */
const OTHER = "staging";

/** First loopback port pair of this node's range. */
const PORT_RANGE_START = 42_000;

/** Environment every runtime process would start from. */
const BASE_ENV = { PATH: "/usr/bin:/bin" };

const STARTED_AT = "2026-01-01T00:00:00.000Z";

/** The node the seeded world is; the other is one it shares an installation with. */
const THIS_NODE = "node-a";
const ANOTHER_NODE = "node-b";

/** Id of the process that serves the seeded environment at a given build. */
function processIdOf(build: string): string {
  return formatProcessId({ project: PROJECT, env: ENVIRONMENT, build });
}

/** Records a coordinator's decision about who serves the seeded environment. */
async function placeOn(registry: RegistryContext, nodes: string[]): Promise<void> {
  const lease = await acquireLease(registry, "coordinator");
  if (lease === null) throw new Error("the fixture could not take the coordinator lease");
  await writePlacement(registry, PROJECT, ENVIRONMENT, nodes, lease);
}

describe("one pass over a node that runs nothing yet", () => {
  it("points the fleet at the aliased build, starts a process for it and gates it", async () => {
    const world = await seededWorld();

    const plan = await world.reconciler.runOnce();

    expect(world.driver.activations).toEqual([
      { prefix: `fleets/${PROJECT}/${ENVIRONMENT}`, version: `version-${BUILD_ONE}` },
    ]);
    expect(world.supervisor.started).toEqual([world.driver.built[0]]);
    expect(world.supervisor.started[0].id).toBe(processIdOf(BUILD_ONE));
    expect(world.driver.probed.map((process) => process.processId)).toEqual([
      processIdOf(BUILD_ONE),
    ]);
    expect(plan.map((action) => action.type)).toEqual(["rollout"]);
  });

  it("reports the process it started as ready, on the pair it allocated for it", async () => {
    const world = await seededWorld();

    const plan = await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(status.processes).toEqual([
      {
        processId: processIdOf(BUILD_ONE),
        project: PROJECT,
        env: ENVIRONMENT,
        build: BUILD_ONE,
        port: PORT_RANGE_START,
        internalPort: PORT_RANGE_START + 1,
        ready: true,
      },
    ]);
    expect(status.failures).toEqual([]);
    expect(status.lastActions).toEqual(plan);
    expect(status.running).toBe(false);
    expect(Date.parse(status.lastRunAt ?? "")).not.toBeNaN();
  });

  it("materializes the process from this node's own bucket, address and capacity", async () => {
    const capacity = capacityPlan();
    const world = await seededWorld({ capacity });

    await world.reconciler.runOnce();
    const input = world.driver.specs[0];

    expect(input.project).toBe(PROJECT);
    expect(input.env.name).toBe(ENVIRONMENT);
    expect(input.build.id).toBe(BUILD_ONE);
    expect(input.ports).toEqual({
      public: PORT_RANGE_START,
      internal: PORT_RANGE_START + 1,
    });
    expect(input.node).toEqual({
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      keyPrefix: "tenant-a",
      accessKey: "key-id",
      secretKey: "key-secret",
      /* Peers reach this node at the address it advertises, not at its listener. */
      advertiseHost: "10.0.0.4",
      /* And what the process binds is the node's own setting, so the address it
         advertises is one something is actually listening on. */
      bindHost: "127.0.0.1",
    });
    expect(input.capacity).toEqual(capacity);
    expect(input.baseEnv).toEqual(BASE_ENV);
  });

  it("gates the process at the path this node is configured to probe", async () => {
    const world = await seededWorld();

    await world.reconciler.runOnce();

    expect(world.driver.probeOptions[0]).toMatchObject({ path: "/" });
  });

  it("plans nothing more once the environment is served by the build it should be", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();

    const second = await world.reconciler.runOnce();

    expect(second).toEqual([]);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.driver.activations).toHaveLength(1);
  });

  it("reports nothing at all before its first pass", async () => {
    const world = await seededWorld();

    expect(world.reconciler.status()).toEqual({
      lastRunAt: null,
      running: false,
      lastActions: [],
      failures: [],
      processes: [],
      placements: [],
    });
  });
});

describe("publishing what the node serves", () => {
  it("hands the ingress the routing of what the pass left ready", async () => {
    const applied: IngressDesired[] = [];
    const world = await seededWorld({
      ingress: { apply: (d) => (applied.push(d), Promise.resolve()) },
    });

    await world.reconciler.runOnce();

    /* One pass: the process was started and passed its gate, so it is routable
       under the environment's label and under its build's own hash. */
    expect(applied).toHaveLength(1);
    expect(applied[0]?.routes.map((route) => route.host)).toEqual([
      `${PROJECT}--${BUILD_ONE}.apps.test`,
      `${PROJECT}--${ENVIRONMENT}.apps.test`,
    ]);
    expect(applied[0]?.routes[0]?.backends).toEqual([
      {
        backend: {
          project: PROJECT,
          env: ENVIRONMENT,
          build: BUILD_ONE,
          port: PORT_RANGE_START,
        },
        weight: 100,
      },
    ]);
  });

  it("routes nothing to a process that never passed its gate", async () => {
    const applied: IngressDesired[] = [];
    const world = await seededWorld({
      ingress: { apply: (d) => (applied.push(d), Promise.resolve()) },
    });
    world.driver.gate = (): Promise<boolean> => Promise.resolve(false);

    await world.reconciler.runOnce();

    expect(applied[0]?.routes).toEqual([]);
  });

  it("records an ingress it could not reach, and finishes the pass anyway", async () => {
    const world = await seededWorld({
      ingress: {
        apply: () =>
          Promise.reject(new ScafoError("capability-missing", "Ingress could not be configured")),
      },
    });

    const plan = await world.reconciler.runOnce();
    const status = world.reconciler.status();

    /* The pass did its whole job: an ingress outside the node must never be
       able to stop the node reconciling itself. */
    expect(plan.map((action) => action.type)).toEqual(["rollout"]);
    expect(world.supervisor.started).toHaveLength(1);
    expect(status.processes[0]?.ready).toBe(true);
    expect(status.failures).toEqual([
      {
        at: expect.any(String),
        subject: "ingress",
        detail: expect.stringContaining("Ingress could not be configured"),
      },
    ]);
  });

  it("asks nothing of an ingress the node does not have", async () => {
    const world = await seededWorld();

    await world.reconciler.runOnce();

    expect(world.reconciler.status().failures).toEqual([]);
  });
});

describe("what the registry says is wanted", () => {
  it("leaves an environment alone until its alias has been flipped at least once", async () => {
    const world = await seededWorld({ flip: false });

    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([]);
    expect(world.driver.activations).toEqual([]);
    expect(world.supervisor.started).toEqual([]);
  });

  it("refuses to start an environment whose varset this node holds no key for", async () => {
    /* A process started without the variables its environment is configured with
       would come up, pass its gate and serve requests against whatever its code
       falls back to — a misconfiguration nothing reports. */
    const world = await seededWorld({ varset: true });

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(world.supervisor.started).toEqual([]);
    expect(status.failures).toHaveLength(1);
    /* Subjected on the process id the rollout would have produced, so a failure
       names the build as well as the environment — which is what tells two legs
       of one environment apart. */
    expect(status.failures[0]).toMatchObject({
      action: "rollout",
      subject: processIdOf(BUILD_ONE),
    });
    /* Actionable: an operator reading the node's status learns what to hand it. */
    expect(status.failures[0].detail).toContain("varset-key-file");
  });

  it("opens the varset when this node holds its key", async () => {
    const world = await seededWorld({ varset: true, holdVarsetKey: true });

    await world.reconciler.runOnce();

    expect(world.driver.specs[0].vars).toEqual(VARSET);
  });

  it("records the environment it cannot decrypt and serves every other one", async () => {
    const world = await seededWorld({
      varset: true,
      wrongVarsetKey: true,
      otherEnvironment: OTHER,
    });

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    /* One environment's key problem is that environment's alone: the pass runs
       to the end and the rest of the node is served. */
    expect(world.supervisor.started.map((spec) => spec.id)).toEqual([
      formatProcessId({ project: PROJECT, env: OTHER, build: BUILD_ONE }),
    ]);
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      action: "rollout",
      subject: processIdOf(BUILD_ONE),
    });
    expect(status.failures[0].detail).toContain("decrypted");
  });

  it("leaves the process an environment already has running when its key stops working", async () => {
    const world = await seededWorld({ varset: true, holdVarsetKey: true, otherBuild: BUILD_TWO });
    await world.reconciler.runOnce();
    /* The key is rotated out from under the node, and a new build is flipped to. */
    world.agent.varsetKey = await randomVarsetKey();
    await flipAlias(world.registry, PROJECT, ENVIRONMENT, BUILD_TWO);

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(world.supervisor.started.map((spec) => spec.id)).toEqual([processIdOf(BUILD_ONE)]);
    expect(world.supervisor.stopped).toEqual([]);
    expect(status.processes.map((process) => process.processId)).toEqual([processIdOf(BUILD_ONE)]);
    expect(status.failures[0]?.detail).toContain("decrypted");
  });
});

describe("an environment split between two builds", () => {
  /** 90 to the alias, 10 to the other build; the order the registry states them in. */
  const NINETY_TEN: SplitEntry[] = [
    { build: BUILD_ONE, weight: 90 },
    { build: BUILD_TWO, weight: 10 },
  ];

  function splitWorld(): Promise<World> {
    return seededWorld({ build: BUILD_ONE, otherBuild: BUILD_TWO, split: NINETY_TEN });
  }

  it("pairs each activation with its own start, rather than batching them", async () => {
    const world = await splitWorld();

    await world.reconciler.runOnce();

    /*
     * THE WHOLE HAZARD, in one assertion. celld has ONE deployment pointer per
     * fleet and a process reads it once, while it starts. Batched as "activate
     * one, activate two, start, start" — which is what a phased plan produces —
     * BOTH processes would come up on version-2222bbbb, the registry and the
     * routing would still say there are two legs, and the split would serve one
     * build twice with nothing anywhere reporting it.
     */
    expect(world.events).toEqual([
      `activate version-${BUILD_ONE}`,
      `start ${processIdOf(BUILD_ONE)}`,
      `gate ${processIdOf(BUILD_ONE)}`,
      `activate version-${BUILD_TWO}`,
      `start ${processIdOf(BUILD_TWO)}`,
      `gate ${processIdOf(BUILD_TWO)}`,
    ]);
  });

  it("starts one process per leg, each on its own port pair", async () => {
    const world = await splitWorld();

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(status.processes.map((process) => process.processId)).toEqual([
      processIdOf(BUILD_ONE),
      processIdOf(BUILD_TWO),
    ]);
    expect(status.processes.map((process) => process.port)).toEqual([
      PORT_RANGE_START,
      PORT_RANGE_START + 2,
    ]);
    expect(status.processes.every((process) => process.ready)).toBe(true);
    expect(status.failures).toEqual([]);
  });

  it("hands each leg the build it is a leg of", async () => {
    const world = await splitWorld();

    await world.reconciler.runOnce();

    /* Every process is materialized from ITS OWN build record, not from the
       environment's alias: the alias is one leg of two here. */
    expect(world.driver.specs.map((input) => input.build.id)).toEqual([BUILD_ONE, BUILD_TWO]);
  });

  it("publishes the routing weighted as the registry states it", async () => {
    const applied: IngressDesired[] = [];
    const world = await seededWorld({
      build: BUILD_ONE,
      otherBuild: BUILD_TWO,
      split: NINETY_TEN,
      ingress: { apply: (d) => (applied.push(d), Promise.resolve()) },
    });

    await world.reconciler.runOnce();

    const envHost = `${PROJECT}--${ENVIRONMENT}.apps.test`;
    const route = applied.at(-1)?.routes.find((entry) => entry.host === envHost);
    expect(route?.backends.map((leg) => `${leg.backend.build}:${String(leg.weight)}`)).toEqual([
      `${BUILD_ONE}:90`,
      `${BUILD_TWO}:10`,
    ]);
    /* And each leg keeps a host of its own, single-backend, so it can be checked
       on without going through the split. */
    for (const build of [BUILD_ONE, BUILD_TWO]) {
      const hashed = applied
        .at(-1)
        ?.routes.find((entry) => entry.host === `${PROJECT}--${build}.apps.test`);
      expect(hashed?.backends, build).toHaveLength(1);
    }
  });

  it("restarts a crashed leg through the same paired path", async () => {
    const world = await splitWorld();
    await world.reconciler.runOnce();
    world.events.length = 0;

    /* The 10% leg dies. The fleet pointer names whichever build was rolled out
       last, so restarting it must move the pointer again before it starts — the
       same action a first start goes through. */
    world.supervisor.crash(processIdOf(BUILD_TWO));
    await world.reconciler.runOnce();

    expect(world.events).toEqual([
      `activate version-${BUILD_TWO}`,
      `start ${processIdOf(BUILD_TWO)}`,
      `gate ${processIdOf(BUILD_TWO)}`,
    ]);
    /* And the leg that is still up was neither restarted nor stopped. */
    expect(world.supervisor.stopped).toEqual([]);
    expect(world.reconciler.status().processes.map((process) => process.processId)).toEqual([
      processIdOf(BUILD_ONE),
      processIdOf(BUILD_TWO),
    ]);
  });

  it("keeps serving both legs pass after pass, without restarting anything", async () => {
    const world = await splitWorld();
    await world.reconciler.runOnce();

    const second = await world.reconciler.runOnce();

    expect(second).toEqual([]);
    expect(world.supervisor.started).toHaveLength(2);
    expect(world.driver.activations).toHaveLength(2);
  });

  it("retires the leg a cleared split dropped, and only once the alias is ready", async () => {
    const world = await splitWorld();
    await world.reconciler.runOnce();

    /* `scafo env split --clear`: the environment is wanted at its alias alone. */
    await setSplit(world.registry, PROJECT, ENVIRONMENT, null);
    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([
      {
        type: "stop",
        processId: processIdOf(BUILD_TWO),
        reason: `superseded by build "${BUILD_ONE}"`,
      },
    ]);
    expect(world.supervisor.stopped).toEqual([
      { id: processIdOf(BUILD_TWO), graceMs: world.driver.stopGraceMs },
    ]);
    expect(world.reconciler.status().processes.map((process) => process.processId)).toEqual([
      processIdOf(BUILD_ONE),
    ]);
  });

  it("stops the other leg when a flip cuts over to one build", async () => {
    const world = await splitWorld();
    await world.reconciler.runOnce();

    /* A flip is a full cutover and clears the split with it. */
    await flipAlias(world.registry, PROJECT, ENVIRONMENT, BUILD_TWO);
    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([
      {
        type: "stop",
        processId: processIdOf(BUILD_ONE),
        reason: `superseded by build "${BUILD_TWO}"`,
      },
    ]);
  });

  it("leaves the ready leg serving when the other one cannot come up", async () => {
    const world = await splitWorld();
    world.driver.gate = (process): Promise<boolean> => Promise.resolve(process.build !== BUILD_TWO);

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    /* The failing leg is stopped — this pass started it, so it has never served
       a request — and the environment carries on with the leg that works, which
       takes the whole of the traffic until the other one comes up. */
    expect(world.supervisor.stopped).toEqual([
      { id: processIdOf(BUILD_TWO), graceMs: world.driver.stopGraceMs },
    ]);
    expect(status.processes.map((process) => process.processId)).toEqual([processIdOf(BUILD_ONE)]);
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      action: "await-ready",
      subject: processIdOf(BUILD_TWO),
    });
  });
});

describe("a process that does not pass its gate", () => {
  it("stops the one this pass started and leaves the environment's other process running", async () => {
    const world = await seededWorld({ build: BUILD_TWO, otherBuild: BUILD_ONE });
    /* Serving the environment since before this agent came up. */
    world.supervisor.adopt(processIdOf(BUILD_ONE));
    world.driver.gate = (): Promise<boolean> => Promise.resolve(false);

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(world.supervisor.stopped).toEqual([
      { id: processIdOf(BUILD_TWO), graceMs: world.driver.stopGraceMs },
    ]);
    /* The process that has been answering requests all along is untouched: it is
       the only thing its environment has. */
    expect(world.supervisor.stopped.map((call) => call.id)).not.toContain(processIdOf(BUILD_ONE));
    expect(status.processes.map((process) => process.processId)).toEqual([processIdOf(BUILD_ONE)]);
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      action: "await-ready",
      subject: processIdOf(BUILD_TWO),
    });
    expect(status.failures[0].detail).toContain("readiness gate");
  });

  it("reports a process it did not start rather than probing or stopping it", async () => {
    /* A running process this agent has no bookkeeping for: its id says what it
       serves, but not which ports it listens on, so its readiness cannot be
       established — and it may be the only thing serving its environment. */
    const world = await seededWorld();
    world.supervisor.adopt(processIdOf(BUILD_ONE));

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(world.driver.probed).toEqual([]);
    expect(world.supervisor.stopped).toEqual([]);
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0].detail).toContain("listeners are unknown");
    expect(status.processes[0]).toMatchObject({ processId: processIdOf(BUILD_ONE), port: 0 });
  });
});

describe("a pass that cannot do everything it planned", () => {
  it("records a fleet it could not point at a build, and starts nothing for it", async () => {
    const world = await seededWorld();
    world.driver.activationError = new ScafoError("cas-conflict", "Conditional write failed");

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(world.supervisor.started).toEqual([]);
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0]).toMatchObject({
      action: "rollout",
      subject: processIdOf(BUILD_ONE),
    });
  });

  it("refuses to start a build that carries no runtime version id", async () => {
    const world = await seededWorld({ celldVersionId: false });

    await world.reconciler.runOnce();
    const status = world.reconciler.status();

    expect(world.driver.activations).toEqual([]);
    expect(world.supervisor.started).toEqual([]);
    expect(status.failures[0]?.detail).toContain("runtime version");
  });

  it("stops nothing when the registry itself cannot be read", async () => {
    /* An unreadable registry looks exactly like "every environment was
       undeployed", so a pass that fails here must plan nothing rather than stop
       the processes that are still serving traffic. */
    const supervisor = fakeSupervisor();
    supervisor.adopt(processIdOf(BUILD_ONE));
    const driver = fakeDriver();
    const reconciler = createReconciler(
      agentContext({ store: new UnreadableStore() }, supervisor),
      driver,
      { baseEnv: BASE_ENV },
    );

    const plan = await reconciler.runOnce();

    expect(plan).toEqual([]);
    expect(supervisor.stopped).toEqual([]);
    expect(reconciler.status().failures).toHaveLength(1);
  });
});

describe("an environment that is taken out of the registry", () => {
  it("stops what still runs for it, giving the driver's own grace", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();

    await deleteKey(world.registry, environmentKey(PROJECT, ENVIRONMENT));
    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([
      {
        type: "stop",
        processId: processIdOf(BUILD_ONE),
        reason: "environment is no longer served by this node",
      },
    ]);
    expect(world.supervisor.stopped).toEqual([
      { id: processIdOf(BUILD_ONE), graceMs: world.driver.stopGraceMs },
    ]);
    expect(world.reconciler.status().processes).toEqual([]);
  });
});

describe("an environment placed on particular nodes", () => {
  it("starts the one this node was assigned", async () => {
    const world = await seededWorld();
    await placeOn(world.registry, [THIS_NODE, ANOTHER_NODE]);

    const plan = await world.reconciler.runOnce();

    expect(plan.map((action) => action.type)).toEqual(["rollout"]);
    expect(world.supervisor.started[0].id).toBe(processIdOf(BUILD_ONE));
    expect(world.reconciler.status().placements).toEqual([
      { project: PROJECT, env: ENVIRONMENT, nodes: [THIS_NODE, ANOTHER_NODE], self: true },
    ]);
  });

  it("starts nothing for one placed entirely on other nodes", async () => {
    const world = await seededWorld();
    await placeOn(world.registry, [ANOTHER_NODE]);

    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([]);
    expect(world.supervisor.started).toEqual([]);
    expect(world.driver.activations).toEqual([]);
    expect(world.reconciler.status().placements[0]).toMatchObject({ self: false });
  });

  it("stops what it already runs once the environment is placed elsewhere", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();
    expect(world.supervisor.started).toHaveLength(1);

    /* The reassignment: the coordinator gave this environment to another node,
       and the node that had it stops its process. The receiving node starts its
       own on its own pass — neither node waits for the other. */
    await placeOn(world.registry, [ANOTHER_NODE]);
    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([
      {
        type: "stop",
        processId: processIdOf(BUILD_ONE),
        reason: "environment is no longer served by this node",
      },
    ]);
    expect(world.supervisor.stopped).toEqual([
      { id: processIdOf(BUILD_ONE), graceMs: world.driver.stopGraceMs },
    ]);
    expect(world.reconciler.status().processes).toEqual([]);
  });

  it("keeps serving one it is still named in", async () => {
    const world = await seededWorld();
    await world.reconciler.runOnce();

    await placeOn(world.registry, [THIS_NODE]);
    const plan = await world.reconciler.runOnce();

    expect(plan).toEqual([]);
    expect(world.supervisor.stopped).toEqual([]);
    expect(world.reconciler.status().processes).toHaveLength(1);
  });

  it("stops routing to an environment it no longer serves", async () => {
    const applied: IngressDesired[] = [];
    const world = await seededWorld({
      ingress: { apply: (d) => (applied.push(d), Promise.resolve()) },
    });
    await world.reconciler.runOnce();
    expect(applied[0]?.routes).not.toEqual([]);

    await placeOn(world.registry, [ANOTHER_NODE]);
    await world.reconciler.runOnce();

    /* Traffic must stop arriving here before this node stops answering it: an
       ingress still pointing at a stopped process is a 502 per request. */
    expect(applied.at(-1)?.routes).toEqual([]);
  });
});

describe("passes that would overlap", () => {
  it("skips a pass asked for while another one is still in flight", async () => {
    const world = await seededWorld();
    const gate = deferred<boolean>();
    world.driver.gate = (): Promise<boolean> => gate.promise;

    const inFlight = world.reconciler.runOnce();
    const skipped = await world.reconciler.runOnce();

    /* Two passes would plan against the same gap and start the environment
       twice; the second one is answered with an empty plan instead. */
    expect(skipped).toEqual([]);
    expect(world.reconciler.status().running).toBe(true);

    gate.resolve(true);
    const planned = await inFlight;

    expect(planned.map((action) => action.type)).toEqual(["rollout"]);
    expect(world.driver.activations).toHaveLength(1);
    expect(world.supervisor.started).toHaveLength(1);
    expect(world.reconciler.status().running).toBe(false);
  });
});

describe("the loop on a timer", () => {
  it("keeps running passes until it is stopped", async () => {
    const world = await seededWorld({ intervalMs: 5 });

    world.reconciler.start();
    await vi.waitFor(
      () => {
        expect(world.supervisor.listCalls).toBeGreaterThanOrEqual(3);
      },
      { timeout: 2000, interval: 5 },
    );
    world.reconciler.stop();
    const afterStop = world.supervisor.listCalls;
    await sleep(50);

    expect(world.driver.activations).toHaveLength(1);
    expect(world.supervisor.listCalls).toBe(afterStop);
  });

  it("runs one loop however often it is started, and stays stopped once stopped", async () => {
    const world = await seededWorld({ intervalMs: 5 });

    world.reconciler.start();
    world.reconciler.start();
    await vi.waitFor(
      () => {
        expect(world.supervisor.listCalls).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2000, interval: 5 },
    );
    world.reconciler.stop();
    world.reconciler.stop();
    const afterStop = world.supervisor.listCalls;
    await sleep(50);

    expect(world.supervisor.listCalls).toBe(afterStop);
  });
});

/** The variables the seeded varset holds, when a case asks for one. */
const VARSET: PlainVarset = {
  DATABASE_URL: { value: "postgres://db.test/app", secret: true },
  FEATURE_FLAGS: { value: "beta", secret: false },
};

interface WorldOptions {
  /** Build the environment's alias is flipped to. Defaults to the first one. */
  build?: string;
  /** A second build recorded alongside it, for cases that need an older one. */
  otherBuild?: string;
  /** Whether the alias is flipped at all. Defaults to true. */
  flip?: boolean;
  /** Whether the build carries the runtime version id an activation needs. */
  celldVersionId?: boolean;
  /** Whether the environment points at a sealed varset. */
  varset?: boolean;
  /** Whether this node holds the key that opens it. */
  holdVarsetKey?: boolean;
  /** Whether this node holds a key, but not the one the varset was sealed with. */
  wrongVarsetKey?: boolean;
  /** A second environment of the same project, serving the same build with no varset. */
  otherEnvironment?: string;
  /** A traffic split written onto the environment, after the alias is flipped. */
  split?: SplitEntry[];
  capacity?: CapacityPlan;
  intervalMs?: number;
  /** Where the node publishes what it serves; absent leaves it publishing nowhere. */
  ingress?: IngressDriver;
}

interface World {
  registry: RegistryContext;
  /** What the loop acts through; a case may take this node's key away mid-run. */
  agent: AgentContext;
  supervisor: FakeSupervisor;
  driver: FakeDriver;
  reconciler: Reconciler;
  /**
   * Every activation, start and gate this node made, in ONE list and in the
   * order they happened.
   *
   * Kept across the driver and the supervisor rather than in either of them,
   * because the property worth asserting is exactly the interleaving: an
   * activation and the start that loads it must be adjacent, per build.
   */
  events: string[];
}

/** A node whose registry holds one project, one environment and its builds. */
async function seededWorld(opts?: WorldOptions): Promise<World> {
  const { ctx } = ctxWith(new MemoryCasStore());
  const build = opts?.build ?? BUILD_ONE;

  await createProject(ctx, { slug: PROJECT });
  await createEnvironment(ctx, PROJECT, { name: ENVIRONMENT });
  for (const id of opts?.otherBuild === undefined ? [build] : [build, opts.otherBuild]) {
    await createBuild(ctx, PROJECT, {
      id,
      runtimeConfigurable: true,
      ...(opts?.celldVersionId === false ? {} : { celldVersionId: `version-${id}` }),
    });
  }
  if (opts?.flip !== false) await flipAlias(ctx, PROJECT, ENVIRONMENT, build);
  if (opts?.split !== undefined) await setSplit(ctx, PROJECT, ENVIRONMENT, opts.split);

  let varsetKey: CryptoKey | undefined;
  if (opts?.varset === true) {
    const key = await importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await sealVarset(VARSET, key);
    await putVarset(ctx, PROJECT, sealed);
    await setEnvironmentVarset(ctx, PROJECT, ENVIRONMENT, sealed.id);
    if (opts.holdVarsetKey === true) varsetKey = key;
  }
  /* A key of this node's own, which opens nothing that was sealed above. */
  if (opts?.wrongVarsetKey === true) varsetKey = await randomVarsetKey();

  if (opts?.otherEnvironment !== undefined) {
    await createEnvironment(ctx, PROJECT, { name: opts.otherEnvironment });
    await flipAlias(ctx, PROJECT, opts.otherEnvironment, build);
  }

  const events: string[] = [];
  const supervisor = fakeSupervisor(events);
  const driver = fakeDriver(events);
  const agent = agentContext(ctx, supervisor, {
    ...(varsetKey === undefined ? {} : { varsetKey }),
    ...(opts?.capacity === undefined ? {} : { capacity: opts.capacity }),
    ...(opts?.ingress === undefined ? {} : { ingress: opts.ingress }),
  });

  return {
    registry: ctx,
    agent,
    supervisor,
    driver,
    events,
    reconciler: createReconciler(agent, driver, {
      baseEnv: BASE_ENV,
      ...(opts?.intervalMs === undefined ? {} : { intervalMs: opts.intervalMs }),
    }),
  };
}

interface AgentOptions {
  varsetKey?: CryptoKey;
  capacity?: CapacityPlan;
  ingress?: IngressDriver;
}

/** Everything the loop acts through, with this node's configuration. */
function agentContext(
  registry: RegistryContext,
  supervisor: Supervisor,
  opts?: AgentOptions,
): AgentContext {
  const config: AgentConfig = {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      prefix: "tenant-a",
      accessKey: "key-id",
      secretKey: "key-secret",
    },
    node: { id: "node-a", listen: "127.0.0.1:7400", advertise: "10.0.0.4:7401" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: PORT_RANGE_START,
      probePath: "/",
      bindHost: "127.0.0.1",
    },
  };

  const agent: AgentContext = {
    config,
    nodeId: "node-a",
    registry,
    supervisor,
    version: "0.0.0-test",
  };
  if (opts?.varsetKey !== undefined) agent.varsetKey = opts.varsetKey;
  if (opts?.capacity !== undefined) agent.capacity = opts.capacity;
  if (opts?.ingress !== undefined) agent.ingress = opts.ingress;
  return agent;
}

interface FakeSupervisor extends Supervisor {
  /** Specs it was asked to run, in order. */
  readonly started: ProcessSpec[];
  /** Stops it was asked for, with the grace each was given. */
  readonly stopped: { id: string; graceMs?: number }[];
  /** Times the loop asked what this node is running; one per pass. */
  listCalls: number;
  /** Records a running process this agent never started itself. */
  adopt(id: string): void;
  /** Makes a running process stop being one, without anybody having asked. */
  crash(id: string): void;
}

function fakeSupervisor(events: string[] = []): FakeSupervisor {
  const statuses = new Map<string, ProcessStatus>();

  const supervisor: FakeSupervisor = {
    started: [],
    stopped: [],
    listCalls: 0,

    adopt(id: string): void {
      statuses.set(id, { id, state: "running", pid: 1000 + statuses.size, startedAt: STARTED_AT });
    },

    crash(id: string): void {
      const status = statuses.get(id);
      if (status !== undefined) statuses.set(id, { ...status, state: "exited", exitCode: 1 });
    },

    start(spec: ProcessSpec): Promise<ProcessStatus> {
      events.push(`start ${spec.id}`);
      supervisor.started.push(spec);
      const status: ProcessStatus = {
        id: spec.id,
        state: "running",
        pid: 2000 + supervisor.started.length,
        startedAt: STARTED_AT,
      };
      statuses.set(spec.id, status);
      return Promise.resolve(status);
    },

    stop(id: string, stopOpts?: { graceMs?: number }): Promise<void> {
      supervisor.stopped.push({ id, graceMs: stopOpts?.graceMs });
      const status = statuses.get(id);
      if (status !== undefined) statuses.set(id, { ...status, state: "exited", exitCode: null });
      return Promise.resolve();
    },

    status: (id: string): ProcessStatus | null => statuses.get(id) ?? null,

    list(): ProcessStatus[] {
      supervisor.listCalls++;
      return [...statuses.values()].map((status) => ({ ...status }));
    },

    onExit: (): void => {},
  };
  return supervisor;
}

interface FakeDriver extends RuntimeDriver {
  /** Fleets it was asked to point at a version, in order. */
  readonly activations: { prefix: string; version: string }[];
  /** Inputs it was asked to materialize a process from. */
  readonly specs: RuntimeSpecInput[];
  /** The specs it produced for them. */
  readonly built: ProcessSpec[];
  /** Processes whose readiness it was asked about, and how it was asked. */
  readonly probed: RuntimeProcess[];
  readonly probeOptions: (ProbeOptions | undefined)[];
  /** Answer the readiness gate gives; replaced by a case that needs another. */
  gate: (process: RuntimeProcess) => Promise<boolean>;
  /** Failure every activation raises, when a case asks for one. */
  activationError: Error | null;
}

function fakeDriver(events: string[] = []): FakeDriver {
  const driver: FakeDriver = {
    stopGraceMs: 30_000,
    activations: [],
    specs: [],
    built: [],
    probed: [],
    probeOptions: [],
    gate: (): Promise<boolean> => Promise.resolve(true),
    activationError: null,

    processSpec(input: RuntimeSpecInput): ProcessSpec {
      driver.specs.push(input);
      const spec: ProcessSpec = {
        id: formatProcessId({
          project: input.project,
          env: input.env.name,
          build: input.build.id,
        }),
        command: "runtime-stand-in",
        args: ["--listen", `127.0.0.1:${String(input.ports.public)}`],
        env: { ...input.baseEnv },
      };
      driver.built.push(spec);
      return spec;
    },

    activateVersion(prefix: string, celldVersionId: string): Promise<void> {
      if (driver.activationError !== null) return Promise.reject(driver.activationError);

      events.push(`activate ${celldVersionId}`);
      driver.activations.push({ prefix, version: celldVersionId });
      return Promise.resolve();
    },

    probeReady(process: RuntimeProcess, probe?: ProbeOptions): Promise<boolean> {
      events.push(`gate ${process.processId}`);
      driver.probed.push(process);
      driver.probeOptions.push(probe);
      return driver.gate(process);
    },
  };
  return driver;
}

/** A registry this node cannot read at all. */
class UnreadableStore implements CasStore {
  get(): Promise<StoredObject | null> {
    return Promise.reject(this.#down());
  }

  put(): Promise<{ etag: string }> {
    return Promise.reject(this.#down());
  }

  del(): Promise<void> {
    return Promise.reject(this.#down());
  }

  list(): Promise<string[]> {
    return Promise.reject(this.#down());
  }

  #down(): ScafoError {
    return new ScafoError("draining", "Store is unreachable", {
      detail: "the bucket refused the request",
    });
  }
}

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
    probedAt: STARTED_AT,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise a case settles by hand, to hold a pass open while it checks on it. */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function randomVarsetKey(): Promise<CryptoKey> {
  return importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
