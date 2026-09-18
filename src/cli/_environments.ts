/* Environment administration through a node, with bucket fallback when no node
   is available. */

import { ScafoError } from "../core/error.ts";
import { describeSelector } from "../core/placement/selector.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { acquireLease, type LeaseHandle, releaseLease } from "../core/registry/lease.ts";
import { setNodeSelector } from "../core/registry/placement.ts";
import { deleteEnvironment } from "../core/registry/reaper.ts";
import { retireEnvironment, unretireEnvironment } from "../core/registry/retirement.ts";
import type { EnvironmentRecord, NodeSelector } from "../core/types/registry.ts";
import { parseLabels } from "../core/utils/labels.ts";
import { assertSlug } from "../core/utils/slug.ts";
import { type NodeCallOptions, type NodeOptions, nodeRequest } from "./_node.ts";

/** Node id the CLI takes the coordinator lease under; see {@link directOps}. */
export const CLI_NODE_ID: string = "scafo-cli";

/** The environment a subcommand was pointed at. */
export interface EnvironmentTarget {
  project: string;
  env: string;
}

export interface DeleteOptions {
  /** Skips the retirement-grace requirement. */
  force?: boolean;
}

/** What the subcommands do, whichever way they reach the installation. */
export interface EnvironmentOps {
  /** How the operator is acting, as the command's own output names it. */
  readonly via: string;
  retire(target: EnvironmentTarget): Promise<EnvironmentRecord>;
  unretire(target: EnvironmentTarget): Promise<EnvironmentRecord>;
  /** Constrains which nodes may serve the environment; null lifts the constraint. */
  setSelector(target: EnvironmentTarget, selector: NodeSelector | null): Promise<EnvironmentRecord>;
  /** Answers the store keys that were removed. */
  delete(target: EnvironmentTarget, opts?: DeleteOptions): Promise<string[]>;
}

export type { NodeOptions };

/**
 * The environment commands as calls to a node's API.
 *
 * The node answers for the whole installation: retirement is a plain record
 * update any node carries out, and a deletion is forwarded to whichever node
 * holds the coordinator lease. Its problem document is passed through unchanged,
 * so a refusal reaches the operator with the grace it named still in it.
 */
export function nodeOps(opts: NodeOptions): EnvironmentOps {
  const at = (target: EnvironmentTarget, suffix: string = ""): string => {
    /* Validated rather than escaped: these are slugs, so a name that passes is a
       name that carries no separator, no query and no traversal to encode. One
       that does not pass is a mistake worth naming here, before a node answers
       404 to a path the operator cannot see anything wrong with. */
    assertSlug(target.project);
    assertSlug(target.env);
    return `${opts.url}/v1/environments/${target.project}/${target.env}${suffix}`;
  };

  const call = (method: string): NodeCallOptions => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  const retirement = async (
    target: EnvironmentTarget,
    suffix: string,
  ): Promise<EnvironmentRecord> => {
    const answer = await nodeRequest(at(target, suffix), await opts.authorize(), call("POST"));
    return ((await answer.json()) as { environment: EnvironmentRecord }).environment;
  };

  return {
    via: opts.url,
    retire: (target) => retirement(target, "/retire"),
    unretire: (target) => retirement(target, "/unretire"),

    async setSelector(target, selector): Promise<EnvironmentRecord> {
      const answer = await nodeRequest(at(target, "/selector"), await opts.authorize(), {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        /* `null` is spelled out rather than omitted: the node refuses a body
           that says nothing, because clearing a constraint must be stated. */
        body: JSON.stringify({ selector }),
      });
      return ((await answer.json()) as { environment: EnvironmentRecord }).environment;
    },

    async delete(target, deleteOpts): Promise<string[]> {
      const query = deleteOpts?.force === true ? "?force=1" : "";
      const answer = await nodeRequest(at(target, query), await opts.authorize(), call("DELETE"));
      return ((await answer.json()) as { deleted: string[] }).deleted;
    },
  };
}

export interface DirectOptions {
  /** Id the CLI takes the lease under. Defaults to {@link CLI_NODE_ID}. */
  nodeId?: string;
}

