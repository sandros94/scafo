/*
 * What each periodic and per-deploy code path costs the bucket, measured by
 * driving the REAL code against a metered store.
 *
 * Nothing here reimplements a pass, a route or a deploy: every scenario
 * assembles the daemon the way the node does, hands it the seeded registry, and
 * reads the meter. The only fakes are the two seams a measurement may not
 * cross — the supervisor that would fork a Celld process, and the deploy runner
 * that would publish into a bucket — and both are shaped exactly like the fakes
 * the unit suites already drive these pieces with.
 */

import type { JWK_OKP_Private } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { signNodeToken } from "../../src/core/auth/index.ts";
import { hintingStore } from "../../src/core/registry/changes.ts";
import {
  acquireLease,
  DEFAULT_LEASE_TTL_MS,
  type LeaseHandle,
} from "../../src/core/registry/lease.ts";
import { heartbeatNode } from "../../src/core/registry/nodes.ts";
import {
  createReapCache,
  executeReap,
  planReap,
  type ReapCache,
} from "../../src/core/registry/reaper.ts";
import {
  DEFAULT_NODE_REFRESH_INTERVAL_MS,
  DEFAULT_REGISTRY_RESYNC_MS,
} from "../../src/core/registry/view.ts";
import { trustOperator } from "../../src/core/registry/operators.ts";
import type { PortPair } from "../../src/core/placement/ports.ts";
import type { RegistryContext } from "../../src/core/registry/context.ts";
import type { DeployRunner, StagedArtifact } from "../../src/core/types/deploy.ts";
import type { RuntimeDriver, RuntimePorts } from "../../src/core/types/runtime.ts";
import type { CasStore } from "../../src/core/types/store.ts";
import type { NodeServing } from "../../src/core/types/registry.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../../src/core/types/supervisor.ts";
import { registryView } from "../../src/daemon/_view.ts";
import { createCoordinator } from "../../src/daemon/coordinator.ts";
import { type QueueWait, uploadUntilAdmitted } from "../../src/cli/commands/deploy.ts";
import { createNodeApp, type DaemonContext } from "../../src/daemon/app.ts";
import type { DaemonConfig } from "../../src/daemon/config.ts";
import { DEFAULT_QUEUE_TIMEOUT_MS } from "../../src/daemon/_deploy-scheduler.ts";
import { createDeployService, type DeployStatus } from "../../src/daemon/deploys.ts";
import { createHeartbeat } from "../../src/daemon/heartbeat.ts";
import { createProcessHealth } from "../../src/daemon/_process-health.ts";
import {
  createReconciler,
  DEFAULT_RECONCILE_INTERVAL_MS,
  type Reconciler,
} from "../../src/daemon/reconcile.ts";
import type { StorageService } from "../../src/daemon/storage.ts";
import { renderTraefikConfig } from "../../src/drivers/ingress/traefik.ts";
import { MIN_CELLD_VERSION } from "../../src/drivers/runtime/celld.ts";
import { MemoryCasStore } from "../../src/drivers/store/memory.ts";
import { meterStore, type MeteringStore, type MeterSnapshot } from "./_meter.ts";
import {
  hex16,
  PLATFORM_DOMAIN,
  PORT_RANGE_START,
  seedRegistry,
  type ScaleProfile,
  type SeededRegistry,
} from "./_seed.ts";

/** The moment every measured installation is frozen at. */
export const SCALE_NOW: Date = new Date("2026-01-01T00:00:00.000Z");

/** The operator key every measured request is made with. */
const ADMIN_ID = "op-scale-admin";

/** The token an ingress presents for the routing and storage surfaces. */
const INGRESS_TOKEN = "ingress-token-for-measurement";

/**
 * Every scenario that measures one pass or one request, in the order they run.
 *
 * THE ORDER IS PART OF THE MEASUREMENT. A node's loops carry state between
 * passes — the registry view, the reaper's record cache — and what a pass costs
 * depends on what the pass before it left. Each scenario below therefore runs
 * against the state its predecessors produced, exactly as a running node does.
 */
export const SCENARIOS: readonly ScenarioName[] = [
  "idleReconcilePass",
  "nodeRefreshPass",
  "resyncPass",
  "coordinatorAssignPass",
  "reapPass",
  "reapPassAgain",
  "heartbeat",
  "oneDeploy",
  "peerSeesDeploy",
  "listApplicationsRoute",
  "stateRoute",
  "ingressRoutes",
] as const;

