/* Environments and the pointers that steer traffic: alias flips, rollbacks, splits. */

import { ScaloError } from "../error.ts";
import { assertReplicas } from "../placement/replicas.ts";
import { assertSelector } from "../placement/selector.ts";
import type {
  BuildRecord,
  EnvironmentRecord,
  NodeSelector,
  PlacementStrategy,
  ReplicaCount,
  ScaloWarning,
  SplitEntry,
  VarsetEnvelope,
} from "../types/registry.ts";
import { deepEqual, isCasConflict, namesFromKeys } from "./_shared.ts";
import { createJson, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { buildKey, environmentKey, environmentsPrefix, fleetPrefix, varsetKey } from "./paths.ts";
import { getProject } from "./projects.ts";

export interface CreateEnvironmentInput {
  name: string;
  placement?: PlacementStrategy;
  ephemeral?: boolean;
  varset?: string;
  idleTtlS?: number;
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

/** An environment after a change, with any advisories the change raised. */
export interface EnvironmentUpdate {
  environment: EnvironmentRecord;
  warnings: ScaloWarning[];
}

/**
 * Creates an environment under an existing project, or returns the existing one
 * when its immutable identity (name, prefix, `ephemeral`) matches — settings
 * beyond that identity apply on first creation only, so retried creates stay
 * idempotent no matter how the environment has been used since. `prefix` is
 * fixed at creation and never moves. An identity mismatch throws
 * `ScaloError("immutable")`.
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
    alias: null,
    split: null,
    domains: [],
    placement: input.placement ?? "auto",
    ephemeral: input.ephemeral ?? false,
    createdAt: nowIso(ctx),
  };
  if (input.varset !== undefined) record.varset = input.varset;
  if (input.idleTtlS !== undefined) record.idleTtlS = input.idleTtlS;
  if (input.replicas !== undefined) record.replicas = input.replicas;
  if (input.nodeSelector !== undefined) record.nodeSelector = { ...input.nodeSelector };

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    const existing = await requireJson<EnvironmentRecord>(ctx, key);
    if (deepEqual(identity(existing.value), identity(record))) return existing.value;
    throw new ScaloError("immutable", "Environment already exists", {
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
 * Points the environment at `buildId`, remembering the outgoing build so
 * {@link rollbackAlias} is a single operation. Clears any active split.
 *
 * The referent is read first: an alias never points at a build that is not there.
 * A build that cannot pick up the environment's varset at runtime is reported as
 * a warning, not an error — the flip still happens.
 */
export async function flipAlias(
  ctx: RegistryContext,
  project: string,
  env: string,
  buildId: string,
): Promise<EnvironmentUpdate> {
  const build = await requireJson<BuildRecord>(ctx, buildKey(project, buildId));

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      const previous = current.alias?.build;
      return {
        ...current,
        alias: {
          build: buildId,
          ...(previous === undefined ? {} : { previous }),
          flippedAt: nowIso(ctx),
        },
        split: null,
      };
    },
  );

  return { environment: updated.value, warnings: varsetWarnings(updated.value, build.value) };
}

/**
 * Swaps the current and previous builds. Throws `ScaloError("not-found")` when
 * there is nothing to roll back to.
 */
export async function rollbackAlias(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<EnvironmentRecord> {
  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      const previous = current.alias?.previous;
      if (current.alias === null || previous === undefined) {
        throw new ScaloError("not-found", "No build to roll back to", {
          detail: `environment "${env}" of project "${project}" has no previous build`,
        });
      }
      return {
        ...current,
        alias: { build: previous, previous: current.alias.build, flippedAt: nowIso(ctx) },
      };
    },
  );
  return updated.value;
}

/**
 * Replaces the traffic split. Every referenced build must exist, weights are
 * whole numbers of at least 1 summing to 100, and at least two legs are needed.
 * Passing null clears the split. The alias is left untouched: it remains the
 * primary pointer (and rollback target) while the split, when non-null,
 * governs traffic weighting.
 */
export async function setSplit(
  ctx: RegistryContext,
  project: string,
  env: string,
  entries: SplitEntry[] | null,
): Promise<EnvironmentRecord> {
  if (entries !== null) {
    assertSplit(entries);
    for (const entry of entries) {
      await requireJson<BuildRecord>(ctx, buildKey(project, entry.build));
    }
  }

  const split = entries === null ? null : entries.map((entry) => ({ ...entry }));
  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => ({ ...current, split }),
  );
  return updated.value;
}

/**
 * Points the environment at an existing varset. Warns when the build currently
 * serving traffic cannot pick the new values up without a rebuild.
 */
export async function setEnvironmentVarset(
  ctx: RegistryContext,
  project: string,
  env: string,
  varsetId: string,
): Promise<EnvironmentUpdate> {
  await requireJson<VarsetEnvelope>(ctx, varsetKey(project, varsetId));

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => ({ ...current, varset: varsetId }),
  );

  const aliased = updated.value.alias?.build;
  if (aliased === undefined) return { environment: updated.value, warnings: [] };

  const build = await readJson<BuildRecord>(ctx, buildKey(project, aliased));
  const warnings = build === null ? [] : varsetWarnings(updated.value, build.value);
  return { environment: updated.value, warnings };
}

/* Set at creation and never rewritten, so they identify the record. Everything
   else (alias, split, domains, varset, placement, idleTtlS, replicas,
   nodeSelector) is mutable state and must not break create-retry idempotency. */
function identity(
  record: EnvironmentRecord,
): Pick<EnvironmentRecord, "v" | "name" | "prefix" | "ephemeral"> {
  return { v: record.v, name: record.name, prefix: record.prefix, ephemeral: record.ephemeral };
}

function varsetWarnings(environment: EnvironmentRecord, build: BuildRecord): ScaloWarning[] {
  if (build.runtimeConfigurable) return [];

  const envVarset = environment.varset ?? null;
  const buildVarset = build.builtWithVarset ?? null;
  if (envVarset === buildVarset) return [];

  return [
    {
      code: "build-not-runtime-configurable",
      detail:
        `build "${build.id}" was built against varset ${describe(buildVarset)} and cannot pick ` +
        `up configuration at runtime, but environment "${environment.name}" uses ` +
        `${describe(envVarset)}; rebuild to apply it`,
    },
  ];
}

function describe(varset: string | null): string {
  return varset === null ? "no varset" : `"${varset}"`;
}

function assertSplit(entries: SplitEntry[]): void {
  const invalid = (detail: string): ScaloError =>
    new ScaloError("invalid-input", "Invalid traffic split", { detail });

  if (entries.length < 2) throw invalid("a split needs at least two builds");

  let total = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.weight) || entry.weight < 1) {
      throw invalid(
        `weight ${String(entry.weight)} for build "${entry.build}" must be an integer of at least 1`,
      );
    }
    total += entry.weight;
  }
  if (total !== 100) throw invalid(`weights sum to ${String(total)}, they must sum to 100`);
}
