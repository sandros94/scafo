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

  /* What the flip took away, captured from the write that took it: a flip is a
     full cutover, and an operator who was running a split has to be told that
     this ended it. Held rather than re-read because the last run of the mutator
     is the one that landed. */
  const replaced: { split: SplitEntry[] | null } = { split: null };

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      const previous = current.alias?.build;
      replaced.split = current.split;
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

  return {
    environment: updated.value,
    warnings: [
      ...splitClearedWarnings(replaced.split, buildId),
      ...varsetWarnings(updated.value, build.value),
    ],
  };
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

/** What {@link canarySplit} is asked to put in front of the alias. */
export interface CanaryInput {
  /** Build the canary share is given to; must exist and must not be the alias. */
  build: string;
  /** Whole number from 1 to 99 — the share the canary takes, the alias keeps the rest. */
  weight: number;
}

/**
 * Splits traffic between the build the alias points at and a new one: the canary
 * takes `weight`, the alias keeps `100 - weight`, and the alias itself does not
 * move. Promoting the canary is an ordinary {@link flipAlias}, which clears the
 * split; abandoning it is {@link setSplit} with null.
 *
 * The alias is read and the split written in ONE conditional update, so a canary
 * can never be weighed against an alias that has since been flipped.
 *
 * Throws `ScaloError("invalid-input")` when the environment has no alias yet —
 * there is nothing to hold the other side of the split, and the first build of
 * an environment is deployed with a flip rather than eased in — and when the
 * canary build is the one the alias already names.
 */
export async function canarySplit(
  ctx: RegistryContext,
  project: string,
  env: string,
  input: CanaryInput,
): Promise<EnvironmentRecord> {
  if (!Number.isInteger(input.weight) || input.weight < 1 || input.weight > 99) {
    throw new ScaloError("invalid-input", "Invalid canary weight", {
      detail:
        `a canary takes a whole number from 1 to 99 percent of the traffic, leaving the rest ` +
        `to the alias, got ${String(input.weight)}`,
    });
  }
  await requireJson<BuildRecord>(ctx, buildKey(project, input.build));

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      const alias = current.alias;
      if (alias === null) {
        throw new ScaloError("invalid-input", "Environment has no alias to split against", {
          detail:
            `"${project}/${env}" has never been flipped, so there is no build to weigh a canary ` +
            `against; deploy this build with --flip to put it into service outright`,
        });
      }
      if (alias.build === input.build) {
        throw new ScaloError("invalid-input", "Canary is already the alias", {
          detail:
            `"${project}/${env}" already points at build "${input.build}", so splitting it ` +
            `against itself would change nothing`,
        });
      }

      const entries: SplitEntry[] = [
        { build: alias.build, weight: 100 - input.weight },
        { build: input.build, weight: input.weight },
      ];
      assertSplit(entries);
      return { ...current, split: entries };
    },
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

/**
 * What a flip that ended a split has to say for itself.
 *
 * A flip is a FULL CUTOVER, and an operator running 90/10 who flips to settle it
 * has just also stopped serving the other leg — which is usually exactly what
 * they meant, and is worth stating either way because nothing else in the answer
 * mentions the split that was there a moment ago.
 */
function splitClearedWarnings(split: SplitEntry[] | null, buildId: string): ScaloWarning[] {
  if (split === null || split.length === 0) return [];

  const legs = split.map((entry) => `"${entry.build}" at ${String(entry.weight)}%`).join(", ");
  return [
    {
      code: "split-cleared",
      detail:
        `the traffic split over ${legs} is cleared: build "${buildId}" now takes all of this ` +
        `environment's traffic, and the legs it does not name are stopped once it is ready`,
    },
  ];
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