export type ScenarioName =
  | "idleReconcilePass"
  | "nodeRefreshPass"
  | "resyncPass"
  | "coordinatorAssignPass"
  | "reapPass"
  | "reapPassAgain"
  | "heartbeat"
  | "oneDeploy"
  | "peerSeesDeploy"
  | "listApplicationsRoute"
  | "stateRoute"
  | "ingressRoutes";

/** What one scenario cost, and what it did while costing it. */
export interface ScenarioResult {
  scenario: string;
  snapshot: MeterSnapshot;
  /** What the run observed beyond the store: sizes, outcomes, counts. */
  notes: Record<string, number | string>;
  /** Wall time the measured stretch took, in milliseconds. */
  wallMs: number;
}

/** A seeded installation, and the metered store every scenario drives it through. */
export interface ScaleWorld {
  profile: ScaleProfile;
  seed: SeededRegistry;
  /** The store under the meter: seeding and setup write through this one. */
  store: CasStore;
  meter: MeteringStore;
  /** What the measured code is given, and the only thing it ever touches. */
  registry: RegistryContext;
  /** The moment the installation was seeded at; the clock starts here. */
  now: Date;
  /** Moves the world's clock on, so a loop's own timer comes due. */
  advance(ms: number): void;
  /** Epoch milliseconds as every measured piece of code reads them. */
  nowMs(): number;
  /** The node under measurement, built once and kept: its view lives across passes. */
  node?: ScaleNode;
}

/** One assembled node of the installation, with the loops that hold state. */
export interface ScaleNode {
  daemon: DaemonContext;
  reconciler: Reconciler;
}

export interface ScaleWorldOptions {
  /** The store to build on. Defaults to a fresh in-memory one. */
  store?: CasStore;
  /** Seeding writes in flight at once. */
  concurrency?: number;
}

/** Seeds one installation of `profile` and puts a meter in front of it. */
export async function createScaleWorld(
  profile: ScaleProfile,
  opts?: ScaleWorldOptions,
): Promise<ScaleWorld> {
  const store = opts?.store ?? new MemoryCasStore();
  let nowMs = SCALE_NOW.getTime();
  const now = (): Date => new Date(nowMs);
  /* Seeded through the BARE store: seeding is setup, and a change token for each
     of fifty thousand records would measure nothing but the seeding. */
  const seed = await seedRegistry(
    { store, now },
    profile,
    opts?.concurrency === undefined
      ? { now: SCALE_NOW }
      : { now: SCALE_NOW, concurrency: opts.concurrency },
  );

  /* Hinting UNDER the meter, so the token a mutation mints is counted as the
     bucket write it is, and the registry every scenario drives is shaped
     exactly like the one `createRegistry` builds on a real node. */
  const meter = meterStore(hintingStore(store));
  return {
    profile,
    seed,
    store,
    meter,
    registry: { store: meter, now },
    now: SCALE_NOW,
    advance: (ms: number): void => void (nowMs += ms),
    nowMs: (): number => nowMs,
  };
}

/** Runs one named scenario against `world`. */
export async function runScenario(name: ScenarioName, world: ScaleWorld): Promise<ScenarioResult> {
  switch (name) {
    case "idleReconcilePass": {
      return idleReconcilePass(world);
    }
    case "nodeRefreshPass": {
      return nodeRefreshPass(world);
    }
    case "resyncPass": {
      return resyncPass(world);
    }
    case "reapPassAgain": {
      return reapPass(world, { scenario: "reapPassAgain" });
    }
    case "peerSeesDeploy": {
      return peerSeesDeploy(world);
    }
    case "coordinatorAssignPass": {
      return coordinatorAssignPass(world);
    }
    case "reapPass": {
      return reapPass(world);
    }
    case "heartbeat": {
      return heartbeat(world);
    }
    case "oneDeploy": {
      return oneDeploy(world);
    }
    case "listApplicationsRoute": {
      return listApplicationsRoute(world);
    }
    case "stateRoute": {
      return stateRoute(world);
    }
    case "ingressRoutes": {
      return ingressRoutes(world);
    }
  }
}

/* --------------------------------------------------------------- (a) reconcile */

/**
 * One node's reconcile pass in steady state: the pass a node spends almost all
 * of its life running.
 *
 * The SECOND pass is the measured one. The first starts a process for every
 * application placed here and fills the node's registry view; from then on the
 * supervisor reports them all running and the change hint has not moved, so the
 * measured pass plans nothing and its whole cost is finding that out.
 */
