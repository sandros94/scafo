/* Project registry operations: idempotent creation, configuration, blocking,
   and labels. Readers enforce blocking without deleting records. */

import { ScafoError } from "../error.ts";
import type { PlacementStrategy, ProjectRecord } from "../types/registry.ts";
import type { RetryOptions } from "../utils/backoff.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, readJson, requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { projectKey, projectsPrefix } from "./paths.ts";

export interface CreateProjectInput {
  slug: string;
  placement?: PlacementStrategy;
  previewDefaults?: ProjectRecord["previewDefaults"];
}

/** Creates a project or returns existing identity unchanged; stamps only first creation. */
export async function createProject(
  ctx: RegistryContext,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const key = projectKey(input.slug);
  const record: ProjectRecord = {
    v: 1,
    slug: input.slug,
    placement: input.placement ?? "auto",
    createdAt: nowIso(ctx),
  };
  if (input.previewDefaults !== undefined) record.previewDefaults = input.previewDefaults;

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    /* Existing mutable settings win, preserving create idempotence. */
    const existing = await requireJson<ProjectRecord>(ctx, key);
    return existing.value;
  }
}

export async function getProject(ctx: RegistryContext, slug: string): Promise<ProjectRecord> {
  const found = await requireJson<ProjectRecord>(ctx, projectKey(slug));
  return found.value;
}

/** Project record, or null when absent. */
export async function findProject(
  ctx: RegistryContext,
  slug: string,
): Promise<ProjectRecord | null> {
  const found = await readJson<ProjectRecord>(ctx, projectKey(slug));
  return found?.value ?? null;
}

/** Whether an existing project is blocked; absent projects are not blocked. */
export async function isProjectBlocked(ctx: RegistryContext, slug: string): Promise<boolean> {
  return (await findProject(ctx, slug))?.blocked === true;
}

/** Throws `project-blocked` for a blocked project; authorization is checked earlier. */
export function assertProjectUnblocked(project: ProjectRecord): void {
  if (project.blocked !== true) return;

  throw new ScafoError("project-blocked", "This project is blocked", {
    detail:
      `"${project.slug}" has been blocked by an admin of this fleet: it is served nowhere and ` +
      `accepts no deploys until the block is lifted, and nothing of it has been deleted — ` +
      `ask whoever administers this installation`,
  });
}

/** Sets the reversible block flag; absent projects remain absent. */
export async function blockProject(ctx: RegistryContext, slug: string): Promise<ProjectRecord> {
  return updateProject(ctx, slug, (current) => ({ ...current, blocked: true }));
}

/** Removes the block flag; idempotent. */
export async function unblockProject(ctx: RegistryContext, slug: string): Promise<ProjectRecord> {
  return updateProject(ctx, slug, ({ blocked: _blocked, ...rest }) => rest);
}

/** Replaces labels wholesale; an empty map removes the field. */
export async function setProjectLabels(
  ctx: RegistryContext,
  slug: string,
  labels: Record<string, string>,
): Promise<ProjectRecord> {
  const wanted = { ...labels };
  return updateProject(ctx, slug, ({ labels: _labels, ...rest }) =>
    Object.keys(wanted).length === 0 ? rest : { ...rest, labels: wanted },
  );
}

/** Slugs of every project in the registry, lexicographically sorted. */
export async function listProjects(ctx: RegistryContext): Promise<string[]> {
  const prefix = projectsPrefix();
  const keys = await ctx.store.list(prefix);
  const slugs: string[] = [];

  for (const key of keys) {
    if (!key.startsWith(prefix) || !key.endsWith("/project.json")) continue;
    const slug = key.slice(prefix.length, -"/project.json".length);
    if (slug.length > 0 && !slug.includes("/")) slugs.push(slug);
  }
  return slugs;
}

/** Project records in slug order; records deleted after listing are omitted. */
export async function listProjectRecords(ctx: RegistryContext): Promise<ProjectRecord[]> {
  const records: ProjectRecord[] = [];
  for (const slug of await listProjects(ctx)) {
    const found = await findProject(ctx, slug);
    if (found !== null) records.push(found);
  }
  return records;
}

/**
 * Read-modify-write of a project. `v` and `slug` identify the record and may not
 * be changed; doing so throws `ScafoError("immutable")`.
 */
export async function updateProject(
  ctx: RegistryContext,
  slug: string,
  mutate: (current: ProjectRecord) => ProjectRecord | Promise<ProjectRecord>,
  opts?: RetryOptions,
): Promise<ProjectRecord> {
  const updated = await updateJson<ProjectRecord>(
    ctx,
    projectKey(slug),
    async (current) => {
      const next = await mutate(current);
      if (next.v !== current.v || next.slug !== current.slug) {
        throw new ScafoError("immutable", "Project identity cannot be changed", {
          detail: `"${slug}" must keep v ${String(current.v)} and slug "${current.slug}"`,
        });
      }
      return next;
    },
    opts,
  );
  return updated.value;
}
