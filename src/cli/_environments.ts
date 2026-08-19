/*
 * Internal: what `scalo env retire|unretire|delete` does, and the two ways it
 * can reach the installation.
 *
 * Through a NODE (`--agent`) is the ordinary one: the node is already running,
 * already holds the coordinator lease or knows who does, and the operator needs
 * nothing but their own key. Through the BUCKET is the fallback for the
 * installation that has no node to ask — the same shape `scalo trust` and
 * `scalo varset` are written in, because a registry is often edited before or
 * after there is an agent to edit it through.
 */

import { ScaloError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { acquireLease, type LeaseHandle, releaseLease } from "../core/registry/lease.ts";
import { deleteEnvironment } from "../core/registry/reaper.ts";
import { retireEnvironment, unretireEnvironment } from "../core/registry/retirement.ts";
import type { EnvironmentRecord } from "../core/types/registry.ts";
import { assertSlug } from "../core/utils/slug.ts";
import { type AgentCallOptions, agentRequest, type Authorize } from "./_agent.ts";

/** Node id the CLI takes the coordinator lease under; see {@link directOps}. */
export const CLI_NODE_ID: string = "scalo-cli";

/** The environment a subcommand was pointed at. */
export interface EnvironmentTarget {
  project: string;
  env: string;
}

export interface DeleteOptions {
  /** Skips both the ephemeral and the retirement-grace requirement. */
  force?: boolean;
}

/** What the three subcommands do, whichever way they reach the installation. */
export interface EnvironmentOps {
  /** How the operator is acting, as the command's own output names it. */
  readonly via: string;
  retire(target: EnvironmentTarget): Promise<EnvironmentRecord>;
  unretire(target: EnvironmentTarget): Promise<EnvironmentRecord>;
  /** Answers the store keys that were removed. */
  delete(target: EnvironmentTarget, opts?: DeleteOptions): Promise<string[]>;
}

export interface AgentOptions {
  /** Base URL of the node agent, without a trailing separator. */
  url: string;
  /** Mints one fresh token per call; node tokens are single-use. */
  authorize: Authorize;
  /** How the calls are made; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * The three commands as calls to a node's agent API.
 *
 * The node answers for the whole installation: retirement is a plain record
 * update any node carries out, and a deletion is forwarded to whichever node
 * holds the coordinator lease. Its problem document is passed through unchanged,
 * so a refusal reaches the operator with the grace it named still in it.
 */
export function agentOps(opts: AgentOptions): EnvironmentOps {
  const at = (target: EnvironmentTarget, suffix: string = ""): string => {
    /* Validated rather than escaped: these are slugs, so a name that passes is a
       name that carries no separator, no query and no traversal to encode. One
       that does not pass is a mistake worth naming here, before a node answers
       404 to a path the operator cannot see anything wrong with. */
    assertSlug(target.project);
    assertSlug(target.env);
    return `${opts.url}/v1/environments/${target.project}/${target.env}${suffix}`;
  };

  const call = (method: string): AgentCallOptions => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  const retirement = async (
    target: EnvironmentTarget,
    suffix: string,
  ): Promise<EnvironmentRecord> => {
    const answer = await agentRequest(at(target, suffix), await opts.authorize(), call("POST"));
    return ((await answer.json()) as { environment: EnvironmentRecord }).environment;
  };

  return {
    via: opts.url,
    retire: (target) => retirement(target, "/retire"),
    unretire: (target) => retirement(target, "/unretire"),

    async delete(target, deleteOpts): Promise<string[]> {
      const query = deleteOpts?.force === true ? "?force=1" : "";
      const answer = await agentRequest(at(target, query), await opts.authorize(), call("DELETE"));
      return ((await answer.json()) as { deleted: string[] }).deleted;
    },
  };
}

export interface DirectOptions {
  /** Id the CLI takes the lease under. Defaults to {@link CLI_NODE_ID}. */
  nodeId?: string;
}

/**
 * The three commands as writes straight into the bucket.
 *
 * Retiring and unretiring are single conditional updates and need nothing else.
 * Deleting does: it is lease-gated — S3 has no conditional delete, so the lease
 * is the only thing keeping two deleters apart — which means the CLI has to
 * become the coordinator for the length of the deletion.
 *
 * THAT IS NOT FREE, and it is why `--agent` is the better route whenever there
 * is a node to ask. Taking the lease raises its fence, and the node that held it
 * discovers on its next renewal that it no longer does: it drops to candidate
 * and stops assigning and reaping until it takes the lease back, which is a tick
 * or two later. Nothing is lost and nothing races — the fence is exactly what
 * makes that safe — but an installation briefly has no coordinator because
 * somebody deleted an environment from their laptop. The lease is released as
 * soon as the deletion is over, successful or not, so the fleet takes it back at
 * once instead of waiting out the TTL.
 *
 * Throws `ScaloError("lease-lost")` when the lease could not be taken at all,
 * which means a live coordinator is holding it and the request belongs there.
 */
export function directOps(registry: RegistryContext, opts?: DirectOptions): EnvironmentOps {
  const nodeId = opts?.nodeId ?? CLI_NODE_ID;

  return {
    via: "the registry bucket",
    retire: (target) => retireEnvironment(registry, target.project, target.env),
    unretire: (target) => unretireEnvironment(registry, target.project, target.env),

    async delete(target, deleteOpts): Promise<string[]> {
      const lease = await takeLease(registry, nodeId, target);
      try {
        const { deleted } = await deleteEnvironment(
          registry,
          target.project,
          target.env,
          lease,
          deleteOpts ?? {},
        );
        return deleted;
      } finally {
        /* Best effort: the TTL expires it anyway, and a release that failed must
           not turn a completed deletion into a reported failure. */
        await releaseLease(registry, lease).catch(() => {});
      }
    },
  };
}

/** How a retirement reads on the terminal, grace included so the next step is obvious. */
export function describeRetirement(
  target: EnvironmentTarget,
  environment: EnvironmentRecord,
): string {
  const name = `"${target.project}/${target.env}"`;
  if (environment.retiredAt === undefined) return `scalo: ${name} is not retired`;

  return (
    `scalo: ${name} is retired as of ${environment.retiredAt}; every node stops serving it on ` +
    `its next pass, "scalo env unretire" puts it straight back, and it can be deleted once ` +
    `its grace has run out`
  );
}

async function takeLease(
  registry: RegistryContext,
  nodeId: string,
  target: EnvironmentTarget,
): Promise<LeaseHandle> {
  const lease = await acquireLease(registry, nodeId);
  if (lease !== null) return lease;

  throw new ScaloError("lease-lost", "A node is coordinating this installation", {
    detail:
      `"${target.project}/${target.env}" cannot be deleted straight through the bucket while a ` +
      `node holds the coordinator lease: ask that installation instead, with --agent <url> ` +
      `--key <file>, and the request reaches the coordinator wherever it is`,
  });
}