export async function idleReconcilePass(world: ScaleWorld): Promise<ScenarioResult> {
  const { reconciler } = scaleNode(world);
  await settled(world);

  world.meter.reset();
  /* Inside the reconcile interval and inside every timer the view holds: what
     is measured is a pass where nothing at all has come due. */
  world.advance(DEFAULT_RECONCILE_INTERVAL_MS);
  const started = performance.now();
  const plan = await reconciler.runOnce();
  const wallMs = performance.now() - started;

  return {
    scenario: "idleReconcilePass",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      actions: plan.length,
      failures: reconciler.status().failures.length,
      processes: reconciler.status().processes.length,
      routes: reconciler.fleetRouting()?.routes.length ?? 0,
    },
  };
}

/**
 * The pass on which the node records come due again.
 *
 * Liveness is the AGE of a heartbeat, and no write announces a death, so nothing
 * hints about it: the nodes are re-listed on a timer of their own. In steady
 * state every node has beaten since the last look, so every node record is read.
 */
export async function nodeRefreshPass(world: ScaleWorld): Promise<ScenarioResult> {
  const { reconciler } = scaleNode(world);
  await settled(world);
  /* Every node beats on its own interval; by the time this pass runs, they have. */
  await beatEveryNode(world);

  world.meter.reset();
  world.advance(DEFAULT_NODE_REFRESH_INTERVAL_MS);
  const started = performance.now();
  const plan = await reconciler.runOnce();
  const wallMs = performance.now() - started;

  return {
    scenario: "nodeRefreshPass",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: { actions: plan.length, failures: reconciler.status().failures.length },
  };
}

/**
 * A full resync with nothing changed: the bound on a hint that never arrived.
 *
 * Every kind is listed again whatever the token says, and not one record is
 * read — every ETag is the one the view already holds.
 */
export async function resyncPass(world: ScaleWorld): Promise<ScenarioResult> {
  const { reconciler } = scaleNode(world);
  await settled(world);

  world.meter.reset();
  world.advance(DEFAULT_REGISTRY_RESYNC_MS);
  const started = performance.now();
  const plan = await reconciler.runOnce();
  const wallMs = performance.now() - started;

  return {
    scenario: "resyncPass",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: { actions: plan.length, failures: reconciler.status().failures.length },
  };
}

/**
 * What one deploy costs a node that did NOT accept it.
 *
 * The peer is caught up first, then a deploy is published elsewhere, and the
 * measured pass is the one that notices: the hint moved, so it lists what
 * routing is decided from and reads back exactly the records that changed.
 */
export async function peerSeesDeploy(world: ScaleWorld): Promise<ScenarioResult> {
  const peer = buildNode(world, world.seed.nodes.at(-1) as string);
  /* Caught up first, boot effects and all: what is measured is the pass that
     notices a deploy, not the pass that finds out what this node runs. */
  await peer.reconciler.runOnce();
  await peer.reconciler.runOnce();

  const application = world.seed.applications[1] as string;
  const accepting = daemonFor(world);
  accepting.deploys = createDeployService(
    accepting,
    fixedRunner(() => Promise.resolve(hex16(`${application}/peer-deploy`))),
  );
  const status = await startDeploy(accepting, application);
  const settled = await settleDeploy(accepting, status.id);
  await accepting.deploys.stop(new Error("the deploy is over"));

  world.meter.reset();
  world.advance(DEFAULT_RECONCILE_INTERVAL_MS);
  const started = performance.now();
  const plan = await peer.reconciler.runOnce();
  const wallMs = performance.now() - started;

  return {
    scenario: "peerSeesDeploy",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      state: settled.state,
      actions: plan.length,
      failures: peer.reconciler.status().failures.length,
    },
  };
}

/* -------------------------------------------------------------- (b) assignment */

/**
 * One assignment pass of the lease holder over an installation it has nothing to
 * change in.
 *
 * THE MEASURED TICK IS ONE THAT DECIDES NOTHING. The tick before it read the
 * fleet and decided every application; this one holds the same inputs against
 * what that pass decided from, finds them identical, and skips the pass
 * entirely — so the whole of what a coordinator costs an idle installation is
 * the hint it reads and the lease it renews.
 */
