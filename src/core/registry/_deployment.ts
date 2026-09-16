/* Internal monotonic notice that celld moved an environment's current deployment. */

import type { BuildRecord, CarriedVarset, EnvironmentRecord } from "../types/registry.ts";
import { requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { buildKey, environmentKey } from "./paths.ts";
import { ScafoError } from "../error.ts";

export interface DeploymentUpdate {
  environment: EnvironmentRecord;
  revision: number;
}

/**
 * Advances an environment's deployment revision after celld publishes, and
 * stamps the varset that publication carried.
 *
 * The record deliberately carries no build or celld version. Concurrent writers
 * retry against the latest value, so each successful publication increments the
 * monotonic notice instead of restoring a stale claimed version.
 *
 * The notice is rewritten whole, so a publication carrying no varset clears an
 * earlier stamp: kept, it would claim an environment still deploys with
 * variables it was taken off.
 */
export async function recordDeployment(
  ctx: RegistryContext,
  project: string,
  env: string,
  buildId: string,
  opts?: { signal?: AbortSignal; varset?: CarriedVarset },
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
          ...(opts?.varset === undefined
            ? {}
            : { varset: { name: opts.varset.name, hash: opts.varset.hash } }),
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
  /* The record is bucket input: a missing or non-object notice must surface as
     a typed error, never as a TypeError out of the field reads below. */
  if (
    typeof deployment !== "object" ||
    !Number.isSafeInteger(deployment.revision) ||
    deployment.revision <= 0 ||
    typeof deployment.deployedAt !== "string" ||
    !Number.isFinite(Date.parse(deployment.deployedAt)) ||
    !isCarriedVarset(deployment.varset)
  ) {
    throw new ScafoError("invalid-input", "Invalid deployment revision", {
      detail: `environment "${environment.name}" has a malformed deployment revision`,
    });
  }
  return deployment.revision;
}

/** Whether an absent or stored varset stamp is one this build can read. */
function isCarriedVarset(value: CarriedVarset | undefined): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.name === "string" &&
    typeof value.hash === "string"
  );
}