/**
 * The environment commands as writes straight into the bucket.
 *
 * Retiring and unretiring are single conditional updates and need nothing else.
 * Deleting does: it is lease-gated — S3 has no conditional delete, so the lease
 * is the only thing keeping two deleters apart — which means the CLI has to
 * become the coordinator for the length of the deletion.
 *
 * THAT IS NOT FREE, and it is why `--node` is the better route whenever there
 * is a node to ask. Taking the lease raises its fence, and the node that held it
 * discovers on its next renewal that it no longer does: it drops to candidate
 * and stops assigning and reaping until it takes the lease back, which is a tick
 * or two later. Nothing is lost and nothing races — the fence is exactly what
 * makes that safe — but an installation briefly has no coordinator because
 * somebody deleted an environment from their laptop. The lease is released as
 * soon as the deletion is over, successful or not, so the fleet takes it back at
 * once instead of waiting out the TTL.
 *
 * Throws `ScafoError("lease-lost")` when the lease could not be taken at all,
 * which means a live coordinator is holding it and the request belongs there.
 */
export function directOps(registry: RegistryContext, opts?: DirectOptions): EnvironmentOps {
  const nodeId = opts?.nodeId ?? CLI_NODE_ID;

  return {
    via: "the registry bucket",
    retire: (target) => retireEnvironment(registry, target.project, target.env),
    unretire: (target) => unretireEnvironment(registry, target.project, target.env),
    setSelector: (target, selector) =>
      setNodeSelector(registry, target.project, target.env, selector),
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
  if (environment.retiredAt === undefined) return `scafo: ${name} is not retired`;

  return (
    `scafo: ${name} is retired as of ${environment.retiredAt}; every node stops serving it on ` +
    `its next pass, "scafo env unretire" puts it straight back, and it can be deleted once ` +
    `its grace has run out`
  );
}

/** The two ways `scafo env selector` can be told what to do. */
export interface SelectorFlags {
  /** Labels written `k=v,k2=v2`, or undefined when `--set` was not given. */
  set: string | undefined;
  /** Whether `--clear` was given. */
  clear: boolean;
}

/**
 * The selector an invocation states: the labels of `--set`, or null for
 * `--clear`.
 *
 * Exactly one of them, and `ScafoError("invalid-input")` otherwise. They are
 * opposite intentions, so a command carrying BOTH says nothing about which was
 * meant; and NEITHER is refused rather than read as "clear", because an
 * accidental `scafo env selector` that lifted a constraint would move an
 * application across a fleet without anyone asking it to.
 */
export function readSelectorFlags(flags: SelectorFlags): NodeSelector | null {
  if (flags.set !== undefined && flags.clear) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail: `--set "${flags.set}" and --clear ask for opposite things; pass one of them`,
    });
  }
  if (flags.clear) return null;
  if (flags.set !== undefined) return parseLabels(flags.set, "--set");

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail:
      `pass --set "key=value,key2=value2" to choose which nodes may serve it, ` +
      `or --clear to let it run on every node again`,
  });
}

/**
 * How a selector change reads on the terminal, naming what happens next: the
 * decision is the coordinator's, and it is taken on its next assignment pass
 * rather than by the command that stated the intent.
 */
export function describeSelectorChange(
  target: EnvironmentTarget,
  environment: EnvironmentRecord,
): string {
  const name = `"${target.project}/${target.env}"`;
  const selector = environment.nodeSelector;

  if (selector === undefined) {
    return (
      `scafo: ${name} selects no nodes any more; the coordinator places it over the whole ` +
      `fleet again on its next assignment pass`
    );
  }
  return (
    `scafo: ${name} runs only on nodes labelled ${describeSelector(selector)}; the coordinator ` +
    `places it on the next assignment pass, and reports the environment as unplaced — leaving ` +
    `whatever serves it now running — if no live node carries them`
  );
}

async function takeLease(
  registry: RegistryContext,
  nodeId: string,
  target: EnvironmentTarget,
): Promise<LeaseHandle> {
  const lease = await acquireLease(registry, nodeId);
  if (lease !== null) return lease;

  throw new ScafoError("lease-lost", "A node is coordinating this installation", {
    detail:
      `"${target.project}/${target.env}" cannot be deleted straight through the bucket while a ` +
      `node holds the coordinator lease: ask that installation instead, with --node <url> ` +
      `--key <file>, and the request reaches the coordinator wherever it is`,
  });
}