export async function coordinatorAssignPass(world: ScaleWorld): Promise<ScenarioResult> {
  const { daemon } = scaleNode(world);
  const coordinator = daemon.coordinator ?? createCoordinator(daemon);
  daemon.coordinator = coordinator;
  const tickMs = Math.floor(DEFAULT_LEASE_TTL_MS / 3);

  /* The scenarios before this one moved the world's clock past a heartbeat
     interval or two; a fleet nobody has heard from is one no pass may place
     work on, and that is a different measurement from this one. */
  await beatEveryNode(world);
  world.advance(DEFAULT_NODE_REFRESH_INTERVAL_MS);
  await coordinator.runOnce();

  world.meter.reset();
  world.advance(tickMs);
  const started = performance.now();
  await coordinator.runOnce();
  const wallMs = performance.now() - started;

  const status = coordinator.status();
  return {
    scenario: "coordinatorAssignPass",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      holding: String(status.holding),
      skippedAssignments: status.skippedAssignments,
      changed: status.lastAssignment?.changed.length ?? 0,
      removed: status.lastAssignment?.removed.length ?? 0,
      unplaced: status.lastAssignment?.unplaced.length ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ (c) reaper */

/**
 * One reaper pass with nothing to reap, planned and executed the way the
 * coordinator runs them: no deployment retention is configured by default, so
 * no deployment is ever a candidate and the pass weighs applications and
 * deploys alone.
 */
export async function reapPass(
  world: ScaleWorld,
  opts?: { scenario?: ScenarioName },
): Promise<ScenarioResult> {
  const lease = await heldLease(world);
  const cache = reapCacheOf(world);
  const snapshot = registryView(scaleNode(world).daemon).current();
  const reapOptions = {
    cache,
    applications: snapshot.applications,
    nodes: snapshot.nodes,
  };
  /* The SECOND pass of the pair is what "reapPassAgain" measures: the first
     read every record once, and a terminal one never moves again. */
  if (opts?.scenario === "reapPassAgain") {
    await executeReap(world.registry, await planReap(world.registry, reapOptions), lease, {});
  }

  world.meter.reset();
  const started = performance.now();
  const plan = await planReap(world.registry, reapOptions);
  const result = await executeReap(world.registry, plan, lease, {});
  const wallMs = performance.now() - started;

  return {
    scenario: opts?.scenario ?? "reapPass",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      plannedApplications: plan.applications.length,
      plannedDeploys: plan.deploys.length,
      plannedStaleDeploys: plan.staleDeploys.length,
      plannedDeployments: plan.deployments.length,
      deleted: result.deleted.length,
      failed: result.failed.length,
    },
  };
}

/* --------------------------------------------------------------- (d) heartbeat */

/** One heartbeat of a node that is serving everything placed on it. */
export async function heartbeat(world: ScaleWorld): Promise<ScenarioResult> {
  const { daemon, reconciler } = scaleNode(world);
  await reconciler.runOnce();
  const beating = createHeartbeat(daemon);

  world.meter.reset();
  const started = performance.now();
  await beating.beat();
  const wallMs = performance.now() - started;

  return {
    scenario: "heartbeat",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      serving: reconciler.status().processes.length,
      failure: beating.status().lastFailure ?? "none",
    },
  };
}

/* --------------------------------------------------------------- (e) one deploy */

/** Everything one accepted deploy costs, from admission to the `deployed` record. */
export async function oneDeploy(world: ScaleWorld): Promise<ScenarioResult> {
  const application = world.seed.applications[0] as string;
  const daemon = daemonFor(world);
  const version = hex16(`${application}/measured-deploy`);
  daemon.deploys = createDeployService(
    daemon,
    fixedRunner(() => Promise.resolve(version)),
  );

  world.meter.reset();
  const started = performance.now();
  const status = await startDeploy(daemon, application);
  const settled = await settleDeploy(daemon, status.id);
  const wallMs = performance.now() - started;

  await daemon.deploys.stop(new Error("measurement is over"));
  return {
    scenario: "oneDeploy",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      state: settled.state,
      deployment: settled.deployment ?? "none",
      code: settled.code ?? "none",
    },
  };
}

/* ------------------------------------------------------------------ (f) a burst */

/** What one burst of concurrent deploys did. */
export interface BurstOutcome {
  scenario: string;
  /** Deploys started at once, each into an application of its own. */
  deploys: number;
  /** How long one publish takes on the burst's own virtual clock. */
  durationMs: number;
  accepted: number;
  deployed: number;
  /** Refusals by the code they carried. */
  refused: Record<string, number>;
  snapshot: MeterSnapshot;
  wallMs: number;
}

export interface BurstOptions {
  /** Deploys started at once. */
  deploys: number;
  /** Virtual milliseconds one publish takes. Defaults to ten seconds. */
  durationMs?: number;
  /**
   * Whether each deploy comes back for a place in the queue when it is refused,
   * as `scafo deploy` does. False is what `--no-wait` asks for, and measures the
   * node's bound rather than what a team of developers experiences.
   */
  wait?: boolean;
  /**
   * One application every deploy of the burst goes into, instead of one each:
   * a pipeline pushing the same repository over and over, which the per-
   * application bound is there to keep out of everyone else's queue.
   */
  application?: string;
}

