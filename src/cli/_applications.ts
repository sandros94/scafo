/*
 * Application administration, and how it reads on a terminal.
 *
 * Two surfaces, because they answer to different authorities. {@link nodeOps}
 * and {@link directOps} carry out what an application's own operator does —
 * retire, restore, place, delete — over a node or straight into the bucket.
 * {@link applicationApi} is the node-only half: listing, and the statements an
 * ADMIN makes about an application. A bucket fallback there would bypass the
 * operator-tier authorization those calls exist for.
 */

import { ScafoError } from "../core/error.ts";
import { assertClaimableHost } from "../core/placement/hosts.ts";
import { hostUnder } from "../core/placement/routes.ts";
import type { ApplicationServing } from "../core/placement/serving.ts";
import { describeSelector } from "../core/placement/selector.ts";
import { getApplication } from "../core/registry/applications.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import {
  type ClaimDomainOptions,
  claimDomain,
  releaseApplicationDomain,
} from "../core/registry/domains.ts";
import { acquireLease, type LeaseHandle, releaseLease } from "../core/registry/lease.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import { deleteApplication } from "../core/registry/reaper.ts";
import { retireApplication, unretireApplication } from "../core/registry/retirement.ts";
import type { ApplicationRecord, NodeSelector, ReplicaCount } from "../core/types/registry.ts";
import { normalizeCustomDomain } from "../core/utils/host.ts";
import { parseLabelEntries } from "../core/utils/labels.ts";
import { assertSlug } from "../core/utils/slug.ts";
import { type NodeCallOptions, type NodeOptions, nodeRequest } from "./_node.ts";

/** Node id the CLI takes the coordinator lease under; see {@link directOps}. */
export const CLI_NODE_ID: string = "scafo-cli";

export interface DeleteOptions {
  /** Skips the retirement-grace requirement. */
  force?: boolean;
}

/** What a claim or a release answers with, whichever way it was made. */
export interface DomainChange {
  /** The application as it now stands, its domains included. */
  application: ApplicationRecord;
  /** The host as the registry holds it: lowercased. */
  host: string;
  /** Where the application answers under the installation's platform domains. */
  platformHosts: string[];
  /**
   * The host this installation's ingress answers DNS-01 at, when it names one:
   * where `_acme-challenge.<host>` is pointed so a wildcard certificate for the
   * claim can be issued. Absent where the installation names none.
   */
  acmeDelegation?: string;
}

/** What the per-application subcommands do, whichever way they reach the installation. */
export interface ApplicationOps {
  /** How the operator is acting, as the command's own output names it. */
  readonly via: string;
  retire(name: string): Promise<ApplicationRecord>;
  unretire(name: string): Promise<ApplicationRecord>;
  /** Constrains which nodes may serve it; null lifts the constraint. */
  setSelector(name: string, selector: NodeSelector | null): Promise<ApplicationRecord>;
  /** How many nodes should serve it. */
  setReplicas(name: string, replicas: ReplicaCount): Promise<ApplicationRecord>;
  /** Claims a custom host for it, installation-wide and first claim wins. */
  addDomain(name: string, host: string, opts?: ClaimDomainOptions): Promise<DomainChange>;
  /** Drops a host this application holds; another application's is `not-found`. */
  removeDomain(name: string, host: string): Promise<DomainChange>;
  /** The application as it stands, which is where the hosts it holds are listed. */
  show(name: string): Promise<ApplicationRecord>;
  /** Answers the store keys that were removed. */
  delete(name: string, opts?: DeleteOptions): Promise<string[]>;
}

export type { NodeOptions };

/**
 * The per-application commands as calls to a node's API.
 *
 * The node answers for the whole installation: retirement is a plain record
 * update any node carries out, and a deletion is forwarded to whichever node
 * holds the coordinator lease. Its problem document is passed through unchanged,
 * so a refusal reaches the operator with the grace it named still in it.
 */
