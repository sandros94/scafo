/*
 * The fleet deployment pointer, and the two writers that move it.
 *
 * There is ONE pointer per environment and a runtime process reads it ONCE,
 * while it starts. Two writers move it — the reconciler's rollout (activate,
 * then spawn) and the deploy service (`celld deploy` bundles, uploads and moves
 * the same pointer, from whichever node accepted the upload) — so unserialized,
 * a deploy landing between an activation and the spawned process's read hands
 * that process the WRONG version under the RIGHT process id.
 *
 * Nothing here starts a process or shells out: the bucket is a memory store, the
 * runtime driver is the real celld one over it, the supervisor is a stand-in
 * that reads the pointer where a starting process would, and the deploy runner
 * is a stand-in that writes the pointer where `celld deploy` would.
 */

import { describe, expect, it } from "vitest";
import { setCurrentBuild } from "../src/core/registry/_current.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import {
  createDeployService,
  type DeployMeta,
  type DeployService,
  type DeployStatus,
} from "../src/daemon/deploys.ts";
import { createCreditController } from "../src/daemon/_credit-controller.ts";
import {
  createReconciler,
  type PointerLockOptions,
  type Reconciler,
} from "../src/daemon/reconcile.ts";
import { createBuild } from "../src/core/registry/builds.ts";
import { putJson, readJson } from "../src/core/registry/cas.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { createEnvironment } from "../src/core/registry/environments.ts";
import { LOCK_POLL_MS } from "../src/core/registry/locks.ts";
import { fleetPrefix, pointerLockKey } from "../src/core/registry/paths.ts";
import { POINTER_READ_HOLD_MS } from "../src/core/registry/pointer-lock.ts";
import { createProject } from "../src/core/registry/projects.ts";
import { acquireLease } from "../src/core/registry/lease.ts";
import { writePlacement } from "../src/core/registry/placement.ts";
import type { DeployRunInput, DeployRunner } from "../src/core/types/deploy.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { createCelldDriver } from "../src/drivers/runtime/celld.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const NODE = "node-a";
const PROJECT = "shop";
const ENVIRONMENT = "prod";
const OTHER = "staging";
const SCRIPT = "shop";

/** The build the node is rolling out, and the one a deploy publishes underneath it. */
const BUILD_X = "1111aaaa";
const BUILD_Y = "2222bbbb";

/** Version the fleet was left pointing at before any of this. */
const BASE_VERSION = "version-0000";

/** How long a spawning process is given to make its one read of the pointer. */
const READ_WINDOW_MS = 50;

/**
 * Longest the deploy can be kept from the pointer, in the mechanism's own terms.
 *
 * A rollout holds it for {@link POINTER_READ_HOLD_MS} past the spawn and a
 * waiter asks again every {@link LOCK_POLL_MS}, so the publish lands up to one
 * whole poll interval after the hold ends — on a grid nothing here controls.
 * Every budget below is sized off that rather than off vitest's implicit second,
 * which this race finished inside of only when the two one-second grids happened
 * to line up.
 */
const PUBLISH_WAIT_MS = POINTER_READ_HOLD_MS + LOCK_POLL_MS * 2;

function versionOf(build: string): string {
  return `version-${build}`;
}

function processIdOf(environment: string, build: string): string {
  return `${PROJECT}--${environment}--${build}`;
}