/**
 * `n` deploys of `n` DIFFERENT applications, started at once against one node's
 * deploy service at its default bounds.
 *
 * The runner's duration is VIRTUAL and this scenario owns the clock: a publish
 * parks until the burst decides time has passed, and time only passes once
 * nothing else can run. Nothing here touches the process clock, so the
 * scheduler's own deadlines — receive, queue and task — stand at their real
 * defaults throughout and none of them elapses. What the burst measures is
 * therefore admission and capacity, not the timeouts.
 */
export async function deployBurst(world: ScaleWorld, opts: BurstOptions): Promise<BurstOutcome> {
  const durationMs = opts.durationMs ?? 10_000;
  const applications =
    opts.application === undefined
      ? world.seed.applications.slice(0, opts.deploys)
      : Array.from({ length: opts.deploys }, () => opts.application as string);
  if (applications.length < opts.deploys) {
    throw new Error(
      `the ${world.profile.name} profile holds ${String(applications.length)} applications, ` +
        `and a burst of ${String(opts.deploys)} needs one each`,
    );
  }

  const clock = virtualClock();
  const daemon = daemonFor(world);
  daemon.deploys = createDeployService(
    daemon,
    fixedRunner(async (application) => {
      await clock.after(durationMs);
      return hex16(`${application}/burst`);
    }),
  );

  world.meter.reset();
  const started = performance.now();
  const refused: Record<string, number> = {};
  const accepted: DeployStatus[] = [];

  /* THE CLI'S OWN RETRY LOOP, not an imitation of it: `scafo deploy` calls this
     very function, so what the burst measures is what a developer experiences.
     Its clock is virtual — the waiting is a yield rather than a delay — because
     what is being measured is admission and cost, not wall time. */
  let waitedMs = 0;
  const queueWait: QueueWait = {
    wait: opts.wait !== false,
    timeoutMs: DEFAULT_QUEUE_TIMEOUT_MS,
    nowMs: () => waitedMs,
    sleep: async (ms: number): Promise<void> => {
      waitedMs += ms;
      await tick();
    },
    /* No randomness: two runs of a profile must produce the same numbers. */
    jitter: (windowMs: number) => Math.floor(windowMs * 0.5),
    log: (): void => {},
  };

  const runs = applications.map(async (application) => {
    try {
      accepted.push(
        await uploadUntilAdmitted(async () => startDeploy(daemon, application), queueWait),
      );
    } catch (error) {
      const code = codeOf(error);
      refused[code] = (refused[code] ?? 0) + 1;
    }
  });
  await Promise.all(runs);
  const settled = await settleAll(daemon, accepted, clock);
  const wallMs = performance.now() - started;
  await daemon.deploys.stop(new Error("burst is over"));

  for (const status of settled) {
    if (status.state !== "deployed")
      refused[status.code ?? "failed"] = (refused[status.code ?? "failed"] ?? 0) + 1;
  }

  return {
    scenario: `deployBurst(${String(opts.deploys)})`,
    deploys: opts.deploys,
    durationMs,
    accepted: accepted.length,
    deployed: settled.filter((status) => status.state === "deployed").length,
    refused,
    snapshot: world.meter.snapshot(),
    wallMs,
  };
}

/* ------------------------------------------------------------- (g) admin routes */

/** One `GET /v1/applications` as an admin. */
export async function listApplicationsRoute(world: ScaleWorld): Promise<ScenarioResult> {
  const { request } = await operatorClient(world);
  /* Once first, so the verifier's key cache holds what it holds in a running
     node: what is measured is a request in steady state, not the first one. */
  await request("/v1/applications");

  world.meter.reset();
  const started = performance.now();
  const response = await request("/v1/applications");
  const body = await response.text();
  const wallMs = performance.now() - started;

  return {
    scenario: "listApplicationsRoute",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: { status: response.status, bytes: new TextEncoder().encode(body).length },
  };
}

/** One `GET /v1/state` as an admin. */
export async function stateRoute(world: ScaleWorld): Promise<ScenarioResult> {
  const { request } = await operatorClient(world);
  await request("/v1/state");

  world.meter.reset();
  const started = performance.now();
  const response = await request("/v1/state");
  const body = await response.text();
  const wallMs = performance.now() - started;

  return {
    scenario: "stateRoute",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: { status: response.status, bytes: new TextEncoder().encode(body).length },
  };
}

