/*
 * Deploy intake: what happens to an artifact between the request that uploads it
 * and the environment that ends up serving it.
 *
 * A deploy is accepted and answered immediately, then carried out in the
 * background — publishing an artifact takes longer than a request should wait on.
 * Progress is reported through a status object the caller polls.
 */

import { isScafoError } from "../core/error.ts";
import { createBuild } from "../core/registry/builds.ts";
import { createEnvironment, flipAlias, getEnvironment } from "../core/registry/environments.ts";
import { lockHolder, withLock } from "../core/registry/locks.ts";
import { fleetPrefix } from "../core/registry/paths.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import {
  DEPLOY_LOCK_TIMEOUT_MS,
  POINTER_LOCK_SPACE,
  pointerLockName,
} from "../core/registry/pointer-lock.ts";
import { createProject } from "../core/registry/projects.ts";
import { stampEnvironmentWake } from "../core/registry/wake.ts";
import type { DeployRunner } from "../core/types/deploy.ts";
import type {
  BuildSource,
  NodeSelector,
  ReplicaCount,
  ScafoWarning,
} from "../core/types/registry.ts";
import { startBudget } from "../core/utils/budget.ts";
import { createRoutedWatch } from "./_routed.ts";
import type { DaemonContext } from "./app.ts";

/** How long a flipped deploy waits to be observed serving traffic. */
export const DEFAULT_ROUTED_TIMEOUT_MS: number = 120_000;

/** Time between two looks at what the reconcile loop reports. */
export const DEFAULT_POLL_MS: number = 500;

/**
 * Deploys remembered at once. The map is soft state with no upper bound of its
 * own, so the oldest are forgotten to keep a long-lived daemon from growing.
 */
export const DEFAULT_HISTORY: number = 256;

/**
 * How far a deploy has got. Exactly three of these are final — `deployed`,
 * `routed` and `failed` — so a client polls until it reaches one of them and
 * never has to guess whether a state it sees is still moving.
 *
 * - `accepted` — the project and environment exist and the artifact is in hand.
 * - `uploading` — work is under way: the artifact is being published, and when
 *   the deploy asked to flip, brought into service afterwards.
 * - `deployed` — the build exists and can be started, but nothing on this node
 *   was seen serving it. A deploy that asked to flip and reached this carries
 *   the warning saying why.
 * - `routed` — a process serving that build has passed its readiness gate.
 * - `failed` — nothing changed about what the environment is serving.
 */
export type DeployState = "accepted" | "uploading" | "deployed" | "routed" | "failed";

/** What a caller polling a deploy is told. */
export interface DeployStatus {
  id: string;
  project: string;
  /** Build the deploy produced; absent until it has been recorded. */
  build?: string;
  state: DeployState;
  /** Why it failed, when it did. */
  detail?: string;
  warnings: ScafoWarning[];
}

/** Everything a deploy request carries besides the artifact itself. */
export interface DeployMeta {
  project: string;
  environment: string;
  /** Name the runtime files this application under within the environment's fleet. */
  script: string;
  /** Id to record the build as; defaults to the version the runtime assigned. */
  buildId?: string;
  runtimeConfigurable: boolean;
  builtWithVarset?: string;
  /** Whether the environment's alias should be pointed at the new build. */
  flip: boolean;
  /**
   * How many nodes should serve the environment. Absent says nothing about
   * placement, and an environment that already exists keeps what it has.
   */
  replicas?: ReplicaCount;
  /**
   * Which nodes may serve the environment, by the labels they carry. Absent says
   * nothing about placement, and an environment that already exists keeps the
   * selector it has.
   */
  nodeSelector?: NodeSelector;
  source?: BuildSource;
}

export interface DeployServiceOptions {
  /** Defaults to {@link DEFAULT_ROUTED_TIMEOUT_MS}. */
  routedTimeoutMs?: number;
  /** Defaults to {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** Defaults to {@link DEFAULT_HISTORY}. */
  history?: number;
  /**
   * Longest a publish waits for the environment's deployment pointer before it
   * fails. Defaults to {@link DEPLOY_LOCK_TIMEOUT_MS}.
   */
  lockTimeoutMs?: number;
}

