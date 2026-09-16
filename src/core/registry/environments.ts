/* Environments and their configuration. */

import { ScafoError } from "../error.ts";
import { assertReplicas } from "../placement/replicas.ts";
import { assertSelector } from "../placement/selector.ts";
import type { EnvironmentRecord, NodeSelector, ReplicaCount } from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { environmentKey, environmentsPrefix, fleetPrefix } from "./paths.ts";
import { getProject } from "./projects.ts";
import { getVarset } from "./varsets.ts";

export interface CreateEnvironmentInput {
  name: string;
  ephemeral?: boolean;
  /** Name of the project varset this environment's deploys carry. */
  varset?: string;
  /**
   * How many nodes should serve it. Left absent the environment takes the
   * default its kind implies, which is what every environment created before
   * this setting existed keeps doing.
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
 * when its immutable identity (name, prefix, `ephemeral`) matches — settings
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
    ephemeral: input.ephemeral ?? false,
    createdAt: nowIso(ctx),
  };
  if (input.varset !== undefined) record.varset = input.varset;
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

/**
 * Points the environment at a varset of the same project by name, or at none
 * with `null`. The varset has to exist first, so a misspelled name is refused
 * with `not-found` instead of being stored for a deploy to trip over.
 *
 * Nothing running changes: a varset is carried by deploys, so the environment's
 * next one is where this lands.
 */
export async function setEnvironmentVarset(
  ctx: RegistryContext,
  project: string,
  env: string,
  name: string | null,
): Promise<EnvironmentRecord> {
  if (name !== null) await getVarset(ctx, project, name);

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      if (name === null) {
        const { varset: _varset, ...rest } = current;
        return rest;
      }
      return { ...current, varset: name };
    },
  );

  return updated.value;
}

/* Set at creation and never rewritten, so they identify the record. Everything
   else (deployment, domains, varset, replicas, nodeSelector) is mutable state
   and must not break create-retry idempotency. */
function identity(
  record: EnvironmentRecord,
): Pick<EnvironmentRecord, "v" | "name" | "prefix" | "ephemeral"> {
  return { v: record.v, name: record.name, prefix: record.prefix, ephemeral: record.ephemeral };
}
