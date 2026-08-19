/*
 * Turns what a node is actually serving into the routing an ingress should
 * present for it.
 *
 * Pure: every input is supplied by the caller, so the same state always renders
 * the same routes in the same order.
 */

import { isScaloError } from "../error.ts";
import type { IngressBackend, IngressDesired } from "../types/ingress.ts";
import type { EnvironmentRecord } from "../types/registry.ts";
import type { RuntimeProcess } from "../types/runtime.ts";
import { formatHostLabel } from "../utils/slug.ts";

/**
 * The one environment name that also answers on its project's apex host. Every
 * other environment is only reachable under its own label.
 */
export const APEX_ENVIRONMENT: string = "production";

/** A custom domain and the environment that claimed it. */
export interface RouteClaim {
  host: string;
  project: string;
  environment: string;
}

export interface RenderRoutesInput {
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  /** Every environment the node serves, with the record that names its alias. */
  environments: Array<{ project: string; env: EnvironmentRecord }>;
  /** Processes running on this node right now; only ready ones are routable. */
  processes: RuntimeProcess[];
  claims: RouteClaim[];
}

/**
 * Renders the routing for the processes this node has ready.
 *
 * Three kinds of host are emitted, in descending precedence when two of them
 * would answer on the same name:
 *
 * 1. `<project>--<env>.<domain>` for each environment whose alias build has a
 *    ready process, plus `<project>.<domain>` when that environment is
 *    {@link APEX_ENVIRONMENT}.
 * 2. `<project>--<build>.<domain>` for every ready process, whichever build it
 *    serves. A build stays reachable under its own hash for as long as a process
 *    runs it, which is what makes a superseded build inspectable during a flip.
 * 3. Each claimed custom domain whose environment has a ready alias process.
 *
 * A process that has not passed its readiness gate is never routed: sending it
 * traffic is exactly what the gate exists to prevent.
 */
export function renderRoutes(input: RenderRoutesInput): IngressDesired {
  /* Sorted so that two ready processes serving the same build — which a retried
     start can leave behind — always resolve to the same one. */
  const ready = input.processes
    .filter((process) => process.ready)
    .sort((a, b) => compare(a.processId, b.processId));

  const routes = new Map<string, IngressBackend>();
  /* Precedence is "first writer wins", so the kinds are emitted in order and a
     later one never steals a host an earlier one already answers on. */
  const add = (host: string | null, backend: IngressBackend | undefined): void => {
    if (host === null || backend === undefined || routes.has(host)) return;
    routes.set(host, backend);
  };

  const environments = [...input.environments].sort((a, b) =>
    compare(`${a.project}/${a.env.name}`, `${b.project}/${b.env.name}`),
  );

  /* The backend an environment's alias resolves to, shared by its own label, its
     apex host when it has one, and every custom domain claimed for it. */
  const aliased = new Map<string, IngressBackend>();
  for (const { project, env } of environments) {
    const build = env.alias?.build;
    if (build === undefined) continue;

    const serving = ready.find(
      (process) =>
        process.project === project && process.env === env.name && process.build === build,
    );
    if (serving !== undefined) aliased.set(placement(project, env.name), backendOf(serving));
  }

  for (const { project, env } of environments) {
    const backend = aliased.get(placement(project, env.name));
    if (backend === undefined) continue;

    for (const domain of input.platformDomains) {
      add(hostUnder(domain, project, env.name), backend);
      if (env.name === APEX_ENVIRONMENT) add(hostUnder(domain, project), backend);
    }
  }

  for (const process of ready) {
    for (const domain of input.platformDomains) {
      add(hostUnder(domain, process.project, process.build), backendOf(process));
    }
  }

  for (const claim of [...input.claims].sort((a, b) => compare(a.host, b.host))) {
    add(claim.host, aliased.get(placement(claim.project, claim.environment)));
  }

  return {
    routes: [...routes.keys()]
      .sort(compare)
      .map((host) => ({ host, backend: routes.get(host) as IngressBackend })),
  };
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
    if (isScaloError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
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
