/* Internal: what the registry says this node should be serving. */

import { ScaloError } from "../core/error.ts";
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
 * Opens the varset an environment points at, or null when it points at none.
 *
 * Throws rather than answering null when the environment has one this node
 * cannot open — no key at all, the wrong key, or an envelope that will not
 * decrypt. A process started without the variables its environment is
 * configured with is a silent misconfiguration: it would come up, pass its
 * readiness gate and serve requests against whatever defaults its code falls
 * back to. The caller records the failure against that one environment and
 * leaves whatever already serves it running.
 */
export async function openEnvironmentVars(
  registry: RegistryContext,
  wanted: DesiredEnvironment,
  key?: CryptoKey,
): Promise<PlainVarset | null> {
  const varsetId = wanted.varsetId;
  if (varsetId === undefined) return null;

  if (key === undefined) {
    throw new ScaloError("invalid-varset", "No key for this environment's variables", {
      detail:
        `"${wanted.project}/${wanted.env.name}" is configured with varset "${varsetId}", ` +
        `which this node holds no key for: point "varsets.keyFile" at the key file, ` +
        `set SCALO_VARSET_KEY_FILE, or pass --varset-key-file`,
    });
  }

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
