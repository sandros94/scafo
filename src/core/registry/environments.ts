/* Environments and their configuration. */

import { ScafoError } from "../error.ts";
import { assertReplicas } from "../placement/replicas.ts";
import { assertSelector } from "../placement/selector.ts";
import type { EnvironmentRecord, NodeSelector, ReplicaCount } from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, requireJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { environmentKey, environmentsPrefix, fleetPrefix } from "./paths.ts";
import { getProject } from "./projects.ts";

export interface CreateEnvironmentInput {
  name: string;
  /**
   * How many nodes should serve it. Left absent it runs on every node that may,
   * which is what every environment that never asked keeps doing.
   */
  replicas?: ReplicaCount;
  /**
   * Which nodes may serve it, by the labels they carry. Left absent it runs
   * unconstrained, on whichever live nodes the coordinator picks.
   */
  nodeSelector?: NodeSelector;
}

/**
 * Creates an environment under an existing project, or returns the existing one
 * when its immutable identity (name, prefix) matches — settings
 * beyond that identity apply on first creation only, so retried creates stay
 * idempotent no matter how the environment has been used since. `prefix` is
 * fixed at creation and never moves. An identity mismatch throws
 * `ScafoError("immutable")`.
 */
export async function createEnvironment(
  ctx: RegistryContext,
  project: string,
  input: CreateEnvironmentInput,
): Promise<EnvironmentRecord> {
  await getProject(ctx, project);
  if (input.replicas !== undefined) assertReplicas(input.replicas);
  if (input.nodeSelector !== undefined) assertSelector(input.nodeSelector);

  const key = environmentKey(project, input.name);
  const record: EnvironmentRecord = {
    v: 1,
    name: input.name,
    prefix: fleetPrefix(project, input.name),
    deployment: null,
    domains: [],
    createdAt: nowIso(ctx),
  };
  if (input.replicas !== undefined) record.replicas = input.replicas;
  if (input.nodeSelector !== undefined) record.nodeSelector = { ...input.nodeSelector };

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<EnvironmentRecord>(ctx, key);
    if (deepEqual(identity(existing.value), identity(record))) return existing.value;
    throw new ScafoError("immutable", "Environment already exists", {
      detail: `"${input.name}" exists in project "${project}" with different settings`,
      cause: error,
    });
  }
}

export async function getEnvironment(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<EnvironmentRecord> {
  const found = await requireJson<EnvironmentRecord>(ctx, environmentKey(project, env));
  return found.value;
}

/** Names of every environment of `project`, lexicographically sorted. */
export async function listEnvironments(ctx: RegistryContext, project: string): Promise<string[]> {
  const prefix = environmentsPrefix(project);
  return namesFromKeys(await ctx.store.list(prefix), prefix);
}

/* Set at creation and never rewritten, so they identify the record. Everything
   else (deployment, domains, replicas, nodeSelector) is mutable state and must
   not break create-retry idempotency. */
function identity(record: EnvironmentRecord): Pick<EnvironmentRecord, "v" | "name" | "prefix"> {
  return { v: record.v, name: record.name, prefix: record.prefix };
}
