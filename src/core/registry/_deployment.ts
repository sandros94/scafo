/* Internal monotonic notice that celld moved an environment's current deployment. */

import type { BuildRecord, EnvironmentRecord } from "../types/registry.ts";
import { requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { buildKey, environmentKey } from "./paths.ts";
import { ScafoError } from "../error.ts";

export interface DeploymentUpdate {
  environment: EnvironmentRecord;
  revision: number;
}

/**
 * Advances an environment's deployment revision after celld publishes.
 *
 * The record deliberately carries no build or celld version. Concurrent writers
 * retry against the latest value, so each successful publication increments the
 * monotonic notice instead of restoring a stale claimed version.
 */
export async function recordDeployment(
  ctx: RegistryContext,
  project: string,
  env: string,
  buildId: string,
  opts?: { signal?: AbortSignal },
): Promise<DeploymentUpdate> {
  await requireJson<BuildRecord>(ctx, buildKey(project, buildId));
  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      const previous = deploymentRevision(current) ?? 0;
      if (previous >= Number.MAX_SAFE_INTEGER) {
        throw new ScafoError("invalid-input", "Invalid deployment revision", {
          detail: `environment "${env}" has a malformed or exhausted deployment revision`,
        });
      }
      return {
        ...current,
        deployment: {
          revision: previous + 1,
          deployedAt: nowIso(ctx),
        },
      };
    },
    opts,
  );
  const revision = deploymentRevision(updated.value);
  if (revision === null)
    throw new ScafoError("invalid-input", "Deployment revision was not stored");
  return {
    environment: updated.value,
    revision,
  };
}

/** Validates and reads the non-selectable deployment notice from registry input. */
export function deploymentRevision(environment: EnvironmentRecord): number | null {
  const deployment = environment.deployment;
  if (deployment === null) return null;
  if (
    !Number.isSafeInteger(deployment.revision) ||
    deployment.revision <= 0 ||
    typeof deployment.deployedAt !== "string" ||
    !Number.isFinite(Date.parse(deployment.deployedAt))
  ) {
    throw new ScafoError("invalid-input", "Invalid deployment revision", {
      detail: `environment "${environment.name}" has a malformed deployment revision`,
    });
  }
  return deployment.revision;
}
