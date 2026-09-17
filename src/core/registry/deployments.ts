/* Deployments are immutable: they are created, read and listed, never updated. */

import { ScafoError } from "../error.ts";
import type { DeploymentInput, DeploymentRecord } from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { deploymentKey, deploymentsPrefix } from "./paths.ts";

/**
 * Records a deployment. Re-creating the same deployment is idempotent as long as every
 * identity field matches; otherwise `ScafoError("immutable")`. Deletion is the reaper's job.
 */
export async function createDeployment(
  ctx: RegistryContext,
  project: string,
  input: DeploymentInput,
): Promise<DeploymentRecord> {
  const key = deploymentKey(project, input.version);
  const record: DeploymentRecord = {
    v: 1,
    version: input.version,
    createdAt: nowIso(ctx),
  };
  if (input.source !== undefined) record.source = input.source;
  if (input.oidc !== undefined) record.oidc = input.oidc;

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<DeploymentRecord>(ctx, key);
    if (deepEqual(identity(existing.value), identity(record))) return existing.value;
    throw new ScafoError("immutable", "Deployment already exists", {
      detail: `"${input.version}" exists in project "${project}" with different contents`,
      cause: error,
    });
  }
}

export async function getDeployment(
  ctx: RegistryContext,
  project: string,
  version: string,
): Promise<DeploymentRecord> {
  const found = await requireJson<DeploymentRecord>(ctx, deploymentKey(project, version));
  return found.value;
}

/** Versions of every deployment of `project`, lexicographically sorted. */
export async function listDeployments(ctx: RegistryContext, project: string): Promise<string[]> {
  const prefix = deploymentsPrefix(project);
  return namesFromKeys(await ctx.store.list(prefix), prefix);
}

/*
 * Everything but `createdAt`: a version is the digest of what was published, so
 * recording the same deployment again differs only in when it was first recorded.
 */
function identity(record: DeploymentRecord): Omit<DeploymentRecord, "createdAt"> {
  const { createdAt: _createdAt, ...rest } = record;
  return rest;
}
