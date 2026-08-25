/* Builds are immutable: they are created, read and listed, never updated. */

import { ScafoError } from "../error.ts";
import type { BuildInput, BuildRecord } from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { artifactKey, buildKey, buildsPrefix } from "./paths.ts";

/**
 * Records a build. `artifact` defaults to the conventional artifact key.
 * Re-creating the same build is idempotent as long as every identity field
 * matches; otherwise `ScafoError("immutable")`. Deletion is the reaper's job.
 */
export async function createBuild(
  ctx: RegistryContext,
  project: string,
  input: BuildInput,
): Promise<BuildRecord> {
  const key = buildKey(project, input.id);
  const record: BuildRecord = {
    v: 1,
    id: input.id,
    artifact: input.artifact ?? artifactKey(project, input.id),
    runtimeConfigurable: input.runtimeConfigurable,
    createdAt: nowIso(ctx),
  };
  if (input.celldVersionId !== undefined) record.celldVersionId = input.celldVersionId;
  if (input.builtWithVarset !== undefined) record.builtWithVarset = input.builtWithVarset;
  if (input.environment !== undefined) record.environment = input.environment;
  if (input.source !== undefined) record.source = input.source;
  if (input.oidc !== undefined) record.oidc = input.oidc;

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<BuildRecord>(ctx, key);
    if (deepEqual(identity(existing.value), identity(record))) return existing.value;
    throw new ScafoError("immutable", "Build already exists", {
      detail: `"${input.id}" exists in project "${project}" with different contents`,
      cause: error,
    });
  }
}

export async function getBuild(
  ctx: RegistryContext,
  project: string,
  id: string,
): Promise<BuildRecord> {
  const found = await requireJson<BuildRecord>(ctx, buildKey(project, id));
  return found.value;
}

/** Ids of every build of `project`, lexicographically sorted. */
export async function listBuilds(ctx: RegistryContext, project: string): Promise<string[]> {
  const prefix = buildsPrefix(project);
  return namesFromKeys(await ctx.store.list(prefix), prefix);
}

/*
 * Everything but `createdAt` and `environment`: two records of the same build
 * differ only in when and where they were recorded. Build ids are content
 * stable, so deploying the same commit into a SECOND environment re-creates the
 * same id against a different fleet — an ordinary flow, not a conflict. The
 * first record's environment stands, and recall wakes the build against that
 * fleet, which is one of the fleets really holding its code.
 */
function identity(record: BuildRecord): Omit<BuildRecord, "createdAt" | "environment"> {
  const { createdAt: _createdAt, environment: _environment, ...rest } = record;
  return rest;
}