/* ----------------------------------------------------------- (h) ingress routes */

/** One `GET /v1/ingress/routes` and one `/v1/ingress/routes/traefik`. */
export async function ingressRoutes(world: ScaleWorld): Promise<ScenarioResult> {
  const { daemon, reconciler } = scaleNode(world);
  daemon.storage = ingressStorage();
  daemon.ingressFormats = {
    traefik: (routing, { prefer }): unknown =>
      renderTraefikConfig(routing, prefer === undefined ? {} : { prefer }),
  };
  await reconciler.runOnce();
  const app = createNodeApp(daemon);
  const headers = { authorization: `Bearer ${INGRESS_TOKEN}` };

  world.meter.reset();
  const started = performance.now();
  const generic = await app.request("/v1/ingress/routes", { headers });
  const genericBody = await generic.text();
  const traefik = await app.request("/v1/ingress/routes/traefik?prefer=self", { headers });
  const traefikBody = await traefik.text();
  const wallMs = performance.now() - started;

  const encoder = new TextEncoder();
  return {
    scenario: "ingressRoutes",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      status: generic.status,
      traefikStatus: traefik.status,
      genericBytes: encoder.encode(genericBody).length,
      traefikBytes: encoder.encode(traefikBody).length,
      routes: reconciler.fleetRouting()?.routes.length ?? 0,
    },
  };
}

/* ------------------------------------------------------------------- internals */

/** The daemon a node assembles, with the seeded installation under it. */
export function daemonFor(world: ScaleWorld, id?: string): DaemonContext {
  const nodeId = id ?? (world.seed.nodes[0] as string);
  return {
    config: daemonConfig(nodeId),
    nodeId,
    registry: world.registry,
    supervisor: idleSupervisor(),
    /* What every real node keeps, and what decides which of its processes may be
       published as served: without one a node vouches for nothing. */
    processHealth: createProcessHealth({ log: () => {} }),
    versions: { scafo: "0.0.0-scale", celld: MIN_CELLD_VERSION },
  };
}

/**
 * The node every pass of this world runs on, built once and kept.
 *
 * KEPT, because the state that makes a pass cheap lives on it: the registry
 * view's caches, the revisions it has seen, the processes it believes it runs.
 * A scenario that built a node of its own would measure a cold boot every time,
 * which is the one pass a node runs once.
 */
function scaleNode(world: ScaleWorld): ScaleNode {
  world.node ??= buildNode(world, world.seed.nodes[0] as string);
  return world.node;
}

/** One assembled node of the installation, with a real reconcile loop. */
function buildNode(world: ScaleWorld, nodeId: string): ScaleNode {
  const daemon = daemonFor(world, nodeId);
  daemon.supervisor = runningSupervisor();
  const reconciler = createReconciler(daemon, specOnlyDriver(), { baseEnv: { PATH: "/bin" } });
  daemon.reconciler = reconciler;
  return { daemon, reconciler };
}

/** The reap cache one coordinator keeps for as long as it holds the lease. */
const reapCaches = new WeakMap<ScaleWorld, ReapCache>();

function reapCacheOf(world: ScaleWorld): ReapCache {
  let cache = reapCaches.get(world);
  if (cache === undefined) {
    cache = createReapCache();
    reapCaches.set(world, cache);
  }
  return cache;
}

/**
 * Runs passes until one changes nothing, so what follows measures steady state.
 *
 * A NODE'S FIRST PASSES ARE NOT ITS STEADY STATE. The first starts a process for
 * every application placed here and says so to the fleet, which mints a change
 * token; the second is the one that reads that token back. Only the third is the
 * pass a node spends the rest of its life running.
 */
async function settled(world: ScaleWorld): Promise<void> {
  const { reconciler } = scaleNode(world);
  for (let pass = 0; pass < 4; pass++) {
    world.meter.reset();
    await reconciler.runOnce();
    if (world.meter.snapshot().listCalls === 0) return;
  }
}

/** Every node of the installation says it is still there, as each one's own loop does. */
async function beatEveryNode(world: ScaleWorld): Promise<void> {
  for (const id of world.seed.nodes) {
    await heartbeatNode(world.registry, id, { serving: world.seed.serving.get(id) as NodeServing });
  }
}

/** The coordinator lease, taken by the node every scenario measures. */
async function heldLease(world: ScaleWorld): Promise<LeaseHandle> {
  const lease = await acquireLease(world.registry, world.seed.nodes[0] as string);
  if (lease === null) throw new Error("the coordinator lease could not be taken");
  return lease;
}

