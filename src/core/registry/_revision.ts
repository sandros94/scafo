/* Internal monotonic notice that celld moved an application's current deployment. */

import type { ApplicationRecord, DeploymentRecord } from "../types/registry.ts";
import { updateApplication } from "./applications.ts";
import { requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { deploymentKey } from "./paths.ts";
import { ScafoError } from "../error.ts";

export interface DeploymentUpdate {
  application: ApplicationRecord;
  revision: number;
}

/**
 * Advances an application's deployment revision after celld publishes.
 *
 * The record deliberately names no version. Concurrent writers retry against
 * the latest value, so each successful deployment increments the monotonic
 * notice instead of restoring a stale claimed version.
 */
export async function recordRevision(
  ctx: RegistryContext,
  application: string,
  version: string,
  opts?: { signal?: AbortSignal },
): Promise<DeploymentUpdate> {
  await requireJson<DeploymentRecord>(ctx, deploymentKey(application, version));
  const updated = await updateApplication(
    ctx,
    application,
    (current) => {
      const previous = deploymentRevision(current) ?? 0;
      if (previous >= Number.MAX_SAFE_INTEGER) {
        throw new ScafoError("invalid-input", "Invalid deployment revision", {
          detail: `application "${application}" has a malformed or exhausted deployment revision`,
        });
      }
      return {
        ...current,
        deployment: { revision: previous + 1, deployedAt: nowIso(ctx) },
      };
    },
    opts,
  );
  const revision = deploymentRevision(updated);
  if (revision === null)
    throw new ScafoError("invalid-input", "Deployment revision was not stored");
  return { application: updated, revision };
}

/** Validates and reads the non-selectable deployment notice from registry input. */
export function deploymentRevision(application: ApplicationRecord): number | null {
  const deployment = application.deployment;
  if (deployment === null) return null;
  /* The record is bucket input: a missing or non-object notice must surface as
     a typed error, never as a TypeError out of the field reads below. */
  if (
    typeof deployment !== "object" ||
    !Number.isSafeInteger(deployment.revision) ||
    deployment.revision <= 0 ||
    typeof deployment.deployedAt !== "string" ||
    !Number.isFinite(Date.parse(deployment.deployedAt))
  ) {
    throw new ScafoError("invalid-input", "Invalid deployment revision", {
      detail: `application "${application.name}" has a malformed deployment revision`,
    });
  }
  return deployment.revision;
}
