/*
 * Internal: reading back what the names in a window of counters actually are.
 *
 * A counting node attributes a host through the routing it published, and falls
 * back to a PURE, REGISTRY-FREE host grammar for everything the routing does not
 * name — a parked environment, one that is starting, one whose wake was
 * forwarded. That grammar cannot tell a build id from an environment name, nor a
 * real project from a label a crawler invented, because only the registry can.
 * So the reader checks: three listings' worth of names, and every counted pair
 * held against them.
 *
 * LISTINGS ONLY, AND THAT IS THE BUDGET. One listing for the projects, then one
 * of environments and one of builds per project the window actually counted —
 * never a record read, and never a project nothing in the window named.
 */

import { listBuilds } from "../core/registry/builds.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { listEnvironments } from "../core/registry/environments.ts";
import { listProjects } from "../core/registry/projects.ts";
import { DEFAULT_CONCURRENCY, mapConcurrent } from "../core/utils/concurrency.ts";
import type { MetricsNaming } from "./_metrics.ts";

/**
 * What the registry holds about the projects a window named.
 *
 * `wanted` is what {@link projectsCounted} answered; a name that is not a
 * project is left out of every map here, which is exactly what makes it read as
 * unmatched rather than as a project row of its own.
 */
export async function readMetricsNaming(
  ctx: RegistryContext,
  wanted: readonly string[],
): Promise<MetricsNaming> {
  const projects = new Set(await listProjects(ctx));
  const named = wanted.filter((project) => projects.has(project));

  /* Independent reads, so they overlap under the same bound every other fan-out
     in the codebase takes. */
  const held = await mapConcurrent(named, DEFAULT_CONCURRENCY, async (project) => ({
    environments: new Set(await listEnvironments(ctx, project)),
    builds: new Set(await listBuilds(ctx, project)),
  }));

  const environments = new Map<string, ReadonlySet<string>>();
  const builds = new Map<string, ReadonlySet<string>>();
  for (const [index, project] of named.entries()) {
    environments.set(project, held[index].environments);
    builds.set(project, held[index].builds);
  }
  return { projects, environments, builds };
}