/* One admin key per installation: the key is what the operator record holds, so
   a second key under the same id is another identity and the registry says so. */
const admins = new WeakMap<ScaleWorld, Promise<JWK_OKP_Private<"EdDSA">>>();

/** A client that signs a fresh admin token for every request, as a CLI does. */
async function operatorClient(
  world: ScaleWorld,
): Promise<{ request: (path: string) => Promise<Response> }> {
  let pending = admins.get(world);
  if (pending === undefined) {
    pending = enrolAdmin(world);
    admins.set(world, pending);
  }
  const key = await pending;

  const app = createNodeApp(daemonFor(world));
  return {
    async request(path): Promise<Response> {
      /* Every token carries a fresh `jti`: they are single-use, and a verifier
         that has seen one refuses it. */
      const token = await signNodeToken(key, ADMIN_ID);
      return app.request(path, { headers: { authorization: `Bearer ${token}` } });
    },
  };
}

/** Trusts one admin key in `world`, and answers the half that signs. */
async function enrolAdmin(world: ScaleWorld): Promise<JWK_OKP_Private<"EdDSA">> {
  const keys = await generateJWK("EdDSA", { kid: ADMIN_ID });
  await trustOperator(world.registry, {
    id: ADMIN_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role: "admin",
  });
  return keys.privateKey;
}

/** Reserves, admits and starts one deploy the way the intake route does. */
async function startDeploy(daemon: DaemonContext, application: string): Promise<DeployStatus> {
  const service = daemon.deploys;
  if (service === undefined) throw new Error("this daemon takes no deploys");

  const reservation = service.reserve(application);
  try {
    const admission = await service.admit({ application });
    return await admission.start(stagedArtifact(), reservation);
  } catch (error) {
    reservation.cancel(error);
    throw error;
  }
}

/** Waits for a deploy to stop moving, letting everything it waits on run. */
async function settleDeploy(daemon: DaemonContext, id: string): Promise<DeployStatus> {
  for (let turn = 0; turn < 100_000; turn++) {
    const status = stoppedStatus(daemon, id);
    if (status !== null) return status;
    await tick();
  }
  throw new Error(`deploy "${id}" never finished`);
}

/**
 * Waits for every accepted deploy of a burst, moving the burst's own clock on
 * whenever a turn has left work parked on it.
 *
 * The clock is moved from HERE rather than from inside the runner because a
 * publish that has not reached the runner yet has not parked yet: a store that
 * takes a moment to answer would otherwise see the burst decide, correctly and
 * uselessly, that nothing was waiting for time to pass.
 */
async function settleAll(
  daemon: DaemonContext,
  accepted: DeployStatus[],
  clock: VirtualClock,
): Promise<DeployStatus[]> {
  for (let turn = 0; turn < 100_000; turn++) {
    const stopped = accepted.map((status) => stoppedStatus(daemon, status.id));
    if (stopped.every((status) => status !== null)) return stopped as DeployStatus[];

    await tick();
    clock.advance();
  }
  throw new Error("the burst never finished");
}

/** The deploy's status once it has stopped moving, or null while it still is. */
function stoppedStatus(daemon: DaemonContext, id: string): DeployStatus | null {
  const status = daemon.deploys?.get(id) ?? null;
  if (status === null) return null;
  return status.state === "deployed" || status.state === "failed" ? status : null;
}

/** A clock the burst owns, and the only thing that moves the runner's time. */
interface VirtualClock {
  /** Parks until the burst says `ms` of ITS time have passed. */
  after: (ms: number) => Promise<void>;
  /** Wakes whatever parked earliest, if anything has; says whether it did. */
  advance: () => boolean;
}

/**
 * Time the burst hands out.
 *
 * A publish parks here instead of on a timer, and the burst moves the clock on
 * only once everything that could run has run. Nothing about the process clock
 * changes, so the scheduler's real deadlines — receive, queue and task — are
 * neither shortened nor skipped, and a store that answers slowly costs wall
 * time without costing virtual time.
 */
function virtualClock(): VirtualClock {
  let nowMs = 0;
  let waiting: Array<{ at: number; wake: () => void }> = [];

  return {
    after(ms: number): Promise<void> {
      return new Promise<void>((resolve) => waiting.push({ at: nowMs + ms, wake: resolve }));
    },

    advance(): boolean {
      if (waiting.length === 0) return false;

      const next = waiting.reduce((soonest, entry) => (entry.at < soonest.at ? entry : soonest));
      nowMs = next.at;
      const due = waiting.filter((entry) => entry.at <= nowMs);
      waiting = waiting.filter((entry) => entry.at > nowMs);
      for (const entry of due) entry.wake();
      return true;
    },
  };
}

