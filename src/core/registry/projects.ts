/*
 * The projects of an installation: what one IS, and the two things an ADMIN can
 * say about one that nothing else may.
 *
 * A project is a namespace first — builds, environments, varsets and a trust
 * policy all nest under its slug — and it comes into being on the first deploy
 * that names it rather than through a create verb of its own. The record beside
 * that namespace is deliberately thin: the slug is the whole identity, and
 * everything here is either configuration the fleet reads (placement, preview
 * defaults) or a statement somebody made about the project that core stores and
 * does not interpret.
 *
 * BLOCKING IS THE ONE VERB THAT STOPS THINGS, and it is a full stop: a blocked
 * project is served nowhere, woken nowhere and deployed to by nobody, while
 * every record underneath it is left untouched. That asymmetry is the design —
 * core MEASURES and ACTUATES, and the policy that decides when to pull the lever
 * (an unpaid invoice, on a platform built over scafo) lives with whoever sends
 * the invoice. Enforcement is not here: it is at the four places that ask
 * whether something should be served, and {@link assertProjectUnblocked} is what
 * they ask with.
 */

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

/**
 * Creates a project, or returns the existing one — the slug is the whole
 * identity, and settings apply on first creation only, so retried creates stay
 * idempotent. Use {@link updateProject} to change settings afterwards.
 *
 * THE CREATION STAMP IS WRITTEN HERE AND NOWHERE ELSE, which is what makes it
 * mean what it says. A project that already exists is returned exactly as it
 * stands — so a second deploy does not restate when the project began, and a
 * record written before this field existed keeps carrying no stamp rather than
 * acquiring one dated to whenever somebody next deployed.
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
    createdAt: nowIso(ctx),
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

/**
 * The project's record, or null when there is none.
 *
 * The reading half of {@link getProject}, for the callers that ask about a
 * project they may well not find and have an answer for that case: the desired
 * state of a node reading a project deleted mid-pass, and the wake surface
 * resolving a host to a name nothing holds.
 */
export async function findProject(
  ctx: RegistryContext,
  slug: string,
): Promise<ProjectRecord | null> {
  const found = await readJson<ProjectRecord>(ctx, projectKey(slug));
  return found?.value ?? null;
}

/**
 * Whether an admin has stopped this project.
 *
 * TRUE FOR A PROJECT THAT IS NOT THERE IS WRONG, and this answers false for one:
 * "blocked" is a statement about a project, and a slug nothing holds is not a
 * project that has been stopped — it is a name. Every caller here already has an
 * answer for absence (a 404, an empty desired state), and folding the two
 * together would make a deleted project indistinguishable from a blocked one at
 * exactly the surfaces that must tell them apart.
 */
export async function isProjectBlocked(ctx: RegistryContext, slug: string): Promise<boolean> {
  return (await findProject(ctx, slug))?.blocked === true;
}

/**
 * Refuses `project` when an admin has blocked it.
 *
 * NAMED PLAINLY, because every caller that reaches this has already been shown
 * to reach the project: the deploy path checks the caller's scope before it gets
 * here, so the only person who sees this refusal is one whose own project has
 * been stopped — and they are owed the reason, or their only signal is a deploy
 * that fails for no stated cause. A caller OUTSIDE the project's scope never
 * arrives: it is refused earlier, by the boundary that says nothing about
 * projects it does not reach.
 *
 * Throws `ScafoError("project-blocked")`, which is 409 rather than 403: nothing
 * is wrong with the caller or its key, and the same request will work unchanged
 * once the block is lifted.
 */
export function assertProjectUnblocked(project: ProjectRecord): void {
  if (project.blocked !== true) return;

  throw new ScafoError("project-blocked", "This project is blocked", {
    detail:
      `"${project.slug}" has been blocked by an admin of this fleet: it is served nowhere and ` +
      `accepts no deploys until the block is lifted, and nothing of it has been deleted — ` +
      `ask whoever administers this installation`,
  });
}

/**
 * Stops the whole project, reversibly. Idempotent: blocking a blocked project
 * rewrites the same flag.
 *
 * Throws `ScafoError("not-found")` when there is no such project — a block is a
 * statement ABOUT a project and cannot bring one into being, for the same reason
 * a heartbeat cannot bring a node record into being.
 */
export async function blockProject(ctx: RegistryContext, slug: string): Promise<ProjectRecord> {
  return updateProject(ctx, slug, (current) => ({ ...current, blocked: true }));
}

/**
 * The way back, and it is one call: the flag goes and the next reconcile pass of
 * every node wants everything it wanted before.
 *
 * The field is REMOVED rather than set to false, because absent is the only
 * other state this flag has — see {@link ProjectRecord.blocked}. Idempotent:
 * unblocking a project nobody blocked is not an error, so a downstream platform
 * retrying its own pass costs nothing.
 */
export async function unblockProject(ctx: RegistryContext, slug: string): Promise<ProjectRecord> {
  return updateProject(ctx, slug, ({ blocked: _blocked, ...rest }) => rest);
}

/**
 * Replaces the project's label map wholesale.
 *
 * WHOLESALE, not merged: the caller states what the set now IS, so a label
 * dropped on their side is gone here rather than surviving forever with no way
 * to remove it. An empty map removes the field rather than storing `{}`, because
 * "no labels" is one state and not two.
 *
 * Core never reads a key or a value — see {@link ProjectRecord.labels}.
 */
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

/**
 * Every project's record, in slug order.
 *
 * A read per project on top of the listing, and it is unavoidable for the
 * question this answers: the listing gives names, and whether a project is
 * blocked, when it began and what it is labelled with are all in the record. A
 * record that vanished between the listing and the read is left out rather than
 * raised, like every other listing here.
 */
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
