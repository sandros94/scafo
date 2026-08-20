/*
 * Internal: what `scafo env retire|unretire|delete` does, and the two ways it
 * can reach the installation.
 *
 * Through a NODE (`--agent`) is the ordinary one: the node is already running,
 * already holds the coordinator lease or knows who does, and the operator needs
 * nothing but their own key. Through the BUCKET is the fallback for the
 * installation that has no node to ask — the same shape `scafo trust` and
 * `scafo varset` are written in, because a registry is often edited before or
 * after there is an agent to edit it through.
 */

import { ScafoError } from "../core/error.ts";
import { describeSelector } from "../core/placement/selector.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { type CanaryInput, canarySplit, setSplit } from "../core/registry/environments.ts";
import { acquireLease, type LeaseHandle, releaseLease } from "../core/registry/lease.ts";
import {
  type ResolvedParkPolicy,
  resolveParkPolicy,
  setParkPolicy,
} from "../core/registry/park.ts";
import { setNodeSelector } from "../core/registry/placement.ts";
import { deleteEnvironment } from "../core/registry/reaper.ts";
import { retireEnvironment, unretireEnvironment } from "../core/registry/retirement.ts";
import type {
  EnvironmentRecord,
  NodeSelector,
  ParkPolicy,
  SplitEntry,
} from "../core/types/registry.ts";
import { parseLabels } from "../core/utils/labels.ts";
import { assertSlug } from "../core/utils/slug.ts";
import { type AgentCallOptions, agentRequest, type Authorize } from "./_agent.ts";

/** Node id the CLI takes the coordinator lease under; see {@link directOps}. */
export const CLI_NODE_ID: string = "scafo-cli";

/** The environment a subcommand was pointed at. */
export interface EnvironmentTarget {
  project: string;
  env: string;
}

export interface DeleteOptions {
  /** Skips both the ephemeral and the retirement-grace requirement. */
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
  /** States how the environment scales to zero; null falls back to what its kind implies. */
  setPark(target: EnvironmentTarget, policy: ParkPolicy | null): Promise<EnvironmentRecord>;
  /** Weights the environment's traffic over several builds; null clears the split. */
  setSplit(target: EnvironmentTarget, split: SplitEntry[] | null): Promise<EnvironmentRecord>;
  /** Weighs one build against whatever the alias currently points at. */
  canary(target: EnvironmentTarget, canary: CanaryInput): Promise<EnvironmentRecord>;
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

  const stateSplit = async (
    target: EnvironmentTarget,
    body: { split: SplitEntry[] | null } | { canary: CanaryInput },
  ): Promise<EnvironmentRecord> => {
    const answer = await agentRequest(at(target, "/split"), await opts.authorize(), {
      ...call("POST"),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return ((await answer.json()) as { environment: EnvironmentRecord }).environment;
  };

  return {
    via: opts.url,
    retire: (target) => retirement(target, "/retire"),
    unretire: (target) => retirement(target, "/unretire"),

    async setSelector(target, selector): Promise<EnvironmentRecord> {
      const answer = await agentRequest(at(target, "/selector"), await opts.authorize(), {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        /* `null` is spelled out rather than omitted: the node refuses a body
           that says nothing, because clearing a constraint must be stated. */
        body: JSON.stringify({ selector }),
      });
      return ((await answer.json()) as { environment: EnvironmentRecord }).environment;
    },

    async setPark(target, policy): Promise<EnvironmentRecord> {
      const answer = await agentRequest(at(target, "/park"), await opts.authorize(), {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        /* Spelled out for the same reason the selector is: the node refuses a
           body that says nothing, because clearing a policy must be stated. */
        body: JSON.stringify({ policy }),
      });
      return ((await answer.json()) as { environment: EnvironmentRecord }).environment;
    },

    /* Same shape, same reason: clearing a split has to be said, never implied. */
    setSplit: (target, split) => stateSplit(target, { split }),
    canary: (target, canary) => stateSplit(target, { canary }),

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
    setPark: (target, policy) => setParkPolicy(registry, target.project, target.env, policy),
    setSplit: (target, split) => setSplit(registry, target.project, target.env, split),
    canary: (target, canary) => canarySplit(registry, target.project, target.env, canary),

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

/** The two ways `scafo env split` can be told what to do. */
export interface SplitFlags {
  /** Legs written `build=weight,build2=weight2`, or undefined when `--set` was not given. */
  set: string | undefined;
  /** Whether `--clear` was given. */
  clear: boolean;
}

/**
 * The split an invocation states: the legs of `--set`, or null for `--clear`.
 *
 * Exactly one of them, on the same reading as {@link readSelectorFlags}: BOTH
 * says nothing about which was meant, and NEITHER is refused rather than read as
 * "clear", because an accidental `scafo env split` that collapsed a canary onto
 * the alias would move an application's whole traffic without anyone asking.
 *
 * Only the SHAPE is checked here — `build=weight` pairs over whole numbers. What
 * the weights must add up to, how many legs a split needs and whether the builds
 * exist are the registry's, so the refusal an operator reads is the same one
 * they would get writing to the bucket themselves.
 *
 * ORDER IS KEPT as it was written: the legs reach the planner and the ingress in
 * this order, and two nodes rendering the same split must weight it identically.
 */
export function readSplitFlags(flags: SplitFlags): SplitEntry[] | null {
  if (flags.set !== undefined && flags.clear) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail: `--set "${flags.set}" and --clear ask for opposite things; pass one of them`,
    });
  }
  if (flags.clear) return null;
  if (flags.set !== undefined) return parseSplit(flags.set, "--set");

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail:
      `pass --set "build=weight,build2=weight2" to weight this environment's traffic over ` +
      `its builds, or --clear to serve the alias build alone again`,
  });
}