export function nodeOps(opts: NodeOptions): ApplicationOps {
  const at = (name: string, suffix: string = ""): string => {
    /* Validated rather than escaped: this is a name, so one that passes carries
       no separator, no query and no traversal to encode. One that does not pass
       is a mistake worth naming here, before a node answers 404 to a path the
       operator cannot see anything wrong with. */
    assertSlug(name);
    return `${opts.url}${APPLICATIONS_PATH}/${name}${suffix}`;
  };

  const call = (method: string): NodeCallOptions => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  const post = async (name: string, suffix: string, body?: unknown): Promise<ApplicationRecord> => {
    const answer = await nodeRequest(at(name, suffix), await opts.authorize(), {
      ...call("POST"),
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return ((await answer.json()) as { application: ApplicationRecord }).application;
  };

  /* The host is checked here rather than sent as typed: it is a path segment,
     and one that is no host reaches a node as a request it can only answer 404
     to — a refusal the operator cannot see anything wrong with. */
  const domain = async (
    name: string,
    host: string,
    method: string,
    query: string = "",
  ): Promise<DomainChange> => {
    const claimed = normalizeCustomDomain(host);
    const answer = await nodeRequest(
      at(name, `/domains/${claimed}${query}`),
      await opts.authorize(),
      call(method),
    );
    return (await answer.json()) as DomainChange;
  };

  return {
    via: opts.url,
    retire: (name) => post(name, "/retire"),
    unretire: (name) => post(name, "/unretire"),
    /* `null` is spelled out rather than omitted: the node refuses a body that
       says nothing, because clearing a constraint must be stated. */
    setSelector: (name, selector) => post(name, "/selector", { selector }),
    setReplicas: (name, replicas) => post(name, "/replicas", { replicas }),
    addDomain: (name, host, claim) =>
      domain(name, host, "POST", claim?.wildcard === true ? "?wildcard=1" : ""),
    removeDomain: (name, host) => domain(name, host, "DELETE"),

    async show(name): Promise<ApplicationRecord> {
      const answer = await nodeRequest(at(name), await opts.authorize(), call("GET"));
      return ((await answer.json()) as { application: ApplicationRecord }).application;
    },

    async delete(name, deleteOpts): Promise<string[]> {
      const query = deleteOpts?.force === true ? "?force=1" : "";
      const answer = await nodeRequest(at(name, query), await opts.authorize(), call("DELETE"));
      return ((await answer.json()) as { deleted: string[] }).deleted;
    },
  };
}

export interface DirectOptions {
  /** Id the CLI takes the lease under. Defaults to {@link CLI_NODE_ID}. */
  nodeId?: string;
  /**
   * The installation's platform domains, as the same configuration a node reads
   * carries them, so a claim for a host that names an application is refused on
   * this path too. None given refuses nothing, which is all a caller that could
   * not know them can say.
   */
  platformDomains?: string[];
  /**
   * The installation's DNS-01 delegation name, read from the same configuration
   * — so a claim made straight into the bucket reads the same sentence a node
   * would have answered with.
   */
  acmeDelegation?: string;
}

/**
 * The per-application commands as writes straight into the bucket.
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
 * somebody deleted an application from their laptop. The lease is released as
 * soon as the deletion is over, successful or not, so the fleet takes it back at
 * once instead of waiting out the TTL.
 *
 * Throws `ScafoError("lease-lost")` when the lease could not be taken at all,
 * which means a live coordinator is holding it and the request belongs there.
 */
export function directOps(registry: RegistryContext, opts?: DirectOptions): ApplicationOps {
  const nodeId = opts?.nodeId ?? CLI_NODE_ID;
  const platformDomains = opts?.platformDomains ?? [];

  const claimable = (host: string): string => {
    const claimed = normalizeCustomDomain(host);
    assertClaimableHost(claimed, platformDomains);
    return claimed;
  };

  const changed = async (name: string, host: string): Promise<DomainChange> => {
    const application = await getApplication(registry, name);
    return {
      application,
      host,
      platformHosts: platformDomains
        .map((domain) => hostUnder(domain, name))
        .filter((named): named is string => named !== null),
      ...(opts?.acmeDelegation === undefined ? {} : { acmeDelegation: opts.acmeDelegation }),
    };
  };

  return {
    via: "the registry bucket",
    retire: (name) => retireApplication(registry, name),
    unretire: (name) => unretireApplication(registry, name),
    setSelector: (name, selector) => setNodeSelector(registry, name, selector),
    setReplicas: (name, replicas) => setReplicas(registry, name, replicas),
    show: (name) => getApplication(registry, name),

    async addDomain(name, host, claim): Promise<DomainChange> {
      const claimed = claimable(host);
      await claimDomain(registry, claimed, name, claim ?? {});
      return changed(name, claimed);
    },

    async removeDomain(name, host): Promise<DomainChange> {
      const claimed = normalizeCustomDomain(host);
      await releaseApplicationDomain(registry, claimed, name);
      return changed(name, claimed);
    },

    async delete(name, deleteOpts): Promise<string[]> {
      const lease = await takeLease(registry, nodeId, name);
      try {
        const { deleted } = await deleteApplication(registry, name, lease, deleteOpts ?? {});
        return deleted;
      } finally {
        /* Best effort: the TTL expires it anyway, and a release that failed must
           not turn a completed deletion into a reported failure. */
        await releaseLease(registry, lease).catch(() => {});
      }
    },
  };
}

/** Where the application surface lives on a node. */
const APPLICATIONS_PATH = "/v1/applications";

/** What a node answers `GET /v1/applications` with. */
export interface ApplicationListing {
  /** Admin records; non-admin responses redact labels without revealing presence. */
  applications: ApplicationRecord[];
  /** Set when the node showed only what this key reaches, rather than the fleet. */
  scoped?: true;
}

/**
 * One application as `scafo app show` reads it: the record, and what the
 * fleet's own node records say is happening to it.
 */
export interface ApplicationView {
  application: ApplicationRecord;
  /** Where it is really running. Absent from a node too old to report it. */
  serving?: ApplicationServing;
}

/** The admin-only half of the application surface, signed for by one key. */
export interface ApplicationApi {
  /** Where these calls go, for whatever reports what was done and to whom. */
  via: string;
  list(): Promise<ApplicationListing>;
  /** The record and, beside it, how much of the fleet is actually serving it. */
  show(name: string): Promise<ApplicationView>;
  block(name: string): Promise<ApplicationRecord>;
  unblock(name: string): Promise<ApplicationRecord>;
  setLabels(name: string, labels: Record<string, string>): Promise<ApplicationRecord>;
}

export function applicationApi(opts: NodeOptions): ApplicationApi {
  const at = (suffix: string = ""): string => `${opts.url}${APPLICATIONS_PATH}${suffix}`;
  const call = (method: string): { method: string; fetchFn?: typeof fetch } => ({
    method,
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  });

  const verb = async (name: string, action: string): Promise<ApplicationRecord> => {
    assertSlug(name);
    const answer = await request(at(`/${name}/${action}`), opts, call("POST"));
    return (answer as { application: ApplicationRecord }).application;
  };

  return {
    via: opts.url,

    async list(): Promise<ApplicationListing> {
      const answer = (await request(at(), opts, call("GET"))) as ApplicationListing;
      return {
        applications: answer.applications,
        ...(answer.scoped === true ? { scoped: true as const } : {}),
      };
    },

    async show(name): Promise<ApplicationView> {
      assertSlug(name);
      const answer = (await request(at(`/${name}`), opts, call("GET"))) as ApplicationView;
      return {
        application: answer.application,
        ...(answer.serving === undefined ? {} : { serving: answer.serving }),
      };
    },

    block: (name) => verb(name, "block"),
    unblock: (name) => verb(name, "unblock"),

    async setLabels(name, labels): Promise<ApplicationRecord> {
      assertSlug(name);
      const answer = await request(at(`/${name}/labels`), opts, {
        ...call("POST"),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels }),
      });
      return (answer as { application: ApplicationRecord }).application;
    },
  };
}