export interface DeployService {
  /**
   * Registers a deploy and starts it. Resolves once the deploy is accepted —
   * which is as far as a caller waits — with everything after that reported
   * through {@link DeployService.get}.
   */
  start(meta: DeployMeta, artifact: Uint8Array): Promise<DeployStatus>;
  /** The deploy's status, or null when this daemon has never heard of it. */
  get(id: string): DeployStatus | null;
}

/**
 * Builds the deploy intake for this node.
 *
 * Statuses live in memory only: a daemon that restarts forgets every deploy that
 * was in flight, including ones it had already accepted. What it does not forget
 * is the registry — a build recorded before the restart is still there, and
 * still startable — so a client that loses track of a deploy re-runs it rather
 * than being left with a half-applied one.
 */
export function createDeployService(
  daemon: DaemonContext,
  runner: DeployRunner,
  opts?: DeployServiceOptions,
): DeployService {
  const routedTimeoutMs = opts?.routedTimeoutMs ?? DEFAULT_ROUTED_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const history = Math.max(1, opts?.history ?? DEFAULT_HISTORY);
  const lockTimeoutMs = opts?.lockTimeoutMs ?? DEPLOY_LOCK_TIMEOUT_MS;
  const holder = lockHolder(daemon.nodeId);

  const statuses = new Map<string, DeployStatus>();

  function update(id: string, patch: Partial<DeployStatus>): DeployStatus | null {
    const current = statuses.get(id);
    if (current === undefined) return null;

    const next: DeployStatus = { ...current, ...patch };
    statuses.set(id, next);
    return next;
  }

  function warn(id: string, warning: ScafoWarning): void {
    const current = statuses.get(id);
    if (current !== undefined) update(id, { warnings: [...current.warnings, warning] });
  }

  /**
   * Marks the environment awake, because a deploy is a wake: what a deploy has
   * just brought into service must not park for having had no request yet.
   *
   * A stamp that fails is IGNORED, and deliberately: the deploy has succeeded —
   * the build exists, and the alias points at it when it was asked to — while
   * the stamp only delays parking, and the next wake or the next deploy writes
   * it again. Failing the deploy over it would report a failure that did not
   * happen.
   */
  async function stampAwake(meta: DeployMeta): Promise<void> {
    await stampEnvironmentWake(daemon.registry, meta.project, meta.environment).catch(() => {});
  }

  /**
   * Waits for the new build to be reported serving traffic.
   *
   * WATCHED WHERE IT WAS PLACED, NOT WHERE IT WAS UPLOADED. A deploy is accepted
   * by whichever node the caller reached, and which nodes serve the environment
   * is the coordinator's decision, taken afterwards — so this asks THIS node's
   * processes first and, when the placement names other nodes, asks those
   * (`_routed.ts`). Without that, a deploy sent to any node but the one placement
   * happened to choose spent its whole budget watching a node that was never
   * going to start anything.
   *
   * Running out of time is a warning and never a failure: the build exists and
   * the alias points at it, so the loop will keep trying to start it long after
   * this deploy stopped watching.
   */
  async function awaitRouted(id: string, meta: DeployMeta, build: string): Promise<void> {
    const giveUp = async (detail: string): Promise<void> => {
      await stampAwake(meta);
      update(id, { state: "deployed" });
      warn(id, { code: "deploy-not-routed", detail });
    };

    if (daemon.reconciler === undefined) {
      await giveUp(
        `build "${build}" was deployed and the alias flipped, but this node runs no ` +
          `reconcile loop, so nothing here will start it`,
      );
      return;
    }

    const watch = createRoutedWatch(daemon, {
      project: meta.project,
      env: meta.environment,
      build,
    });

    /* A duration rather than a moment in time, so it is measured monotonically
       (`utils/budget.ts`): a wall clock stepping forward mid-wait would cut this
       short and warn that nothing was serving the build while the loop was still
       bringing it up. */
    const remaining = startBudget(routedTimeoutMs);
    for (;;) {
      if (await watch.routed()) {
        await stampAwake(meta);
        update(id, { state: "routed" });
        return;
      }
      if (remaining() <= 0) {
        await giveUp(
          `build "${build}" was deployed and the alias flipped, but no process serving it ` +
            `had passed its readiness gate after ${String(routedTimeoutMs)}ms` +
            /* Named, because a deploy that was watching another node entirely is
               the one case where "nothing was ready" is not about this node. */
            `${watchedOn(watch.asked())}`,
        );
        return;
      }
      await delay(pollMs);
    }
  }

  async function publish(id: string, meta: DeployMeta, artifact: Uint8Array): Promise<void> {
    try {
      update(id, { state: "uploading" });

      const bucket = daemon.config.bucket;
      /*
       * PUBLISHING MOVES THE FLEET'S DEPLOYMENT POINTER, so it holds the
       * environment's pointer lock for the whole shell-out — the bundling and
       * the upload included, because the pointer moves at the end of them and
       * the lock has to have been held since before whoever else wants it could
       * have started. It therefore waits behind an in-flight rollout of this
       * environment, on this node or any other, and makes those rollouts wait
       * behind it: that IS the serialization, and it is what it costs.
       *
       * The flip and the wait for the routing below are deliberately OUTSIDE
       * it. They wait on the reconcile loop, whose rollout needs this very
       * lock — holding it across them would deadlock a deploy against the loop
       * that carries it out.
       */
      const { celldVersionId } = await withLock(
        daemon.registry,
        {
          space: POINTER_LOCK_SPACE,
          name: pointerLockName(meta.project, meta.environment),
          holder,
          timeoutMs: lockTimeoutMs,
        },
        () =>
          runner.run({
            project: meta.project,
            environment: meta.environment,
            script: meta.script,
            artifact,
            target: {
              endpoint: bucket.endpoint,
              region: bucket.region,
              bucket: bucket.bucket,
              /* The same prefix a runtime process reads its fleet from, so what
                 is published is what gets served. */
              prefix: joinPrefix(bucket.prefix, fleetPrefix(meta.project, meta.environment)),
              accessKey: bucket.accessKey,
              secretKey: bucket.secretKey,
            },
          }),
      );

      const build = await createBuild(daemon.registry, meta.project, {
        id: meta.buildId ?? celldVersionId,
        celldVersionId,
        runtimeConfigurable: meta.runtimeConfigurable,
        /* Where the code just published actually lives, which is what makes this
           build's own host wakeable once a flip has superseded it. */
        environment: meta.environment,
        ...(meta.builtWithVarset === undefined ? {} : { builtWithVarset: meta.builtWithVarset }),
        ...(meta.source === undefined ? {} : { source: meta.source }),
      });
      update(id, { build: build.id });

      /* A deploy that was not asked to flip is finished: the build is recorded
         and startable, and what the environment serves is deliberately unchanged. */
      if (!meta.flip) {
        await stampAwake(meta);
        update(id, { state: "deployed" });
        return;
      }

      const flipped = await flipAlias(daemon.registry, meta.project, meta.environment, build.id);
      for (const warning of flipped.warnings) warn(id, warning);

      /* Starting, gating and routing the new build is the reconcile loop's job;
         this only watches for it to happen, and settles the state either way. */
      await awaitRouted(id, meta, build.id);
    } catch (error) {
      update(id, { state: "failed", detail: describe(error) });
    }
  }

  return {
    async start(meta, artifact): Promise<DeployStatus> {
      /* Done before the deploy is acknowledged: a project or environment name
         the registry refuses is the caller's mistake and must be answered as
         one, not buried in a status it has to poll for. */
      await createProject(daemon.registry, { slug: meta.project });
      await ensureEnvironment(daemon, meta.project, meta.environment, {
        ...(meta.replicas === undefined ? {} : { replicas: meta.replicas }),
        ...(meta.nodeSelector === undefined ? {} : { nodeSelector: meta.nodeSelector }),
      });

      const id = randomDeployId();
      const accepted: DeployStatus = {
        id,
        project: meta.project,
        state: "accepted",
        warnings: [],
      };
      statuses.set(id, accepted);
      forget(statuses, history);

      /* Snapshotted before the work starts, so the answer to the request says
         what the request achieved — accepted — rather than however far the
         background work happened to get before the response was written. */
      const answer = snapshot(accepted);

      /* Deliberately not awaited: publishing outlives the request that asked for
         it, and `publish` reports its own failures rather than raising them. */
      void publish(id, meta, artifact);

      return answer;
    },

    get(id): DeployStatus | null {
      const status = statuses.get(id);
      return status === undefined ? null : snapshot(status);
    },
  };
}

