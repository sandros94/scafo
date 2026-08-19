/* Internal: what the registry says this node should be serving. */

import type { DesiredEnvironment } from "../core/placement/reconcile.ts";
import { getBuild } from "../core/registry/builds.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { getEnvironment, listEnvironments } from "../core/registry/environments.ts";
import { listProjects } from "../core/registry/projects.ts";
import { getVarsetEnvelope, openVarset } from "../core/registry/varsets.ts";
import type { PlainVarset } from "../core/types/registry.ts";

/**
 * Every environment that has something to serve, with the build its alias
 * points at already resolved.
 *
 * Single-node scope: every environment of every project belongs here. An
 * environment whose alias was never flipped is left out — it has no build yet,
 * so there is nothing to run for it.
 */
export async function readDesired(registry: RegistryContext): Promise<DesiredEnvironment[]> {
  const projects = await listProjects(registry);

  const perProject = await Promise.all(
    projects.map(async (project) => {
      const names = await listEnvironments(registry, project);
      const entries = await Promise.all(
        names.map(async (name) => resolveEnvironment(registry, project, name)),
      );
      return entries.filter((entry): entry is DesiredEnvironment => entry !== null);
    }),
  );
  return perProject.flat();
}

/**
 * Opens the varset an environment points at.
 *
 * Returns null when the environment has none, and equally when this node does
 * not hold the key that would open it: a process then starts without the
 * environment's configuration rather than not starting at all.
 *
 * TODO: distributing the varset key to nodes is not implemented, so a node
 * without one silently serves an environment with no variables set. Until keys
 * are distributed, an environment that needs its varset must run on a node the
 * operator handed the key to.
 */
export async function openEnvironmentVars(
  registry: RegistryContext,
  wanted: DesiredEnvironment,
  key?: CryptoKey,
): Promise<PlainVarset | null> {
  const varsetId = wanted.varsetId;
  if (varsetId === undefined || key === undefined) return null;

  const envelope = await getVarsetEnvelope(registry, wanted.project, varsetId);
  return openVarset(envelope, key);
}

async function resolveEnvironment(
  registry: RegistryContext,
  project: string,
  name: string,
): Promise<DesiredEnvironment | null> {
  const env = await getEnvironment(registry, project, name);
  const aliased = env.alias?.build;
  if (aliased === undefined) return null;

  return {
    project,
    env,
    build: await getBuild(registry, project, aliased),
    varsetId: env.varset,
  };
}