/** Lets every queued continuation and macrotask run once. */
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** The code of a typed failure, or what it was instead. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "unknown";
}

/** One uploaded artifact, already staged: a deploy's input without the bytes. */
function stagedArtifact(): StagedArtifact {
  const body = new TextEncoder().encode(`{"name":"measured"}`);
  return {
    byteLength: body.byteLength,
    open: (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(body);
          controller.close();
        },
      }),
    dispose: (): Promise<void> => Promise.resolve(),
  };
}

/** A publisher that answers with a version and writes nothing. */
function fixedRunner(version: (application: string) => Promise<string>): DeployRunner {
  return {
    async run(input) {
      return { celldVersionId: await version(input.application) };
    },
  };
}

/** A supervisor that reports every process it was asked to start as running. */
function runningSupervisor(): Supervisor {
  const statuses = new Map<string, ProcessStatus>();
  return {
    start(spec: ProcessSpec): Promise<ProcessStatus> {
      const status: ProcessStatus = {
        id: spec.id,
        state: "running",
        pid: 1000 + statuses.size,
        startedAt: SCALE_NOW.toISOString(),
      };
      statuses.set(spec.id, status);
      return Promise.resolve(status);
    },
    stop(id: string): Promise<void> {
      statuses.delete(id);
      return Promise.resolve();
    },
    status: (id: string): ProcessStatus | null => statuses.get(id) ?? null,
    list: (): ProcessStatus[] => [...statuses.values()],
    forget(id: string): void {
      if (statuses.get(id)?.state === "running") return;
      statuses.delete(id);
    },
    onExit: (): void => {},
  };
}

/** A supervisor for a daemon that runs no processes at all. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec: ProcessSpec): Promise<ProcessStatus> =>
      Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: (): Promise<void> => Promise.resolve(),
    status: (): ProcessStatus | null => null,
    list: (): ProcessStatus[] => [],
    forget: (): void => {},
    onExit: (): void => {},
  };
}

/** A runtime driver that builds a process spec and runs nothing. */
function specOnlyDriver(): RuntimeDriver {
  /* The ports each application holds here, as the real driver keeps them on
     disk: chosen once and handed back unchanged on every later start. */
  const held = new Map<string, PortPair>();
  let next = PORT_RANGE_START;

  return {
    stopGraceMs: 30_000,
    ports: (application): Promise<RuntimePorts> => {
      let ports = held.get(application);
      if (ports === undefined) {
        ports = { public: next, internal: next + 1 };
        next += 2;
        held.set(application, ports);
      }
      return Promise.resolve({ ports });
    },
    /* No process runs, so no directory is made and none is ever held. */
    prepareLocalState: (): Promise<void> => Promise.resolve(),
    heldLocalState: (): Promise<string[]> => Promise.resolve([]),
    removeLocalState: (): Promise<void> => Promise.resolve(),
    processSpec: (input) => ({
      id: input.application.name,
      command: "celld",
      args: [],
      env: {},
    }),
    /* No real listener is dialled, and the question costs the bucket nothing:
       every process this driver stands for answers at once. */
    ready: (): Promise<boolean> => Promise.resolve(true),
    /* Nothing is running, so nothing is ever asked to adopt. */
    reload: (): Promise<void> => Promise.resolve(),
  };
}

/** The storage surface the ingress routes stand behind, admitting one token. */
function ingressStorage(): StorageService {
  return {
    admit(event): void {
      const header = event.req.headers.get("authorization") ?? "";
      if (header !== `Bearer ${INGRESS_TOKEN}`) throw new Error("not this node's ingress token");
    },
    lock: (): Promise<void> => Promise.resolve(),
    unlock: (): Promise<void> => Promise.resolve(),
    held: (): string[] => [],
    start: (): void => {},
    stop: (): void => {},
    refresh: (): Promise<void> => Promise.resolve(),
  };
}

/** The configuration a measured node boots with; every bound is its default. */
function daemonConfig(nodeId: string): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: nodeId, listen: "127.0.0.1:7400", advertise: "10.0.0.1:7400" },
    platformDomains: [PLATFORM_DOMAIN],
    runtime: {
      binPath: "celld",
      portRangeStart: PORT_RANGE_START,
      portRangeEnd: PORT_RANGE_START + 998,
      portQuarantineMs: 600_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}
