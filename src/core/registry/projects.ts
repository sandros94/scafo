import { ScaloError } from "../error.ts";
import type { PlacementStrategy, ProjectRecord } from "../types/registry.ts";
import type { RetryOptions } from "../utils/backoff.ts";
import { isCasConflict } from "./_shared.ts";
import { createJson, requireJson, updateJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { projectKey, projectsPrefix } from "./paths.ts";

export interface CreateProjectInput {
  slug: string;
  placement?: PlacementStrategy;
  previewDefaults?: ProjectRecord["previewDefaults"];
}

/**
 * Creates a project, or returns the existing one — the slug is the whole
 * identity, and settings apply on first creation only, so retried creates stay
 * idempotent. Use {@link updateProject} to change settings afterwards.
 */
export async function createProject(
  ctx: RegistryContext,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const key = projectKey(input.slug);
  const record: ProjectRecord = {
    v: 1,
    slug: input.slug,
    placement: input.placement ?? "auto",
  };
  if (input.previewDefaults !== undefined) record.previewDefaults = input.previewDefaults;

  try {
    await createJson(ctx, key, record);
    return record;
  } catch (error) {
    if (!isCasConflict(error)) throw error;

    /* The slug is the whole identity; placement and previewDefaults are mutable
       through updateProject, so an existing project wins and retried creates
       stay idempotent. */
    const existing = await requireJson<ProjectRecord>(ctx, key);
    return existing.value;
  }
}

export async function getProject(ctx: RegistryContext, slug: string): Promise<ProjectRecord> {
  const found = await requireJson<ProjectRecord>(ctx, projectKey(slug));
  return found.value;
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

/**
 * Read-modify-write of a project. `v` and `slug` identify the record and may not
 * be changed; doing so throws `ScaloError("immutable")`.
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
        throw new ScaloError("immutable", "Project identity cannot be changed", {
          detail: `"${slug}" must keep v ${String(current.v)} and slug "${current.slug}"`,
        });
      }
      return next;
    },
    opts,
  );
  return updated.value;
}
