/* Pure ingress routing from running application processes and claims. */

import { isScafoError } from "../error.ts";
import type { ApiRouting, IngressBackend, IngressDesired } from "../types/ingress.ts";
import type { ApplicationRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";
import { assertSlug } from "../utils/slug.ts";

/** API paths denied at platform apexes: TLS storage, and the fleet's routing in
    every format, which all live under the one prefix — both name where every
    process listens. Drivers match path-segment boundaries. */
export const API_DENIED_PREFIXES: string[] = ["/v1/storage", "/v1/ingress/routes"];

/** A custom domain and the application that claimed it. */
export interface RouteClaim {
  host: string;
  application: string;
}

export interface RenderRoutesInput {
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /** Every deployed application the node serves. */
  applications: ApplicationRecord[];
  /** Processes the supervisor reports running on this node right now. */
  processes: RuntimeProcess[];
  claims: RouteClaim[];
  /** Optional loopback API port for platform-domain bare apexes. */
  api?: { port: number };
}

/** Renders deterministic routes: application hosts then claims, with API apexes
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

  const applications = [...input.applications].sort((a, b) => compare(a.name, b.name));

  /* One backend shared by all hosts of an application. */
  const served = new Map<string, IngressBackend>();
  for (const application of applications) {
    const backend = currentBackend(application, running);
    if (backend !== undefined) served.set(application.name, backend);
  }

  for (const application of applications) {
    const backend = served.get(application.name);
    if (backend === undefined) continue;

    for (const domain of input.platformDomains) {
      add(hostUnder(domain, application.name), backend);
    }
  }

  for (const claim of [...input.claims].sort((a, b) => compare(a.host, b.host))) {
    add(claim.host, served.get(claim.application));
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

/** Backend an application's hosts use, or undefined without a running process. */
export function servingBackend(
  application: ApplicationRecord,
  processes: RuntimeProcess[],
): IngressBackend | undefined {
  return currentBackend(application, runningProcesses(processes));
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
  application: ApplicationRecord,
  running: RuntimeProcess[],
): IngressBackend | undefined {
  if (application.deployment === null) return undefined;
  const process = running.find(
    (candidate) =>
      candidate.application === application.name &&
      candidate.teardownPending !== true &&
      candidate.port > 0,
  );
  return process === undefined
    ? undefined
    : { application: process.application, port: process.port };
}

/** Builds a platform host, skipping names too long for DNS rather than failing all routes. */
export function hostUnder(domain: string, application: string): string | null {
  try {
    assertSlug(application);
    return `${application}.${domain}`;
  } catch (error) {
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
}

/** Stable process order makes duplicate starts resolve deterministically. */
function runningProcesses(processes: RuntimeProcess[]): RuntimeProcess[] {
  return [...processes].sort((a, b) => compare(a.application, b.application));
}

/* Code-unit ordering, so the routing does not depend on the node's locale. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
