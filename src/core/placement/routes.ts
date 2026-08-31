/*
 * Turns what a node is actually serving into the routing an ingress should
 * present for it.
 *
 * Pure: every input is supplied by the caller, so the same state always renders
 * the same routes in the same order.
 */

import { isScafoError } from "../error.ts";
import type { ApiRouting, IngressBackend, IngressDesired } from "../types/ingress.ts";
import type { EnvironmentRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";
import { formatHostLabel } from "../utils/slug.ts";

/**
 * The one environment name that also answers on its project's apex host. Every
 * other environment is only reachable under its own label.
 */
export const APEX_ENVIRONMENT: string = "production";

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
   * Every deployed environment the node serves.
   */
  environments: Array<{ project: string; env: EnvironmentRecord }>;
  /** Processes the supervisor reports running on this node right now. */
  processes: RuntimeProcess[];
  claims: RouteClaim[];
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
 * Renders the routing for the processes this node has running.
 *
 * Three kinds of host are emitted, in descending precedence when two of them
 * would answer on the same name:
 *
 * 1. `<project>--<env>.<domain>` for each environment that has a process running
 *    to serve it, plus `<project>.<domain>` when that environment is
 *    {@link APEX_ENVIRONMENT}.
 * 2. Each claimed custom domain whose environment has a process running.
 * 3. The BARE APEX of every platform domain, when this node publishes the
 *    fleet's API there — reported in `api`, on the same precedence rule: an apex
 *    that an application already answers on is left out.
 *
 * An environment's hosts resolve only to its running environment-owned process.
 */
export function renderRoutes(input: RenderRoutesInput): IngressDesired {
  const running = runningProcesses(input.processes);

  const routes = new Map<string, IngressBackend>();
  /* Precedence is "first writer wins", so the kinds are emitted in order and a
     later one never steals a host an earlier one already answers on. */
  const add = (host: string | null, backend: IngressBackend | undefined): void => {
    if (host === null || backend === undefined) return;
    if (routes.has(host)) return;
    routes.set(host, backend);
  };

  const environments = [...input.environments].sort((a, b) =>
    compare(`${a.project}/${a.env.name}`, `${b.project}/${b.env.name}`),
  );

  /* What an environment's own hosts resolve to, shared by its label, its apex
     host when it has one, and every custom domain claimed for it. */
  const served = new Map<string, IngressBackend>();
  for (const { project, env } of environments) {
    const backend = currentBackend(project, env, running);
    if (backend !== undefined) served.set(placement(project, env.name), backend);
  }

  for (const { project, env } of environments) {
    const backend = served.get(placement(project, env.name));
    if (backend === undefined) continue;

    for (const domain of input.platformDomains) {
      add(hostUnder(domain, project, env.name), backend);
      if (env.name === APEX_ENVIRONMENT) add(hostUnder(domain, project), backend);
    }
  }

  for (const claim of [...input.claims].sort((a, b) => compare(a.host, b.host))) {
    add(claim.host, served.get(placement(claim.project, claim.environment)));
  }

  const api =
    input.api === undefined ? undefined : apiRouting(input.api, input.platformDomains, routes);

  return {
    routes: [...routes.keys()]
      .sort(compare)
      .map((host) => ({ host, backend: routes.get(host) as IngressBackend })),
    ...(api === undefined ? {} : { api }),
  };
}

/**
 * What an environment's own hosts answer with — the very computation
 * {@link renderRoutes} gives its label, its apex and its custom domains, and an
 * empty list when no supervised process serves it.
 *
 * EXPORTED SO THAT WHAT ANSWERS AN ENVIRONMENT IS DECIDED IN ONE PLACE. A second
 * reading of "what serves this environment" would be a second routing, and two
 * routings drift — the one that drifted served a build a deployment had already
 * superseded. There is one, and it is this.
 */
export function servingBackend(
  project: string,
  env: EnvironmentRecord,
  processes: RuntimeProcess[],
): IngressBackend | undefined {
  return currentBackend(project, env, runningProcesses(processes));
}

/**
 * The apexes this node answers the fleet's API at: every platform domain, bare.
 *
 * A domain something else already answers on is left out rather than listed
 * twice — an environment that claimed the platform apex as a custom domain. The
 * rule is the same one the routes themselves are built on: the first thing to
 * claim a host keeps it, and an application an
 * operator deliberately put at the apex is not displaced by the API.
 */
function apiRouting(
  api: { port: number },
  platformDomains: string[],
  routes: Map<string, IngressBackend>,
): ApiRouting {
  const hosts = new Set(platformDomains.filter((domain) => !routes.has(domain)));

  return { port: api.port, hosts: [...hosts].sort(compare), denied: [...API_DENIED_PREFIXES] };
}

/**
 * {@link servingBackend} over processes that are already running and already sorted,
 * which is what a whole render shares between its environments.
 */
function currentBackend(
  project: string,
  env: EnvironmentRecord,
  running: RuntimeProcess[],
): IngressBackend | undefined {
  if (env.deployment === null) return undefined;
  const process = running.find(
    (candidate) =>
      candidate.project === project &&
      candidate.env === env.name &&
      candidate.teardownPending !== true &&
      candidate.port > 0,
  );
  return process === undefined ? undefined : backendOf(process);
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
 * The processes anything here may name, in one order: sorted so that two running
 * processes serving the same environment — which a retried start can leave behind —
 * always resolve to the same one.
 */
function runningProcesses(processes: RuntimeProcess[]): RuntimeProcess[] {
  return [...processes].sort((a, b) => compare(a.processId, b.processId));
}

function backendOf(process: RuntimeProcess): IngressBackend {
  return {
    project: process.project,
    env: process.env,
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