/** How a split change reads on the terminal, naming what happens next. */
export function describeSplitChange(
  target: EnvironmentTarget,
  environment: EnvironmentRecord,
): string {
  const name = `"${target.project}/${target.env}"`;
  const split = environment.split;

  if (split === null || split.length === 0) {
    const build = environment.alias?.build;
    const serving = build === undefined ? "nothing yet" : `build "${build}"`;
    return (
      `scafo: ${name} splits its traffic no more; it serves ${serving} alone, and the nodes ` +
      `serving it stop every other leg on their next pass`
    );
  }
  return (
    `scafo: ${name} splits its traffic ${describeSplit(split)}; the nodes serving it start ` +
    `every leg on their next pass, and each takes its share once it has passed its readiness ` +
    `gate — until then its share goes to the legs that are ready`
  );
}

/** A split as an operator wrote it: `"a" 90%, "b" 10%`. */
export function describeSplit(split: SplitEntry[]): string {
  return split.map((leg) => `"${leg.build}" ${String(leg.weight)}%`).join(", ");
}

/** The ways `scafo env park` can be told what an environment's scaling to zero is. */
export interface ParkFlags {
  /** Seconds without a wake before it parks, or undefined when `--after` was not given. */
  after: string | undefined;
  /** Seconds a woken superseded build keeps running, `--build-idle`. */
  buildIdle: string | undefined;
  /** Seconds a request held for a wake may wait, `--wake-deadline`. */
  wakeDeadline: string | undefined;
  /** Whether superseded builds may be woken at all, `--recall-builds`, `true` or `false`. */
  recallBuilds: string | undefined;
  /** Whether `--clear` was given. */
  clear: boolean;
}

/**
 * The park policy an invocation states: the fields it named, or null for
 * `--clear`.
 *
 * ONLY THE FIELDS THAT WERE GIVEN reach the record. A policy states an
 * operator's decisions and nothing else — every blank falls back to what the
 * environment's kind implies, and writing a resolved default into the record
 * would freeze today's default into an environment that never asked for it.
 *
 * `--clear` and a field are refused together, on the same reading as
 * {@link readSelectorFlags}: they are opposite intentions, so a command carrying
 * both says nothing about which was meant. NEITHER is refused too, rather than
 * read as "clear", because an accidental `scafo env park` that lifted a policy
 * would put a whole preview fleet back to running around the clock.
 */
