/*
 * Internal: the `/v1/projects` routes — the projects of a fleet, read and
 * administered through a node.
 *
 * Every route here is operator-authed, like `/v1/operators`: a machine's own
 * token authenticates and is then refused, because a node daemon that has been
 * taken over must not be able to stop its installation's tenants.
 *
 * AND EVERY WRITE HERE IS ADMIN-ONLY, which is the part worth reading. Blocking
 * a project is a FULL STOP — it refuses serving and deploys at once — so
 * it is the fleet's decision about a tenant rather than a tenant's about itself.
 * An operator-tier key that reaches the project for every other verb is refused
 * here, and the refusal is not a formality: a tenant who could lift their own
 * block would make the block worth nothing, and the case the verb exists for —
 * a downstream platform stopping a project over an unpaid invoice — is exactly
 * the case where the tenant would want to.
 *
 * The LABELS verb carries the same rule for a different reason. Labels are what
 * a platform built over scafo tags a project with — its billing account, its
 * client — so they are the platform's to write and never the tenant's, whose
 * key the platform handed out.
 *
 * The READ verb is scoped like every other listing on this API: an operator-tier
 * caller sees the projects its key reaches, marked `scoped` so a filtered answer
 * cannot be read as the whole fleet.
 */

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
  /**
   * The records themselves — WHOLE for an admin, and with the `labels` stripped
   * for everybody else. See {@link tenantView}: the labels are the fleet's notes
   * about a tenant rather than the tenant's own, so the read side matches the
   * admin-only write side. A caller cannot tell a labelled project from an
   * unlabelled one, which is deliberate.
   */
  projects: ProjectRecord[];
  /**
   * Present, and always `true`, exactly when the caller is a non-admin operator
   * — INCLUDING one whose scope reaches every project and therefore had nothing
   * hidden from it.
   *
   * The flag states that the answer is SCOPE-DEPENDENT rather than that
   * something was removed, which is the same rule `GET /v1/state` and
   * `GET /v1/operators` follow: marking it only when a filter bit would make its
   * absence mean both "everything there is" and "everything you may", and a
   * client cannot tell those apart when it matters.
   */
  scoped?: true;
}

/** Body of the block, unblock and labels routes: the project as it now stands. */
export interface ProjectResult {
  project: ProjectRecord;
}

/** Adds the project routes to `app`, each behind `guard`. */
export function registerProjectRoutes(app: H3, daemon: DaemonContext, guard: Middleware): void {
  const guarded = { middleware: [guard] };

  /*
   * WHAT PROJECTS THERE ARE, narrowed to what this caller may know — and each
   * one narrowed to what it may know ABOUT it.
   *
   * On a multi-tenant fleet the unfiltered list is the TENANT LIST, so WHICH
   * records come back is decided by the same `canReachProject` every other
   * boundary answers from — one rule, not two. An admin is not a tenant and gets
   * the lot, untouched.
   */
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

  /*
   * The full stop. A plain CAS update on one record, so ANY node carries it out
   * itself — there is nothing here two nodes doing it at once could corrupt, and
   * no lease to wait for.
   *
   * It states an intent and nothing more: every node stops serving the project
   * on its next pass, by the same machinery a retirement goes through, and
   * nothing underneath the project is touched.
   */
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

  /* The way back, and there is no grace on it: a block is a decision an admin
     must be able to take back with one call, and everything it stopped is still
     exactly where it was. */
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

  /*
   * What somebody says this project IS, replaced wholesale.
   *
   * No audit event, deliberately: `project.blocked` records an act that changes
   * what a fleet SERVES, and a label is a note a downstream platform keeps for
   * itself. Recording every tag write would fill the audit stream with a
   * platform's own bookkeeping and bury the two lines worth reading.
   */
  app.post(
    `${PROJECTS_PATH}/:project/labels`,
    async (event): Promise<ProjectResult> => {
      const [, slug] = await adminTarget(daemon, event);
      const labels = await readLabels(event, daemon.config.api.jsonBytes);

      /* Read first, so a project that is not there is a 404 rather than whatever
         the update's own missing-record failure happens to look like. */
      await getProject(daemon.registry, slug);
      return { project: await setProjectLabels(daemon.registry, slug, labels) };
    },
    guarded,
  );
}

/* ---------------------------------------------------------------- internals */

/**
 * One project as a NON-ADMIN caller may see it: everything about the project,
 * minus what the fleet wrote about the tenant.
 *
 * THE READ SIDE HAS TO MATCH THE WRITE SIDE, and the labels are the whole of the
 * difference. They are admin-only to write precisely because they are the
 * PLATFORM's notes rather than the project's own — a billing account, a client's
 * legal name, a plan — and on the dunning path this file's block verb exists for
 * they may very well say why this tenant is about to be stopped. Handing them
 * back on the read would publish every one of those to the tenant they are
 * about, which is the same disclosure the write rule refuses, made one route
 * over.
 *
 * THE FIELD IS STRIPPED, NOT EMPTIED. An empty map would be a second spelling of
 * "no labels", and a client that learned to read one would misread the other; it
 * would also leak the one bit that is left — whether there are notes at all —
 * which is exactly what somebody being quietly dunned would read something into.
 * A labelled project and an unlabelled one come back byte-identical here.
 *
 * `blocked` DELIBERATELY STAYS. It is the tenant's own project and they are
 * already living the refusals it causes; hiding it would leave them debugging a
 * deploy that fails for no visible reason, which helps nobody and conceals
 * nothing — the refusals name the block anyway.
 */
function tenantView(project: ProjectRecord): ProjectRecord {
  const { labels: _labels, ...rest } = project;
  return rest;
}

/**
 * The `:project` a write route was matched on, once the caller has been shown to
 * be an ADMIN of this fleet.
 *
 * BOTH CHECKS, IN THIS ORDER, and the order is the disclosure rule. The SCOPE is
 * checked first, so a caller that may not name this project at all is refused by
 * the boundary that says nothing about projects outside its reach — it never
 * learns whether the project exists, let alone that it is administered. Only a
 * caller that reaches the project meets the TIER refusal, which names the rule
 * plainly because there is nothing left to withhold from somebody who is already
 * inside.
 *
 * Throws `ScafoError("auth-scope")` for both.
 */
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

/**
 * The label map a request carries.
 *
 * SHAPE ONLY — a JSON object of strings — because core never interprets a key or
 * a value (see `ProjectRecord.labels`) and so has no opinion about which ones
 * are meaningful. What it does have an opinion about is the type: a number or a
 * nested object here would round-trip through the record as something the next
 * reader has to guess at.
 */
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
