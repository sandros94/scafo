/* Operator-authenticated project routes. Reads are scope-filtered; blocking and
   fleet-owned labels require admin. */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import { canReachProject, type TrustedOperator } from "../core/registry/operators.ts";
import {
  blockProject,
  getProject,
  listProjectRecords,
  setProjectLabels,
  unblockProject,
} from "../core/registry/projects.ts";
import type { ProjectRecord } from "../core/types/registry.ts";
import type { DaemonContext } from "./app.ts";
import { nodeIdentity, operatorIdentity } from "./middleware.ts";
import { assertProjectScope } from "./_scope.ts";
import { readJsonBody } from "./_json.ts";

/** Where the project surface lives. */
export const PROJECTS_PATH: string = "/v1/projects";

/** Body of `GET /v1/projects`: the projects the caller may see, in slug order. */
export interface ProjectsResult {
  /** Admin records, or scope-visible records with fleet-owned labels omitted. */
  projects: ProjectRecord[];
  /** `true` for scope-dependent non-admin results. */
  scoped?: true;
}

/** Body of the block, unblock and labels routes: the project as it now stands. */
export interface ProjectResult {
  project: ProjectRecord;
}

/** Adds the project routes to `app`, each behind `guard`. */
export function registerProjectRoutes(app: H3, daemon: DaemonContext, guard: Middleware): void {
  const guarded = { middleware: [guard] };

  /* Non-admin callers receive only reachable projects and no fleet labels. */
  app.get(
    PROJECTS_PATH,
    async (event): Promise<ProjectsResult> => {
      const caller = requireCaller(event);
      const projects = await listProjectRecords(daemon.registry);
      if (caller.role === "admin") return { projects };

      return {
        projects: projects
          .filter((project) => canReachProject(caller, project.slug))
          .map((project) => tenantView(project)),
        scoped: true,
      };
    },
    guarded,
  );

  /* Blocking is one CAS update; reconciliation stops serving it. */
  app.post(
    `${PROJECTS_PATH}/:project/block`,
    async (event): Promise<ProjectResult> => {
      const [caller, slug] = await adminTarget(daemon, event);
      const project = await blockProject(daemon.registry, slug);

      daemon.observability?.emit({ type: "project.blocked", actor: caller.id, project: slug });
      return { project };
    },
    guarded,
  );

  /* Unblocking immediately restores the prior desired state. */
  app.post(
    `${PROJECTS_PATH}/:project/unblock`,
    async (event): Promise<ProjectResult> => {
      const [caller, slug] = await adminTarget(daemon, event);
      const project = await unblockProject(daemon.registry, slug);

      daemon.observability?.emit({ type: "project.unblocked", actor: caller.id, project: slug });
      return { project };
    },
    guarded,
  );

  /* Fleet metadata is replaced wholesale and does not emit operational events. */
  app.post(
    `${PROJECTS_PATH}/:project/labels`,
    async (event): Promise<ProjectResult> => {
      const [, slug] = await adminTarget(daemon, event);
      const labels = await readLabels(event, daemon.config.api.jsonBytes);

      /* Preserve the explicit missing-project response. */
      await getProject(daemon.registry, slug);
      return { project: await setProjectLabels(daemon.registry, slug, labels) };
    },
    guarded,
  );
}

/* ---------------------------------------------------------------- internals */

/** Removes fleet-owned labels for a tenant view; blocked state remains visible. */
function tenantView(project: ProjectRecord): ProjectRecord {
  const { labels: _labels, ...rest } = project;
  return rest;
}

/** Resolves an admin write target, checking project reach before admin tier. */
async function adminTarget(
  daemon: DaemonContext,
  event: H3Event,
): Promise<[caller: TrustedOperator, project: string]> {
  const caller = requireCaller(event);
  const slug = event.context.params?.project ?? "";

  const identity = nodeIdentity(event);
  if (identity === undefined) {
    throw new ScafoError("auth-scope", "Not an operator of this fleet");
  }
  assertProjectScope(identity, slug);
  if (caller.role !== "admin") {
    throw new ScafoError("auth-scope", "Only an admin administers a project", {
      detail:
        `"${caller.id}" is an ${caller.role}-tier key: it may deploy to "${slug}" and run its ` +
        `environments, and it may not block it or label it — those are decisions this fleet ` +
        `makes about a project rather than decisions taken inside one; ask an admin of this ` +
        `fleet`,
    });
  }
  return [caller, slug];
}

/**
 * The caller as the guard read it. Every route here stands behind
 * `requireOperatorToken`, so its absence is a wiring mistake rather than
 * something a request can cause.
 */
function requireCaller(event: H3Event): TrustedOperator {
  const caller = operatorIdentity(event);
  if (caller !== undefined) return caller;

  throw new ScafoError("auth-scope", "Not an operator of this fleet", {
    detail: `"${nodeIdentity(event)?.nodeId ?? "the caller"}" was not resolved to an operator key`,
  });
}

/** Reads caller-owned label strings; core does not interpret keys or values. */
async function readLabels(event: H3Event, maxBytes: number): Promise<Record<string, string>> {
  const parsed = await readJsonBody(event, { maxBytes });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw malformed("the body must hold a JSON object");
  }

  const labels = (parsed as { labels?: unknown }).labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) {
    throw malformed(`"labels" must hold a JSON object, and an empty one clears them`);
  }

  const wanted: Record<string, string> = {};
  for (const [name, value] of Object.entries(labels)) {
    if (typeof value !== "string") {
      throw malformed(`"labels.${name}" must be a string`);
    }
    wanted[name] = value;
  }
  return wanted;
}

function malformed(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}
