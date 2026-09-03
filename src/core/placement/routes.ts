/* Pure ingress routing from running environment processes and claims. */

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

/** Public API paths denied at platform apexes: TLS storage and Traefik's
    colocated routing feed. Drivers match path-segment boundaries. */
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
  /** Optional loopback API port for platform-domain bare apexes. */
  api?: { port: number };
}

/** Renders deterministic routes: environment hosts then claims, with API apexes
    only where no application route wins. */
export function renderRoutes(input: RenderRoutesInput): IngressDesired {
  const running = runningProcesses(input.processes);

  const routes = new Map<string, IngressBackend>();
  /* First writer wins across route classes. */
  const add = (host: string | null, backend: IngressBackend | undefined): void => {
    if (host === null || backend === undefined) return;
    if (routes.has(host)) return;
    routes.set(host, backend);
  };

  const environments = [...input.environments].sort((a, b) =>
    compare(`${a.project}/${a.env.name}`, `${b.project}/${b.env.name}`),
  );

  /* One backend shared by all hosts for an environment. */
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

/** Backend an environment's hosts use, or undefined without a running process. */
export function servingBackend(
  project: string,
  env: EnvironmentRecord,
  processes: RuntimeProcess[],
): IngressBackend | undefined {
  return currentBackend(project, env, runningProcesses(processes));
}

/** API apexes not already claimed by an application route. */
function apiRouting(
  api: { port: number },
  platformDomains: string[],
  routes: Map<string, IngressBackend>,
): ApiRouting {
  const hosts = new Set(platformDomains.filter((domain) => !routes.has(domain)));

  return { port: api.port, hosts: [...hosts].sort(compare), denied: [...API_DENIED_PREFIXES] };
}

/** Resolves a backend from sorted, running processes. */
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

/** Builds a platform host, skipping labels too long for DNS rather than failing all routes. */
export function hostUnder(domain: string, project: string, ref?: string): string | null {
  try {
    return `${formatHostLabel(project, ref)}.${domain}`;
  } catch (error) {
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
}

/** Stable process order makes duplicate starts resolve deterministically. */
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