export function readParkFlags(flags: ParkFlags): ParkPolicy | null {
  const stated: Array<[string, string | undefined]> = [
    ["--after", flags.after],
    ["--build-idle", flags.buildIdle],
    ["--wake-deadline", flags.wakeDeadline],
    ["--recall-builds", flags.recallBuilds],
  ];
  const given = stated.filter(([, value]) => value !== undefined).map(([name]) => name);

  if (flags.clear && given.length > 0) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail: `${given.join(", ")} and --clear ask for opposite things; pass one of them`,
    });
  }
  if (flags.clear) return null;
  if (given.length === 0) {
    throw new ScafoError("invalid-input", "Missing required argument", {
      detail:
        `pass --after <seconds>, --build-idle <seconds>, --wake-deadline <seconds> or ` +
        `--recall-builds <true|false> to state how this environment scales to zero, or ` +
        `--clear to fall back to what its kind implies`,
    });
  }

  const policy: ParkPolicy = {};
  if (flags.after !== undefined) policy.afterS = seconds(flags.after, "--after");
  if (flags.recallBuilds !== undefined) {
    policy.recallBuilds = truth(flags.recallBuilds, "--recall-builds");
  }
  if (flags.buildIdle !== undefined) policy.buildIdleS = seconds(flags.buildIdle, "--build-idle");
  if (flags.wakeDeadline !== undefined) {
    policy.wakeDeadlineS = seconds(flags.wakeDeadline, "--wake-deadline");
  }
  return policy;
}

/**
 * How a park change reads on the terminal: the RESOLVED policy rather than the
 * fields that were written, because the two differ in the case that surprises
 * people most — a long-lived environment never parks on a clock, whatever the
 * record says, and an operator who has just set `--build-idle` on one should see
 * that as well as what they changed.
 */
export function describeParkChange(
  target: EnvironmentTarget,
  environment: EnvironmentRecord,
): string {
  const name = `"${target.project}/${target.env}"`;
  const described = describePark(resolveParkPolicy(environment));

  if (environment.park === undefined) {
    return `scafo: ${name} carries no park policy of its own; as its kind implies, it ${described}`;
  }
  return `scafo: ${name} ${described}`;
}

/** A resolved policy in words, in the order an environment goes through it. */
function describePark(policy: ResolvedParkPolicy): string {
  const parks =
    policy.afterS === 0
      ? "never parks on a clock"
      : `parks ${String(policy.afterS)}s after its last wake`;
  const recall = policy.recallBuilds
    ? `a superseded build runs again while its own host keeps being asked for, ` +
      `until ${String(policy.buildIdleS)}s past its last wake`
    : "superseded builds stay stopped";

  return (
    `${parks}; ${recall}; a request waiting on a wake is held for up to ` +
    `${String(policy.wakeDeadlineS)}s`
  );
}

/** `build=weight,build2=weight2`, in the order it was written. */
function parseSplit(stated: string, flag: string): SplitEntry[] {
  const malformed = (detail: string): ScafoError =>
    new ScafoError("invalid-input", "Malformed traffic split", { detail });

  const entries: SplitEntry[] = [];
  for (const part of stated.split(",")) {
    const pair = part.trim();
    if (pair === "") continue;

    const at = pair.indexOf("=");
    if (at < 1) {
      throw malformed(`${flag} "${stated}" must be written "build=weight,build2=weight2"`);
    }

    const weight = pair.slice(at + 1).trim();
    if (!/^\d+$/.test(weight)) {
      throw malformed(
        `${flag} gives build "${pair.slice(0, at).trim()}" the weight "${weight}", which is ` +
          `not a whole number of percent`,
      );
    }
    entries.push({ build: pair.slice(0, at).trim(), weight: Number(weight) });
  }

  if (entries.length === 0) throw malformed(`${flag} "${stated}" names no builds at all`);
  return entries;
}

/** A whole number of seconds, zero included; anything else is the operator's mistake. */
function seconds(stated: string, flag: string): number {
  if (!/^\d+$/.test(stated)) {
    throw new ScafoError("invalid-input", "Malformed park policy", {
      detail: `${flag} "${stated}" must be a whole number of seconds, zero or more`,
    });
  }
  return Number(stated);
}

/** `true` or `false` and nothing else: a flag that guesses is a flag that misreads. */
function truth(stated: string, flag: string): boolean {
  if (stated !== "true" && stated !== "false") {
    throw new ScafoError("invalid-input", "Malformed park policy", {
      detail: `${flag} "${stated}" must be written "true" or "false"`,
    });
  }
  return stated === "true";
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
      `node holds the coordinator lease: ask that installation instead, with --agent <url> ` +
      `--key <file>, and the request reaches the coordinator wherever it is`,
  });
}