describe("a deploy landing while a rollout is spawning", () => {
  it("must not change the version the starting process loads", async () => {
    const world = await seededWorld();

    /* The race: the deploy's pointer write is started the moment the rollout
       spawns its process, and is given a window to land before that process
       makes its one read. */
    world.supervisor.onSpawn = async (): Promise<void> => {
      world.deploying = startDeploy(world.deploys);
      await sleep(READ_WINDOW_MS);
    };

    await world.reconciler.runOnce();

    /*
     * THE CONTRACT. The process was started to serve build X — its id says so,
     * the registry says so, and the routing will say so — so the pointer it
     * reads while it starts must name X's version.
     */
    expect(world.supervisor.loaded).toEqual([
      { id: processIdOf(ENVIRONMENT, BUILD_X), version: versionOf(BUILD_X) },
    ]);

    /* And the deploy was serialized rather than lost: it lands once the rollout
       has given the pointer back. */
    await expect(world.deploying).resolves.toMatchObject({ project: PROJECT });
    await expect
      .poll(() => world.events.includes(`published ${ENVIRONMENT}`), {
        timeout: PUBLISH_WAIT_MS,
        interval: 25,
      })
      .toBe(true);
    await expect(pointerVersion(world.registry, ENVIRONMENT)).resolves.toBe(versionOf(BUILD_Y));
  });

  it("holds the pointer across the spawn, and gives it back once the pass is done", async () => {
    const world = await seededWorld();
    let heldAtSpawn: string | null = null;

    world.supervisor.onSpawn = async (): Promise<void> => {
      heldAtSpawn = await lockHolderOf(world.registry, ENVIRONMENT);
    };

    await world.reconciler.runOnce();

    /* Held by this node while the process it just started is reading, and free
       again afterwards — a lock left behind would cost the next writer the whole
       stale window. */
    expect(heldAtSpawn).toContain(NODE);
    await expect(lockHolderOf(world.registry, ENVIRONMENT)).resolves.toBeNull();
  });
});

describe("a rollout starting while a deploy is bundling", () => {
  it("waits for the pointer, and loads the build it was started for", async () => {
    const world = await seededWorld();
    const bundling = world.holdPublish();

    const deploying = startDeploy(world.deploys);
    await expect.poll(() => world.events.includes(`publishing ${ENVIRONMENT}`)).toBe(true);

    /* The pass runs while the artifact is still being bundled: the deploy has
       held the pointer since before it started, and moves it at the end. */
    const pass = world.reconciler.runOnce();
    await sleep(READ_WINDOW_MS);
    expect(world.supervisor.loaded, "the rollout spawned inside the deploy's window").toEqual([]);

    bundling.resolve();
    await deploying;
    await pass;

    expect(world.events).toEqual([
      `publishing ${ENVIRONMENT}`,
      `published ${ENVIRONMENT}`,
      `spawned ${processIdOf(ENVIRONMENT, BUILD_X)}`,
    ]);
    expect(world.supervisor.loaded).toEqual([
      { id: processIdOf(ENVIRONMENT, BUILD_X), version: versionOf(BUILD_X) },
    ]);
  });

  it("records the wait and leaves the pass alone rather than stalling behind it", async () => {
    /* A rollout that cannot have the pointer is not urgent — whoever holds it is
       a deploy that will ask for its own rollout the moment it lands — so it
       gives up quickly and the loop carries on with every other environment. */
    const world = await seededWorld({ pointerLock: { timeoutMs: 20 } });
    const bundling = world.holdPublish();

    const deploying = startDeploy(world.deploys);
    await expect.poll(() => world.events.includes(`publishing ${ENVIRONMENT}`)).toBe(true);

    await world.reconciler.runOnce();
    const failures = world.reconciler.status().failures;

    expect(world.supervisor.loaded).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      action: "rollout",
      subject: processIdOf(ENVIRONMENT, BUILD_X),
    });
    expect(failures[0]?.detail).toContain(`${PROJECT}/${ENVIRONMENT}`);

    bundling.resolve();
    await deploying;
  });
});

describe("two environments of one project", () => {
  it("never wait for each other's pointer", async () => {
    /* One lock per project and environment, because that is the granularity of
       the pointer they contend for. A deploy into one environment must not stop
       another environment being brought into service. */
    const world = await seededWorld({ environments: [ENVIRONMENT, OTHER], flipped: [OTHER] });
    const bundling = world.holdPublish();

    const deploying = startDeploy(world.deploys);
    await expect.poll(() => world.events.includes(`publishing ${ENVIRONMENT}`)).toBe(true);

    await world.reconciler.runOnce();

    /* The rollout of the other environment ran to the end while the deploy was
       still bundling — the lock it was waiting on is not this one's. */
    expect(world.events).toEqual([
      `publishing ${ENVIRONMENT}`,
      `spawned ${processIdOf(OTHER, BUILD_X)}`,
    ]);
    expect(world.supervisor.loaded).toEqual([
      { id: processIdOf(OTHER, BUILD_X), version: versionOf(BUILD_X) },
    ]);
    expect(world.reconciler.status().failures).toEqual([]);

    bundling.resolve();
    await deploying;
  });
});

