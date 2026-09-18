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
import { acquireLease, type LeaseHandle } from "../../src/core/registry/lease.ts";
import { executeReap, planReap } from "../../src/core/registry/reaper.ts";
import { trustOperator } from "../../src/core/registry/operators.ts";
import type { RegistryContext } from "../../src/core/registry/context.ts";
import type { DeployRunner, StagedArtifact } from "../../src/core/types/deploy.ts";
import type { RuntimeDriver } from "../../src/core/types/runtime.ts";
import type { CasStore } from "../../src/core/types/store.ts";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../../src/core/types/supervisor.ts";
import { runAssignment, type AssignmentResult } from "../../src/daemon/_assign.ts";
import { createNodeApp, type DaemonContext } from "../../src/daemon/app.ts";
import type { DaemonConfig } from "../../src/daemon/config.ts";
import { createDeployService, type DeployStatus } from "../../src/daemon/deploys.ts";
import { createHeartbeat } from "../../src/daemon/heartbeat.ts";
import { createReconciler, type Reconciler } from "../../src/daemon/reconcile.ts";
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

/** Every scenario that measures one pass or one request. */
export const SCENARIOS: readonly ScenarioName[] = [
  "idleReconcilePass",
  "coordinatorAssignPass",
  "reapPass",
  "heartbeat",
  "oneDeploy",
  "listApplicationsRoute",
  "stateRoute",
  "ingressRoutes",
  "ingressAsk",
] as const;

export type ScenarioName =
  | "idleReconcilePass"
  | "coordinatorAssignPass"
  | "reapPass"
  | "heartbeat"
  | "oneDeploy"
  | "listApplicationsRoute"
  | "stateRoute"
  | "ingressRoutes"
  | "ingressAsk";

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
  now: Date;
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
  const now = (): Date => SCALE_NOW;
  const seed = await seedRegistry(
    { store, now },
    profile,
    opts?.concurrency === undefined
      ? { now: SCALE_NOW }
      : { now: SCALE_NOW, concurrency: opts.concurrency },
  );

  const meter = meterStore(store);
  return { profile, seed, store, meter, registry: { store: meter, now }, now: SCALE_NOW };
}

/** Runs one named scenario against `world`. */
export async function runScenario(name: ScenarioName, world: ScaleWorld): Promise<ScenarioResult> {
  switch (name) {
    case "idleReconcilePass": {
      return idleReconcilePass(world);
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
    case "ingressAsk": {
      return ingressAsk(world);
    }
  }
}

/* --------------------------------------------------------------- (a) reconcile */

/**
 * One node's reconcile pass in steady state.
 *
 * The SECOND pass is the measured one: the first starts a process for every
 * application placed here, and from then on the supervisor reports them all
 * running, so the measured pass plans nothing and its whole cost is what it
 * spent finding that out.
 */
export async function idleReconcilePass(world: ScaleWorld): Promise<ScenarioResult> {
  const { daemon } = reconcilingDaemon(world);
  const reconciler = daemon.reconciler as Reconciler;
  await reconciler.runOnce();

  world.meter.reset();
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

/* -------------------------------------------------------------- (b) assignment */

/** One assignment pass of the lease holder over an installation it has nothing to change in. */
export async function coordinatorAssignPass(world: ScaleWorld): Promise<ScenarioResult> {
  const lease = await heldLease(world);

  world.meter.reset();
  const started = performance.now();
  const result: AssignmentResult = await runAssignment(world.registry, lease);
  const wallMs = performance.now() - started;

  return {
    scenario: "coordinatorAssignPass",
    snapshot: world.meter.snapshot(),
    wallMs,
    notes: {
      live: result.live.length,
      changed: result.changed.length,
      removed: result.removed.length,
      skipped: result.skipped.length,
      unplaced: result.unplaced.length,
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
export async function reapPass(world: ScaleWorld): Promise<ScenarioResult> {
  const lease = await heldLease(world);

  world.meter.reset();
  const started = performance.now();
  const plan = await planReap(world.registry, {});
  const result = await executeReap(world.registry, plan, lease, {});
  const wallMs = performance.now() - started;

  return {
    scenario: "reapPass",
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
  const { daemon } = reconcilingDaemon(world);
  await (daemon.reconciler as Reconciler).runOnce();
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
      serving: (daemon.reconciler as Reconciler).status().processes.length,
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
  const applications = world.seed.applications.slice(0, opts.deploys);
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

  const runs = applications.map(async (application) => {
    try {
      accepted.push(await startDeploy(daemon, application));
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
  const { daemon } = reconcilingDaemon(world);
  daemon.storage = ingressStorage();
  daemon.ingressFormats = {
    traefik: (routing, { prefer }) =>
      renderTraefikConfig(routing, prefer === undefined ? {} : { prefer }),
  };
  await (daemon.reconciler as Reconciler).runOnce();
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
      routes: (daemon.reconciler as Reconciler).fleetRouting()?.routes.length ?? 0,
    },
  };
}

/* -------------------------------------------------------------- (i) ingress ask */

/** One `GET /v1/ingress/ask` for a platform host, and one for a custom domain. */
export async function ingressAsk(world: ScaleWorld): Promise<ScenarioResult> {
  const daemon = daemonFor(world);
  const app = createNodeApp(daemon);
  const custom = world.seed.customHost;

  world.meter.reset();
  const started = performance.now();
  const platform = await app.request(`/v1/ingress/ask?domain=${world.seed.platformHost}`);
  const afterPlatform = world.meter.snapshot();
  const claimed = custom === null ? null : await app.request(`/v1/ingress/ask?domain=${custom}`);
  const wallMs = performance.now() - started;

  const snapshot = world.meter.snapshot();
  return {
    scenario: "ingressAsk",
    snapshot,
    wallMs,
    notes: {
      platformStatus: platform.status,
      platformGets: afterPlatform.gets,
      customStatus: claimed?.status ?? 0,
      customGets: snapshot.gets - afterPlatform.gets,
    },
  };
}

/* ------------------------------------------------------------------- internals */

/** The daemon a node assembles, with the seeded installation under it. */
export function daemonFor(world: ScaleWorld): DaemonContext {
  const nodeId = world.seed.nodes[0] as string;
  return {
    config: daemonConfig(nodeId),
    nodeId,
    registry: world.registry,
    supervisor: idleSupervisor(),
    versions: { scafo: "0.0.0-scale", celld: MIN_CELLD_VERSION },
  };
}

/** A daemon with a real reconcile loop over a supervisor that always succeeds. */
function reconcilingDaemon(world: ScaleWorld): { daemon: DaemonContext } {
  const daemon = daemonFor(world);
  daemon.supervisor = runningSupervisor();
  daemon.reconciler = createReconciler(daemon, specOnlyDriver(), { baseEnv: { PATH: "/bin" } });
  return { daemon };
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
  return {
    stopGraceMs: 30_000,
    processSpec: (input) => ({
      id: input.application.name,
      command: "celld",
      args: [],
      env: {},
    }),
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
    runtime: { binPath: "celld", portRangeStart: PORT_RANGE_START, bindHost: "127.0.0.1" },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}