/**
 * The environment a deploy names, created when it is not there yet.
 *
 * A deploy asks for an environment to EXIST; it says nothing about how that
 * environment is configured. Creating one outright would say something:
 * `ephemeral` is part of an environment's identity and defaults to false, so a
 * deploy aimed at a preview environment that was created ephemeral would be
 * refused for disagreeing about a setting the deploy never expressed.
 *
 * Reading first and creating only what is missing is the same intent without
 * that opinion. Two deploys racing to create one environment still both end in
 * `createEnvironment`, which is idempotent for matching settings.
 *
 * The two PLACEMENT settings — `replicas` and `nodeSelector` — are the only ones
 * a deploy may state about an environment that already exists, and only when
 * they were asked for explicitly: where and how widely an application runs is an
 * operational decision, and a deploy that silently rewrote it would move that
 * application because someone re-ran a pipeline with a stale flag. Neither can
 * be CLEARED here for the same reason; that takes a command that says so.
 */
async function ensureEnvironment(
  daemon: DaemonContext,
  project: string,
  environment: string,
  wanted: { replicas?: ReplicaCount; nodeSelector?: NodeSelector },
): Promise<void> {
  let exists = true;
  try {
    await getEnvironment(daemon.registry, project, environment);
  } catch (error) {
    if (!isScafoError(error) || error.code !== "not-found") throw error;
    exists = false;
  }

  if (!exists) {
    await createEnvironment(daemon.registry, project, { name: environment, ...wanted });
    return;
  }
  if (wanted.replicas !== undefined) {
    await setReplicas(daemon.registry, project, environment, wanted.replicas);
  }
  if (wanted.nodeSelector !== undefined) {
    await setNodeSelector(daemon.registry, project, environment, wanted.nodeSelector);
  }
}

/**
 * Where the watch had got to, for a warning to say so. Empty on the ordinary
 * path — this node's own processes were the answer — and then the warning says
 * nothing extra at all.
 */
function watchedOn(nodes: readonly string[]): string {
  if (nodes.length === 0) return "";
  return `, on the node${nodes.length === 1 ? "" : "s"} its placement names (${nodes.join(", ")})`;
}

/** Drops the oldest deploys once more than `keep` are remembered. */
function forget(statuses: Map<string, DeployStatus>, keep: number): void {
  for (const id of statuses.keys()) {
    if (statuses.size <= keep) return;
    statuses.delete(id);
  }
}

function snapshot(status: DeployStatus): DeployStatus {
  return { ...status, warnings: status.warnings.map((warning) => ({ ...warning })) };
}

/** Joins the installation's key prefix to a fleet prefix. */
function joinPrefix(keyPrefix: string | undefined, fleet: string): string {
  const trimmed = keyPrefix?.replaceAll(/^\/+|\/+$/g, "") ?? "";
  return trimmed === "" ? fleet : `${trimmed}/${fleet}`;
}

/** Unguessable, so knowing an id is itself evidence of having started the deploy. */
function randomDeployId(): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(8))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