/* ---- the world one node reconciles and deploys into ---- */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface WorldOptions {
  /** Environments of the project. Defaults to the one every case uses. */
  environments?: string[];
  /** Which of them have an alias, and are therefore rolled out. Defaults to all. */
  flipped?: string[];
  /** How the node's rollouts hold the pointer. Defaults to a hold nothing waits on. */
  pointerLock?: PointerLockOptions;
}

interface World {
  registry: RegistryContext;
  daemon: DaemonContext;
  supervisor: FakeSupervisor;
  reconciler: Reconciler;
  deploys: DeployService;
  /** Publishes and spawns, in the order they happened. */
  events: string[];
  /** Holds the next publish open, as a bundle that takes its time would. */
  holdPublish(): Deferred<void>;
  /** The deploy a case started from inside a spawn, to be awaited before it ends. */
  deploying?: Promise<DeployStatus>;
}

async function seededWorld(opts?: WorldOptions): Promise<World> {
  const store = new MemoryCasStore();
  const { ctx } = ctxWith(store);
  const environments = opts?.environments ?? [ENVIRONMENT];
  const flipped = opts?.flipped ?? environments;

  await createProject(ctx, { slug: PROJECT });
  await createBuild(ctx, PROJECT, {
    id: BUILD_X,
    celldVersionId: versionOf(BUILD_X),
    runtimeConfigurable: true,
  });
  for (const environment of environments) {
    await createEnvironment(ctx, PROJECT, { name: environment });
    if (flipped.includes(environment)) await setCurrentBuild(ctx, PROJECT, environment, BUILD_X);
    await seedFleet(ctx, environment);
  }
  const lease = await acquireLease(ctx, NODE);
  if (lease === null) throw new Error("the fixture could not take the coordinator lease");
  for (const environment of environments)
    await writePlacement(ctx, PROJECT, environment, [NODE], lease);

  const events: string[] = [];
  let bundling: Deferred<void> | null = null;
  const supervisor = fakeSupervisor(ctx, events);

  const daemon: DaemonContext = {
    config: daemonConfig(),
    nodeId: NODE,
    registry: ctx,
    supervisor,
    version: "0.0.0-test",
    credits: createCreditController({ allocatableMb: 10_000, surgeMb: 512 }),
  };
  const reconciler = createReconciler(daemon, createCelldDriver({ store }), {
    baseEnv: { PATH: "/usr/bin:/bin" },
    /* Nothing listens on a port here: the gate is answered rather than dialled,
       because what these cases are about happens before it. */
    probe: { attempts: 1, fetchFn: readyFetch },
    ...(opts?.pointerLock === undefined ? {} : { pointerLock: opts.pointerLock }),
  });
  daemon.reconciler = reconciler;

  const runner = fakeRunner(ctx, events, () => bundling?.promise);
  const deploys = createDeployService(daemon, runner, {
    routedTimeoutMs: 50,
    pollMs: 5,
    /* Twice the worst case a deploy here actually waits, so the budget is never
       what decides a case — and still far short of the shipped
       `DEPLOY_LOCK_TIMEOUT_MS`, so one that wedges fails rather than waiting the
       real one out. */
    lockTimeoutMs: PUBLISH_WAIT_MS * 2,
  });
  daemon.deploys = deploys;

  return {
    registry: ctx,
    daemon,
    supervisor,
    reconciler,
    deploys,
    events,
    holdPublish(): Deferred<void> {
      bundling = deferred<void>();
      return bundling;
    },
  };
}

/** The pointer objects and version manifests a deployed fleet carries. */
async function seedFleet(ctx: RegistryContext, environment: string): Promise<void> {
  const fleet = fleetPrefix(PROJECT, environment);
  const pointer = {
    script_name: SCRIPT,
    version: BASE_VERSION,
    prefix: `deploy/${SCRIPT}/${BASE_VERSION}`,
    rollout: { percent: 100 },
  };

  await putJson(ctx, `${fleet}/deploy/current.json`, pointer);
  await putJson(ctx, `${fleet}/deploy/${SCRIPT}/current.json`, pointer);
  for (const build of [BUILD_X, BUILD_Y]) {
    await putJson(ctx, `${fleet}/deploy/${SCRIPT}/${versionOf(build)}/manifest.json`, {
      modules: [],
    });
  }
}