/** Parses replacement `k=v` labels; no pairs clears labels. */
export function readLabelArgs(pairs: string[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      throw new ScafoError("invalid-input", "Invalid label", {
        detail:
          `"${pair}" is not a "key=value" pair; labels are written as ` +
          `"scafo app label --name shop tenant=acme plan=pro"`,
      });
    }
    labels[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return labels;
}

/**
 * The listing as an operator reads it: one row per application, and a header
 * saying how many of them are stopped.
 *
 * THE BLOCKED COUNT IS THE LINE WORTH HAVING, for the same reason the node
 * listing leads with how many machines are live: somebody running this is
 * usually asking "is anything stopped that should not be?", and answering that
 * by making them read a column would be answering a different question.
 */
export function formatApplicationTable(listing: ApplicationListing): string {
  const applications = listing.applications;
  if (applications.length === 0) {
    return (
      `scafo: no application here${listing.scoped === true ? " that this key reaches" : ""}; ` +
      `an application comes into being on the first deploy that names it`
    );
  }

  const blocked = applications.filter((entry) => entry.blocked === true).length;
  const rows = applications.map((entry) => [
    entry.name,
    stateOf(entry),
    entry.deployment === null ? "-" : `r${String(entry.deployment.revision)}`,
    entry.createdAt,
    formatLabels(entry.labels ?? {}),
  ]);
  const head = ["APPLICATION", "STATE", "DEPLOYMENT", "CREATED", "LABELS"];
  const width = head.map((_, column) =>
    Math.max(...[head, ...rows].map((row) => (row[column] as string).length)),
  );

  return [
    `scafo: ${String(applications.length)} application${applications.length === 1 ? "" : "s"}, ` +
      `${String(blocked)} blocked` +
      /* Said plainly, because a filtered listing and a whole one are the same
         shape: a tenant reading this must not conclude the fleet has one
         application. */
      (listing.scoped === true ? " (the applications this key reaches)" : ""),
    "",
    ...[head, ...rows].map((row) => `  ${row.map(pad(width)).join("  ").trimEnd()}`),
  ].join("\n");
}

/** One application as `scafo app show` prints it. */
export function formatApplication(
  application: ApplicationRecord,
  serving?: ApplicationServing,
): string {
  const deployment = application.deployment;
  const lines = [
    `scafo: application "${application.name}"`,
    ``,
    `  state       ${stateOf(application, serving)}`,
    `  created     ${application.createdAt}`,
    `  deployment  ${
      deployment === null
        ? "none yet"
        : `revision ${String(deployment.revision)} at ${deployment.deployedAt}`
    }`,
    `  replicas    ${application.replicas === undefined ? "all" : String(application.replicas)}`,
    `  selector    ${
      application.nodeSelector === undefined ? "-" : describeSelector(application.nodeSelector)
    }`,
    `  domains     ${application.domains.length === 0 ? "-" : describeDomains(application).join(",")}`,
    `  labels      ${formatLabels(application.labels ?? {})}`,
  ];

  if (application.retiredAt !== undefined) {
    lines.push(
      ``,
      `  Retired at ${application.retiredAt}: no node serves it, and it can be`,
      `  deleted once its grace has run out. "scafo app unretire --name`,
      `  ${application.name}" puts it back.`,
    );
  }
  if (application.blocked === true) {
    lines.push(
      ``,
      `  Nothing of it is served or deployed to while it is blocked, and`,
      `  nothing of it has been deleted: "scafo app unblock --name ${application.name}"`,
      `  puts it all back on the next pass of every node.`,
    );
  }
  lines.push(...describeFailingNodes(serving));
  return lines.join("\n");
}

/**
 * The nodes that hold this application and cannot keep it running, one line
 * each, with the last thing its process said there.
 *
 * SAID IN THE APPLICATION'S OWN SUMMARY, because this is where somebody looks
 * when a tenant says the site is up and down: without it, an application served
 * by two nodes out of three and crash-looping on the third reads exactly like
 * one that is fine.
 */
function describeFailingNodes(serving: ApplicationServing | undefined): string[] {
  if (serving === undefined || serving.failing.length === 0) return [];

  const lines = [
    ``,
    `  Failing on ${String(serving.failing.length)} of ${String(serving.nodes)} ` +
      `node${serving.nodes === 1 ? "" : "s"}. Scafo keeps restarting the process and`,
    `  never repairs the runtime's own state; the last words are the runtime's:`,
  ];
  for (const failure of serving.failing) {
    lines.push(
      `    ${failure.node}  ${String(failure.restarts)} restart` +
        `${failure.restarts === 1 ? "" : "s"} since ${failure.since}` +
        (failure.lastError === undefined ? "" : `: ${failure.lastError}`),
    );
  }
  return lines;
}

/** How a wildcard claim is marked wherever a host is printed. */
export const WILDCARD_MARK: string = "(+subdomains)";

/**
 * The application's hosts as a terminal prints them, sorted, each marked when
 * the claim covers the label below it as well. A wildcard is never written as a
 * `*` here, because nobody types one either.
 */
export function describeDomains(application: ApplicationRecord): string[] {
  const wildcards = new Set(application.wildcardDomains ?? []);
  return [...application.domains]
    .sort()
    .map((host) => (wildcards.has(host) ? `${host} ${WILDCARD_MARK}` : host));
}

/** How a retirement reads on the terminal, grace included so the next step is obvious. */
export function describeRetirement(name: string, application: ApplicationRecord): string {
  if (application.retiredAt === undefined) return `scafo: "${name}" is not retired`;

  return (
    `scafo: "${name}" is retired as of ${application.retiredAt}; every node stops serving it ` +
    `on its next pass, "scafo app unretire" puts it straight back, and it can be deleted once ` +
    `its grace has run out`
  );
}

/** The two ways `scafo app selector` can be told what to do. */
export interface SelectorFlags {
  /** One `k=v` pair per `--set`, and empty when the flag was not given. */
  set: string[];
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
 * accidental `scafo app selector` that lifted a constraint would move an
 * application across a fleet without anyone asking it to.
 */
export function readSelectorFlags(flags: SelectorFlags): NodeSelector | null {
  if (flags.set.length > 0 && flags.clear) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail: `--set "${flags.set.join('" --set "')}" and --clear ask for opposite things; pass one of them`,
    });
  }
  if (flags.clear) return null;
  if (flags.set.length > 0) return parseLabelEntries(flags.set, "--set");

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail:
      `pass --set key=value, once per label, to choose which nodes may serve it, ` +
      `or --clear to let it run on every node again`,
  });
}

