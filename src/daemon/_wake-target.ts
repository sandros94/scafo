/* Internal: what a request's Host names, and whether it is something this node can wake. */

import { isScafoError } from "../core/error.ts";
import { platformLabel } from "../core/placement/hosts.ts";
import { APEX_ENVIRONMENT } from "../core/placement/routes.ts";
import { getBuild } from "../core/registry/builds.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate, type RegistryContext } from "../core/registry/context.ts";
import { type ResolvedParkPolicy, resolveParkPolicy } from "../core/registry/park.ts";
import { environmentKey } from "../core/registry/paths.ts";
import { isProjectBlocked } from "../core/registry/projects.ts";
import { listBuildWakes } from "../core/registry/wake.ts";
import type { BuildRecord, EnvironmentRecord } from "../core/types/registry.ts";
import { parseHostLabel } from "../core/utils/slug.ts";
import type { ParkedEnvironment } from "./_desired.ts";

/**
 * What a wakeable host resolves to: an environment to bring back whole, or one
 * superseded build to recall at its own hash host.
 */
export type WakeTarget =
  | { kind: "environment"; project: string; env: EnvironmentRecord; policy: ResolvedParkPolicy }
  | {
      kind: "build";
      project: string;
      env: EnvironmentRecord;
      build: BuildRecord;
      policy: ResolvedParkPolicy;
    };

/**
 * Resolves a request's Host to the thing it asks this node to wake, or null when
 * there is nothing there to wake.
 *
 * NULL IS THE ONLY FAILURE, and it is answered with ONE 404 that says nothing
 * about which of the ways it came about: a name that never existed, an
 * environment that was retired, a project an admin has blocked, a build the
 * reaper has taken, a build whose environment no longer says where its code
 * lives, or one whose environment has recall turned off. The bucket is the
 * source of truth and a deleted record is a permanent 404 by design, so there is
 * nothing here for a caller to act on and nothing worth telling one caller about
 * another's project.
 *
 * THE BLOCK IS CHECKED ON WHAT WAS RESOLVED, not on the host that was asked
 * about, and that is deliberate: every target this can answer with carries the
 * project it belongs to, so one question at the end covers the platform labels,
 * the build-hash recalls and the custom domains at once, and no future way of
 * resolving a host can be added without meeting it. It costs one read per wake
 * that would otherwise have been admitted — a refusal never reaches it.
 *
 * THE HOST GRAMMAR IS THE EXACT INVERSE OF WHAT THE ROUTING RENDERS:
 *
 * - `<project>.<domain>` — the project's {@link APEX_ENVIRONMENT}.
 * - `<project>--<env>.<domain>` — that environment of that project.
 * - `<project>--<build>.<domain>` — that build, recalled at its own host. Read
 *   only when nothing of the project answers to `<build>` as an environment
 *   name, because the environment is what the label was rendered from first.
 * - any custom domain a PARKED environment's record mirrors.
 *
 * Everything else under a platform domain is a name this installation knows
 * nothing about, and resolves to null.
 */
export async function resolveWakeTarget(
  registry: RegistryContext,
  opts: { host: string; platformDomains: string[]; parked: ParkedEnvironment[] },
): Promise<WakeTarget | null> {
  const target = await resolveHost(registry, opts);
  if (target === null) return null;

  /* A blocked project is served nowhere, so waking one of its hosts would start
     something the very next reconcile pass stops again. */
  return (await isProjectBlocked(registry, target.project)) ? null : target;
}

/** What the host NAMES, before anything is asked about whether it may be served. */
async function resolveHost(
  registry: RegistryContext,
  opts: { host: string; platformDomains: string[]; parked: ParkedEnvironment[] },
): Promise<WakeTarget | null> {
  const label = platformLabel(opts.host, opts.platformDomains);
  if (label === null) {
    /* A custom domain is only wakeable while the environment holding it is one
       this node reads as parked: nothing else claims a name scafo did not mint. */
    const claim = opts.parked.find((entry) => entry.env.domains.includes(opts.host));
    return claim === undefined ? null : wakeableEnvironment(registry, claim.project, claim.env);
  }

  const parsed = parseHostLabel(label);
  if (parsed === null) return null;

  const { project, ref } = parsed;
  const named = await readEnvironment(registry, project, ref ?? APEX_ENVIRONMENT);
  if (named !== null) return wakeableEnvironment(registry, project, named);

  /* No environment answers to it, so the label's second half is read as the one
     other thing it can be. An apex host has no second half and stops here. */
  return ref === undefined ? null : recallableBuild(registry, project, ref);
}

/**
 * The environment record, or null when there is none — including when the name
 * is not one the registry could hold.
 */
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

/**
 * The environment as a target, or null when waking it would achieve nothing.
 *
 * A RETIRED environment is on its way out: no node will start anything for it,
 * however hard the request asks, so it is a 404 rather than a request held until
 * the deadline. An environment whose alias was never flipped is the same
 * outcome for a different reason — there is no build to serve at its own hosts —
 * UNLESS a build somebody woke is still inside its window, which is a process
 * this node will start and which does answer.
 */
async function wakeableEnvironment(
  registry: RegistryContext,
  project: string,
  env: EnvironmentRecord,
): Promise<WakeTarget | null> {
  if (env.retiredAt !== undefined) return null;

  const policy = resolveParkPolicy(env);
  if (env.alias === null && !(await hasFreshRecall(registry, project, env, policy))) return null;

  return { kind: "environment", project, env, policy };
}

/**
 * The build as a target, or null when nothing may recall it.
 *
 * Three ways a build hash is not wakeable, and they read identically from
 * outside: the build is gone, the record predates recall and does not say which
 * environment's fleet holds its code, or that environment has recall turned off
 * (`recallBuilds`, or a `buildIdleS` of zero, which is the same statement made
 * with a clock).
 */
async function recallableBuild(
  registry: RegistryContext,
  project: string,
  id: string,
): Promise<WakeTarget | null> {
  let build: BuildRecord;
  try {
    build = await getBuild(registry, project, id);
  } catch (error) {
    /* Not a build id at all, or one nothing was ever recorded under: the same
       answer either way. */
    if (isScafoError(error) && (error.code === "not-found" || error.code === "invalid-slug")) {
      return null;
    }
    throw error;
  }

  if (build.environment === undefined) return null;
  const env = await readEnvironment(registry, project, build.environment);
  if (env === null || env.retiredAt !== undefined) return null;

  const policy = resolveParkPolicy(env);
  if (!recalls(policy)) return null;

  return { kind: "build", project, env, build, policy };
}

/** Whether the policy recalls superseded builds at all. */
function recalls(policy: ResolvedParkPolicy): boolean {
  return policy.recallBuilds && policy.buildIdleS > 0;
}

/**
 * Whether a build wake still inside its window names a build that is really
 * there. The record is read rather than trusted: a stamp outlives the build the
 * reaper took, and one pointing at nothing wakes nothing.
 */
async function hasFreshRecall(
  registry: RegistryContext,
  project: string,
  env: EnvironmentRecord,
  policy: ResolvedParkPolicy,
): Promise<boolean> {
  if (!recalls(policy)) return false;

  const now = nowDate(registry).getTime();
  for (const [id, at] of await listBuildWakes(registry, project, env.name)) {
    if (now - at.getTime() >= policy.buildIdleS * 1000) continue;

    try {
      await getBuild(registry, project, id);
      return true;
    } catch (error) {
      if (!isScafoError(error) || error.code !== "not-found") throw error;
    }
  }
  return false;
}
