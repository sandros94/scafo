/*
 * Deploy intake: what happens to an artifact between the request that uploads it
 * and the environment that ends up serving it.
 *
 * A deploy is accepted and answered immediately, then carried out in the
 * background — publishing an artifact takes longer than a request should wait on.
 * Progress is reported through a status object the caller polls.
 */

import { isScaloError } from "../core/error.ts";
import { createBuild } from "../core/registry/builds.ts";
import { createEnvironment, flipAlias, getEnvironment } from "../core/registry/environments.ts";
import { fleetPrefix } from "../core/registry/paths.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import { createProject } from "../core/registry/projects.ts";
import type { DeployRunner } from "../core/types/deploy.ts";
import type {
  BuildSource,
  NodeSelector,
  ReplicaCount,
  ScaloWarning,
} from "../core/types/registry.ts";
import type { AgentContext } from "./app.ts";

/** How long a flipped deploy waits to be observed serving traffic. */
export const DEFAULT_ROUTED_TIMEOUT_MS: number = 120_000;

/** Time between two looks at what the reconcile loop reports. */
export const DEFAULT_POLL_MS: number = 500;

/**
 * Deploys remembered at once. The map is soft state with no upper bound of its
 * own, so the oldest are forgotten to keep a long-lived agent from growing.
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
  warnings: ScaloWarning[];
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
}

export interface DeployService {
  /**
   * Registers a deploy and starts it. Resolves once the deploy is accepted —
   * which is as far as a caller waits — with everything after that reported
   * through {@link DeployService.get}.
   */
  start(meta: DeployMeta, artifact: Uint8Array): Promise<DeployStatus>;
  /** The deploy's status, or null when this agent has never heard of it. */
  get(id: string): DeployStatus | null;
}

/**
 * Builds the deploy intake for this node.
 *
 * Statuses live in memory only: an agent that restarts forgets every deploy that
 * was in flight, including ones it had already accepted. What it does not forget
 * is the registry — a build recorded before the restart is still there, and
 * still startable — so a client that loses track of a deploy re-runs it rather
 * than being left with a half-applied one.
 */
export function createDeployService(
  agent: AgentContext,
  runner: DeployRunner,
  opts?: DeployServiceOptions,
): DeployService {
  const routedTimeoutMs = opts?.routedTimeoutMs ?? DEFAULT_ROUTED_TIMEOUT_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const history = Math.max(1, opts?.history ?? DEFAULT_HISTORY);

  const statuses = new Map<string, DeployStatus>();

  function update(id: string, patch: Partial<DeployStatus>): DeployStatus | null {
    const current = statuses.get(id);
    if (current === undefined) return null;

    const next: DeployStatus = { ...current, ...patch };
    statuses.set(id, next);
    return next;
  }

  function warn(id: string, warning: ScaloWarning): void {
    const current = statuses.get(id);
    if (current !== undefined) update(id, { warnings: [...current.warnings, warning] });
  }

  /** Whether the reconcile loop reports a ready process for this build. */
  function isRouted(meta: DeployMeta, build: string): boolean {
    return (agent.reconciler?.status().processes ?? []).some(
      (process) =>
        process.ready &&
        process.project === meta.project &&
        process.env === meta.environment &&
        process.build === build,
    );
  }

  /**
   * Waits for the reconcile loop to report the new build serving traffic.
   *
   * Running out of time is a warning and never a failure: the build exists and
   * the alias points at it, so the loop will keep trying to start it long after
   * this deploy stopped watching.
   */
  async function awaitRouted(id: string, meta: DeployMeta, build: string): Promise<void> {
    const giveUp = (detail: string): void => {
      update(id, { state: "deployed" });
      warn(id, { code: "deploy-not-routed", detail });
    };

    if (agent.reconciler === undefined) {
      giveUp(
        `build "${build}" was deployed and the alias flipped, but this node runs no ` +
          `reconcile loop, so nothing here will start it`,
      );
      return;
    }

    const deadline = Date.now() + routedTimeoutMs;
    for (;;) {
      if (isRouted(meta, build)) {
        update(id, { state: "routed" });
        return;
      }
      if (Date.now() >= deadline) {
        giveUp(
          `build "${build}" was deployed and the alias flipped, but no process serving it ` +
            `had passed its readiness gate after ${String(routedTimeoutMs)}ms`,
        );
        return;
      }
      await delay(pollMs);
    }
  }

  async function publish(id: string, meta: DeployMeta, artifact: Uint8Array): Promise<void> {
    try {
      update(id, { state: "uploading" });

      const bucket = agent.config.bucket;
      const { celldVersionId } = await runner.run({
        project: meta.project,
        environment: meta.environment,
        script: meta.script,
        artifact,
        target: {
          endpoint: bucket.endpoint,
          region: bucket.region,
          bucket: bucket.bucket,
          /* The same prefix a runtime process reads its fleet from, so what is
             published is what gets served. */
          prefix: joinPrefix(bucket.prefix, fleetPrefix(meta.project, meta.environment)),
          accessKey: bucket.accessKey,
          secretKey: bucket.secretKey,
        },
      });

      const build = await createBuild(agent.registry, meta.project, {
        id: meta.buildId ?? celldVersionId,
        celldVersionId,
        runtimeConfigurable: meta.runtimeConfigurable,
        ...(meta.builtWithVarset === undefined ? {} : { builtWithVarset: meta.builtWithVarset }),
        ...(meta.source === undefined ? {} : { source: meta.source }),
      });
      update(id, { build: build.id });

      /* A deploy that was not asked to flip is finished: the build is recorded
         and startable, and what the environment serves is deliberately unchanged. */
      if (!meta.flip) {
        update(id, { state: "deployed" });
        return;
      }

      const flipped = await flipAlias(agent.registry, meta.project, meta.environment, build.id);
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
      await createProject(agent.registry, { slug: meta.project });
      await ensureEnvironment(agent, meta.project, meta.environment, {
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
  agent: AgentContext,
  project: string,
  environment: string,
  wanted: { replicas?: ReplicaCount; nodeSelector?: NodeSelector },
): Promise<void> {
  let exists = true;
  try {
    await getEnvironment(agent.registry, project, environment);
  } catch (error) {
    if (!isScaloError(error) || error.code !== "not-found") throw error;
    exists = false;
  }

  if (!exists) {
    await createEnvironment(agent.registry, project, { name: environment, ...wanted });
    return;
  }
  if (wanted.replicas !== undefined) {
    await setReplicas(agent.registry, project, environment, wanted.replicas);
  }
  if (wanted.nodeSelector !== undefined) {
    await setNodeSelector(agent.registry, project, environment, wanted.nodeSelector);
  }
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

/** The specifics a scalo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScaloError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