/**
 * How a selector change reads on the terminal, naming what happens next: the
 * decision is the coordinator's, and it is taken on its next assignment pass
 * rather than by the command that stated the intent.
 */
export function describeSelectorChange(name: string, application: ApplicationRecord): string {
  const selector = application.nodeSelector;

  if (selector === undefined) {
    return (
      `scafo: "${name}" selects no nodes any more; the coordinator places it over the whole ` +
      `fleet again on its next assignment pass`
    );
  }
  return (
    `scafo: "${name}" runs only on nodes labelled ${describeSelector(selector)}; the ` +
    `coordinator places it on the next assignment pass, and reports the application as ` +
    `unplaced — leaving whatever serves it now running — if no live node carries them`
  );
}

/** How a replica change reads on the terminal, for the same reason a selector's does. */
export function describeReplicasChange(name: string, application: ApplicationRecord): string {
  const replicas = application.replicas ?? "all";
  return (
    `scafo: "${name}" asks for ${replicas === "all" ? "every eligible node" : `${String(replicas)} node${replicas === 1 ? "" : "s"}`}; ` +
    `the coordinator decides which on its next assignment pass`
  );
}

/* ---------------------------------------------------------------- internals */

/**
 * The one word — or the one phrase — for what is happening to an application.
 *
 * A PLAIN "serving" IS A CLAIM, and it is only made when nothing contradicts
 * it. A live node reporting the application as failing is exactly such a
 * contradiction, so the state says how much of the fleet is really answering
 * for it and the lines beneath say which node is not.
 */
