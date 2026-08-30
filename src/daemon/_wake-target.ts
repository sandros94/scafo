/* Internal: what a request's Host names, and whether it is an environment this node can wake. */

import { isScafoError } from "../core/error.ts";
import { platformLabel } from "../core/placement/hosts.ts";
import { APEX_ENVIRONMENT } from "../core/placement/routes.ts";
import { deploymentRevision } from "../core/registry/_deployment.ts";
import { readJson } from "../core/registry/cas.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { type ResolvedParkPolicy, resolveParkPolicy } from "../core/registry/park.ts";
import { environmentKey } from "../core/registry/paths.ts";
import { isProjectBlocked } from "../core/registry/projects.ts";
import type { EnvironmentRecord } from "../core/types/registry.ts";
import { parseHostLabel } from "../core/utils/slug.ts";
import type { ParkedEnvironment } from "./_desired.ts";

/** One environment to bring back into service. */
export interface WakeTarget {
  kind: "environment";
  project: string;
  env: EnvironmentRecord;
  policy: ResolvedParkPolicy;
}

/** Resolves a request host to a wakeable environment, or null. */
export async function resolveWakeTarget(
  registry: RegistryContext,
  opts: { host: string; platformDomains: string[]; parked: ParkedEnvironment[] },
): Promise<WakeTarget | null> {
  const target = await resolveHost(registry, opts);
  if (target === null) return null;
  return (await isProjectBlocked(registry, target.project)) ? null : target;
}

async function resolveHost(
  registry: RegistryContext,
  opts: { host: string; platformDomains: string[]; parked: ParkedEnvironment[] },
): Promise<WakeTarget | null> {
  const label = platformLabel(opts.host, opts.platformDomains);
  if (label === null) {
    const claim = opts.parked.find((entry) => entry.env.domains.includes(opts.host));
    return claim === undefined ? null : wakeableEnvironment(claim.project, claim.env);
  }

  const parsed = parseHostLabel(label);
  if (parsed === null) return null;
  const environment = await readEnvironment(
    registry,
    parsed.project,
    parsed.ref ?? APEX_ENVIRONMENT,
  );
  return environment === null ? null : wakeableEnvironment(parsed.project, environment);
}

async function readEnvironment(
  registry: RegistryContext,
  project: string,
  env: string,
): Promise<EnvironmentRecord | null> {
  try {
    const found = await readJson<EnvironmentRecord>(registry, environmentKey(project, env));
    return found?.value ?? null;
  } catch (error) {
    if (isScafoError(error) && error.code === "invalid-slug") return null;
    throw error;
  }
}

function wakeableEnvironment(project: string, env: EnvironmentRecord): WakeTarget | null {
  if (env.retiredAt !== undefined || deploymentRevision(env) === null) return null;
  return { kind: "environment", project, env, policy: resolveParkPolicy(env) };
}