/** The version the fleet's own pointer names right now. */
async function pointerVersion(ctx: RegistryContext, environment: string): Promise<string> {
  const found = await readJson<{ version: string }>(
    ctx,
    `${fleetPrefix(PROJECT, environment)}/deploy/current.json`,
  );
  return found?.value.version ?? "none";
}

/** Who holds one environment's pointer lock right now, or null when nobody does. */
async function lockHolderOf(ctx: RegistryContext, environment: string): Promise<string | null> {
  const found = await readJson<{ holder: string }>(ctx, pointerLockKey(PROJECT, environment));
  return found?.value.holder ?? null;
}

function deployMeta(): DeployMeta {
  return {
    project: PROJECT,
    environment: ENVIRONMENT,
    script: SCRIPT,
    buildId: BUILD_Y,
    runtimeConfigurable: true,
  };
}

async function startDeploy(deploys: DeployService): Promise<DeployStatus> {
  const admission = await deploys.admit(deployMeta());
  return admission.start(
    {
      byteLength: 1,
      open: () => new Blob([new Uint8Array([1])]).stream(),
      dispose: () => Promise.resolve(),
    },
    deploys.reserve(PROJECT),
  );
}

/**
 * What `celld deploy` does to the bucket: it bundles and uploads the version's
 * modules, and MOVES THE POINTER — named object first, fleet-wide object after,
 * with no conditional write and no regard for what else is starting.
 */
function fakeRunner(
  ctx: RegistryContext,
  events: string[],
  bundling: () => Promise<void> | undefined,
): DeployRunner {
  return {
    async run(input: DeployRunInput): Promise<{ celldVersionId: string }> {
      events.push(`publishing ${input.environment}`);
      await bundling();

      const version = versionOf(BUILD_Y);
      const pointer = {
        script_name: input.script,
        version,
        prefix: `deploy/${input.script}/${version}`,
        rollout: { percent: 100 },
      };

      await putJson(ctx, `${input.target.prefix}/deploy/${input.script}/current.json`, pointer);
      await putJson(ctx, `${input.target.prefix}/deploy/current.json`, pointer);
      events.push(`published ${input.environment}`);
      return { celldVersionId: version };
    },
  };
}

interface FakeSupervisor extends Supervisor {
  /** What each spawned process read out of the pointer, in the order they started. */
  readonly loaded: { id: string; version: string }[];
  /** Runs at the moment a process is spawned, before it reads the pointer. */
  onSpawn?: (spec: ProcessSpec) => Promise<void>;
}

/**
 * A supervisor that makes the ONE read a starting runtime process makes: the
 * fleet pointer, once, while it starts. What it read is what that process would
 * serve for the whole of its life.
 */
function fakeSupervisor(ctx: RegistryContext, events: string[]): FakeSupervisor {
  const statuses = new Map<string, ProcessStatus>();

  const supervisor: FakeSupervisor = {
    loaded: [],

    async start(spec: ProcessSpec): Promise<ProcessStatus> {
      await supervisor.onSpawn?.(spec);

      const environment = spec.id.split("--")[1] ?? ENVIRONMENT;
      supervisor.loaded.push({ id: spec.id, version: await pointerVersion(ctx, environment) });
      events.push(`spawned ${spec.id}`);

      const status: ProcessStatus = {
        id: spec.id,
        state: "running",
        pid: 2000 + statuses.size,
        startedAt: "2026-01-01T00:00:00.000Z",
      };
      statuses.set(spec.id, status);
      return status;
    },

    stop(id: string): Promise<void> {
      const status = statuses.get(id);
      if (status !== undefined) statuses.set(id, { ...status, state: "exited", exitCode: null });
      return Promise.resolve();
    },

    status: (id: string): ProcessStatus | null => statuses.get(id) ?? null,
    list: (): ProcessStatus[] => [...statuses.values()].map((status) => ({ ...status })),
    onExit: (): void => {},
  };
  return supervisor;
}

function daemonConfig(): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: NODE, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
      pointerHoldMs: 3_000,
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** Every readiness probe answered 200, so a started process is ready at once. */
const readyFetch = ((): Promise<Response> =>
  Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
