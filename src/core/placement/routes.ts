/*
 * Turns what a node is actually serving into the routing an ingress should
 * present for it.
 *
 * Pure: every input is supplied by the caller, so the same state always renders
 * the same routes in the same order.
 */

import { isScafoError } from "../error.ts";
import type {
  ApiRouting,
  IngressBackend,
  IngressDesired,
  WakeRouting,
  WeightedBackend,
} from "../types/ingress.ts";
import type { EnvironmentRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";
import { formatHostLabel } from "../utils/slug.ts";

/**
 * The one environment name that also answers on its project's apex host. Every
 * other environment is only reachable under its own label.
 */
export const APEX_ENVIRONMENT: string = "production";

/** What the weights of one host sum to, whatever the split says. */
export const FULL_WEIGHT: number = 100;

/** One build carrying a share of an environment's own traffic. */
export interface ServingBuild {
  build: string;
  weight: number;
}

/**
 * The parts of the node API that MUST NOT be reachable through a platform
 * apex, whatever else that apex serves. Every ingress driver is handed these in
 * {@link ApiRouting.denied} and enforces them itself.
 *
 * `/v1/storage` carries PRIVATE KEYS in both directions — a colocated ingress's
 * certificates, the account key it issues them with, and the locks that
 * serialize issuance — and is guarded by one shared token meant for a caller on
 * this machine or inside the installation's own tunnel. Publishing it at a name
 * the internet resolves would put that token between the world and every
 * certificate the fleet holds.
 *
 * `/v1/ingress/traefik` is the WHOLE routing map of the node: every host it
 * serves and the loopback port behind each. It is unauthenticated because it is
 * a pull-provider endpoint for an ingress sharing this node's network namespace,
 * and that reading stops being true the moment it is reachable from anywhere
 * else — so it is a colocated surface rather than a public API, and it is
 * excluded on exactly the same mechanism as the storage one.
 *
 * Matched at a path SEGMENT boundary by every driver: the prefix exactly, or the
 * prefix followed by `/` and anything at all.
 */
export const API_DENIED_PREFIXES: string[] = ["/v1/storage", "/v1/ingress/traefik"];

/** A custom domain and the environment that claimed it. */
export interface RouteClaim {
  host: string;
  project: string;
  environment: string;
}

export interface RenderRoutesInput {
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /**
   * Every environment the node serves, with the record that names its alias and,
   * when it has one, its traffic split.
   */
  environments: Array<{ project: string; env: EnvironmentRecord }>;
  /** Processes running on this node right now; only ready ones are routable. */
  processes: RuntimeProcess[];
  claims: RouteClaim[];
  /**
   * The daemon's own loopback port and the environments this node reads as
   * parked, when there is a daemon for a request to fall through to.
   *
   * Omitted, and the routing then carries no `wake` at all, by a caller that has
   * no daemon address to hand out — which is exactly the routing scafo rendered
   * before scale-to-zero existed.
   */
  wake?: { port: number; parked: Array<{ project: string; env: EnvironmentRecord }> };
  /**
   * The daemon's own loopback port again, by a node publishing the fleet's API at
   * its platform domains' bare apexes (`api.public`).
   *
   * Omitted, and the routing then carries no `api` at all, by a node whose
   * operator turned that off — which is exactly the routing scafo rendered
   * before the apex served anything.
   */
  api?: { port: number };
}

/**
 * Renders the routing for the processes this node has ready.
 *
 * Three kinds of host are emitted, in descending precedence when two of them
 * would answer on the same name:
 *
 * 1. `<project>--<env>.<domain>` for each environment that has something ready
 *    to serve it, plus `<project>.<domain>` when that environment is
 *    {@link APEX_ENVIRONMENT}.
 * 2. `<project>--<build>.<domain>` for every ready process, whichever build it
 *    serves. A build stays reachable under its own hash for as long as a process
 *    runs it, which is what makes a superseded build inspectable during a flip
 *    and either leg of a split addressable on its own.
 * 3. Each claimed custom domain whose environment has something ready.
 * 4. The hosts of every PARKED environment — its label under each domain, its
 *    apex when it is {@link APEX_ENVIRONMENT}, and every custom domain its
 *    record claims — which no process answers on and which therefore go to the
 *    node's own daemon instead, to be woken by the request that asked for them.
 *    These are reported in `wake` rather than in `routes`, because they name a
 *    daemon rather than a backend, and a host that already has a route in (1),
 *    (2) or (3) is never among them: mid-transition, the ready process wins.
 * 5. The BARE APEX of every platform domain, when this node publishes the
 *    fleet's API there — reported in `api`, on the same precedence rule: an apex
 *    that (1), (2), (3) or (4) already answers on is left out. A `*.<domain>`
 *    matcher covers exactly one label, so an apex is never a catch-all's
 *    business and needs an explicit route of its own.
 *
 * A process that has not passed its readiness gate is never routed: sending it
 * traffic is exactly what the gate exists to prevent.
 *
 * WHAT AN ENVIRONMENT'S OWN HOSTS RESOLVE TO is the alias build alone while the
 * environment carries no split, and the SPLIT LEGS — weighted as the registry
 * states them — while it carries one. The alias is untouched by a split and
 * stays the primary pointer, so a build it names that is not itself a leg keeps
 * running and stays reachable under its own hash; it simply takes none of the
 * environment's traffic until the split is cleared. Build-hash hosts are never
 * weighted: they name one build and reach it.
 */
export function renderRoutes(input: RenderRoutesInput): IngressDesired {
  const ready = readyProcesses(input.processes);

  const routes = new Map<string, WeightedBackend[]>();
  /* Precedence is "first writer wins", so the kinds are emitted in order and a
     later one never steals a host an earlier one already answers on. */
  const add = (host: string | null, backends: WeightedBackend[] | undefined): void => {
    if (host === null || backends === undefined || backends.length === 0) return;
    if (routes.has(host)) return;
    routes.set(host, backends);
  };

  const environments = [...input.environments].sort((a, b) =>
    compare(`${a.project}/${a.env.name}`, `${b.project}/${b.env.name}`),
  );

  /* What an environment's own hosts resolve to, shared by its label, its apex
     host when it has one, and every custom domain claimed for it. */
  const served = new Map<string, WeightedBackend[]>();
  for (const { project, env } of environments) {
    const backends = legsOf(project, env, ready);
    if (backends.length > 0) served.set(placement(project, env.name), backends);
  }

  for (const { project, env } of environments) {
    const backends = served.get(placement(project, env.name));
    if (backends === undefined) continue;

    for (const domain of input.platformDomains) {
      add(hostUnder(domain, project, env.name), backends);
      if (env.name === APEX_ENVIRONMENT) add(hostUnder(domain, project), backends);
    }
  }

  for (const process of ready) {
    for (const domain of input.platformDomains) {
      add(hostUnder(domain, process.project, process.build), [
        { backend: backendOf(process), weight: FULL_WEIGHT },
      ]);
    }
  }

  for (const claim of [...input.claims].sort((a, b) => compare(a.host, b.host))) {
    add(claim.host, served.get(placement(claim.project, claim.environment)));
  }

  const wake =
    input.wake === undefined ? undefined : wakeRouting(input.wake, input.platformDomains, routes);
  const api =
    input.api === undefined
      ? undefined
      : apiRouting(input.api, input.platformDomains, routes, wake);

  return {
    routes: [...routes.keys()]
      .sort(compare)
      .map((host) => ({ host, backends: routes.get(host) as WeightedBackend[] })),
    ...(wake === undefined ? {} : { wake }),
    ...(api === undefined ? {} : { api }),
  };
}

/**
 * What an environment's own hosts answer with, weighted — the very computation
 * {@link renderRoutes} gives its label, its apex and its custom domains, and an
 * empty list when nothing ready serves it.
 *
 * The legs are the split's, in the order the registry states them, or the alias
 * build alone at {@link FULL_WEIGHT} when there is no split. A leg with no ready
 * process is left out and its share redistributed — see {@link shares}. Only
 * ready processes are considered, whatever order they arrive in.
 *
 * EXPORTED SO THAT WHAT ANSWERS AN ENVIRONMENT IS DECIDED IN ONE PLACE. The
 * daemon's wake surface answers every host the ingress has no explicit route for,
 * which is more of the traffic than it looks: a parked or starting environment,
 * and every host of every environment while a router propagates. A second
 * reading of "what serves this environment" would be a second routing, and two
 * routings drift — the one that drifted served a build a flip had already
 * superseded. There is one, and it is this.
 */
export function servingLegs(
  project: string,
  env: EnvironmentRecord,
  processes: RuntimeProcess[],
): WeightedBackend[] {
  return legsOf(project, env, readyProcesses(processes));
}

/**
 * The builds an environment's own hosts serve, with their stated weights.
 *
 * A split replaces the alias for traffic while it is present; otherwise the
 * alias is the whole serving set. Consumers that need to know whether a build
 * is active use this rather than interpreting alias and split themselves.
 */
export function servingBuilds(env: EnvironmentRecord): ServingBuild[] {
  const merged = new Map<string, number>();
  for (const leg of env.split ?? aliasLeg(env)) {
    merged.set(leg.build, (merged.get(leg.build) ?? 0) + leg.weight);
  }
  return [...merged].map(([build, weight]) => ({ build, weight }));
}

/**
 * The one leg a single request takes, given a draw in `[0, 1)`, or undefined
 * when there is no leg to take.
 *
 * The weights are shares of {@link FULL_WEIGHT} and this walks them in the order
 * the legs are stated, so a draw below the first leg's share takes the first
 * leg. It is the choice an ingress's load balancer makes per request, made here
 * for a request that is being HELD rather than routed; the two agree on the
 * distribution and on nothing about the sequence, which is all a weight promises.
 *
 * The draw is the caller's, so this stays pure and a test states which leg a
 * request takes. A draw outside `[0, 1)` still names a leg — the first below
 * zero, the last at or above one — rather than nothing.
 */
export function pickLeg(legs: WeightedBackend[], draw: number): WeightedBackend | undefined {
  if (legs.length === 0) return undefined;

  const point = draw * legs.reduce((sum, leg) => sum + leg.weight, 0);

  let passed = 0;
  for (const leg of legs) {
    passed += leg.weight;
    if (point < passed) return leg;
  }
  return legs[legs.length - 1];
}

/**
 * What the node's own daemon is given: the hosts of every parked environment,
 * and the platform domains it answers for whatever else is asked of them.
 *
 * A host `routes` already answers on is left out rather than listed in both. The
 * two overlap for a whole pass whenever an environment is waking — the record
 * still reads parked to a node that has not re-read it, while the process it
 * started is already ready — and the ready process is the better answer of the
 * two, since routing it to the daemon would hold a request for something that is
 * already up.
 */
function wakeRouting(
  wake: { port: number; parked: Array<{ project: string; env: EnvironmentRecord }> },
  platformDomains: string[],
  routes: Map<string, WeightedBackend[]>,
): WakeRouting {
  const hosts = new Set<string>();
  const claim = (host: string | null): void => {
    if (host === null || routes.has(host)) return;
    hosts.add(host);
  };

  for (const { project, env } of wake.parked) {
    for (const domain of platformDomains) {
      claim(hostUnder(domain, project, env.name));
      if (env.name === APEX_ENVIRONMENT) claim(hostUnder(domain, project));
    }
    /* The record mirrors every domain claimed for the environment, and a parked
       environment is reached by its custom names exactly as it is by its own. */
    for (const host of env.domains) claim(host);
  }

  return { port: wake.port, hosts: [...hosts].sort(compare), domains: [...platformDomains] };
}

/**
 * The apexes this node answers the fleet's API at: every platform domain, bare.
 *
 * A domain something else already answers on is left out rather than listed
 * twice — an environment that claimed the platform apex as a custom domain, or a
 * parked one holding it open. The rule is the same one the routes themselves are
 * built on: the first thing to claim a host keeps it, and an application an
 * operator deliberately put at the apex is not displaced by the API.
 */
function apiRouting(
  api: { port: number },
  platformDomains: string[],
  routes: Map<string, WeightedBackend[]>,
  wake: WakeRouting | undefined,
): ApiRouting {
  const held = new Set(wake?.hosts ?? []);
  const hosts = new Set(
    platformDomains.filter((domain) => !routes.has(domain) && !held.has(domain)),
  );

  return { port: api.port, hosts: [...hosts].sort(compare), denied: [...API_DENIED_PREFIXES] };
}

/**
 * {@link servingLegs} over processes that are already ready and already sorted,
 * which is what a whole render shares between its environments.
 */
function legsOf(
  project: string,
  env: EnvironmentRecord,
  ready: RuntimeProcess[],
): WeightedBackend[] {
  const serving: Array<{ backend: IngressBackend; weight: number }> = [];
  for (const { build, weight } of servingBuilds(env)) {
    const process = ready.find(
      (candidate) =>
        candidate.project === project && candidate.env === env.name && candidate.build === build,
    );
    if (process !== undefined) serving.push({ backend: backendOf(process), weight });
  }
  if (serving.length === 0) return [];

  const weights = shares(serving.map((leg) => leg.weight));
  return serving.map((leg, index) => ({ backend: leg.backend, weight: weights[index] }));
}

/** The environment's alias as the single leg it is, or nothing when it has none. */
function aliasLeg(env: EnvironmentRecord): ServingBuild[] {
  const build = env.alias?.build;
  return build === undefined ? [] : [{ build, weight: FULL_WEIGHT }];
}

/**
 * The weights of the legs that are actually ready, rescaled to sum to
 * {@link FULL_WEIGHT}.
 *
 * A SPLIT IS A ROUTING PREFERENCE; AN OUTAGE IS NOT ONE OF THE OPTIONS. A leg
 * whose process has not passed its readiness gate — the pass that first starts
 * it, or a restart after it crashed — has its share handed to the legs that ARE
 * ready, in proportion to what they already had, rather than being sent traffic
 * nothing answers. It takes its share back on the pass after it becomes ready,
 * so a 90/10 split whose 10 is still coming up serves 100 from the 90.
 *
 * Largest remainder, ties to the earlier leg, so the shares sum to exactly 100
 * after rounding and the same input always rounds the same way. No leg rounds
 * down to nothing: a registry weight is at least 1 and the legs it is measured
 * against sum to at most 100, so every share is at least 1 before rounding.
 */
function shares(weights: number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return weights.map(() => 1);

  const exact = weights.map((weight) => (weight * FULL_WEIGHT) / total);
  const given = exact.map((share) => Math.floor(share));

  let left = FULL_WEIGHT - given.reduce((sum, share) => sum + share, 0);
  const byRemainder = exact
    .map((share, index) => ({ index, remainder: share - given[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (const entry of byRemainder) {
    if (left <= 0) break;
    given[entry.index]++;
    left--;
  }
  return given;
}

/**
 * A fully-qualified host under one platform domain, or null when the label
 * cannot be built.
 *
 * A skip rather than a failure: `project--ref` is capped at the DNS label limit,
 * so a long enough project and environment pair simply has no name to answer on.
 * Refusing to render the whole routing over it would take every other
 * environment on the node offline with it.
 */
function hostUnder(domain: string, project: string, ref?: string): string | null {
  try {
    return `${formatHostLabel(project, ref)}.${domain}`;
  } catch (error) {
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
}

/**
 * The processes anything here may name, in one order: sorted so that two ready
 * processes serving the same build — which a retried start can leave behind —
 * always resolve to the same one.
 */
function readyProcesses(processes: RuntimeProcess[]): RuntimeProcess[] {
  return processes
    .filter((process) => process.ready)
    .sort((a, b) => compare(a.processId, b.processId));
}

function backendOf(process: RuntimeProcess): IngressBackend {
  return {
    project: process.project,
    env: process.env,
    build: process.build,
    port: process.port,
  };
}

function placement(project: string, env: string): string {
  return `${project}/${env}`;
}

/* Code-unit ordering, so the routing does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