function stateOf(application: ApplicationRecord, serving?: ApplicationServing): string {
  if (application.blocked === true) return "blocked";
  if (application.retiredAt !== undefined) return "retired";
  if (serving === undefined || serving.failing.length === 0) return "serving";
  return `serving on ${String(serving.serving)} of ${String(serving.nodes)} nodes`;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "-";
  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
}

function pad(width: number[]): (cell: string, column: number) => string {
  return (cell, column) => cell.padEnd(width[column] as number);
}

async function request(
  url: string,
  opts: NodeOptions,
  init: { method: string; fetchFn?: typeof fetch; headers?: Record<string, string>; body?: string },
): Promise<unknown> {
  const answer = await nodeRequest(url, await opts.authorize(), init);
  return answer.json();
}

async function takeLease(
  registry: RegistryContext,
  nodeId: string,
  name: string,
): Promise<LeaseHandle> {
  const lease = await acquireLease(registry, nodeId);
  if (lease !== null) return lease;

  throw new ScafoError("lease-lost", "A node is coordinating this installation", {
    detail:
      `"${name}" cannot be deleted straight through the bucket while a node holds the ` +
      `coordinator lease: ask that installation instead, with --node <url> --key <file>, and ` +
      `the request reaches the coordinator wherever it is`,
  });
}
