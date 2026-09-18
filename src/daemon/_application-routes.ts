/* Operator-authenticated application routes. Reads are scope-filtered; blocking
   and fleet-owned labels require admin. */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import { canReachApplication, type TrustedOperator } from "../core/registry/operators.ts";
import {
  blockApplication,
  getApplication,
  listApplicationRecords,
  setApplicationLabels,
  unblockApplication,
} from "../core/registry/applications.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import { retireApplication, unretireApplication } from "../core/registry/retirement.ts";
import type { ApplicationRecord } from "../core/types/registry.ts";
import { assertSlug } from "../core/utils/slug.ts";
import type { DaemonContext } from "./app.ts";
import { deleteApplicationRequest } from "./_delete.ts";
import { readReplicasRequest, readSelectorRequest } from "./_intake.ts";
import { nodeIdentity, operatorIdentity } from "./middleware.ts";
import { assertApplicationScope } from "./_scope.ts";
import { readJsonBody } from "./_json.ts";

/** Where the application surface lives. */
export const APPLICATIONS_PATH: string = "/v1/applications";

/** Body of `GET /v1/applications`: the applications the caller may see, in name order. */
export interface ApplicationsResult {
  /** Admin records, or scope-visible records with fleet-owned labels omitted. */
  applications: ApplicationRecord[];
  /** `true` for scope-dependent non-admin results. */
  scoped?: true;
}

/** Body of every route that answers with one application, as it now stands. */
export interface ApplicationResult {
  application: ApplicationRecord;
}

/** Body of `DELETE /v1/applications/:name`: the store keys it removed. */
export interface ApplicationDeleted {
  deleted: string[];
}

/** The two boundaries the application routes stand behind. */
export interface ApplicationRouteGuards {
  /** Operator tokens only: reading applications and what an admin decides about one. */
  operator: Middleware;
  /**
   * Operator AND node tokens: what changes or deletes one application. A node
   * forwards a deletion to the coordinator under its own token, so these routes
   * have to answer a peer; an operator's scope is still applied to the name.
   */
  peer: Middleware;
}

/** Adds the application routes to `app`. */
export function registerApplicationRoutes(
  app: H3,
  daemon: DaemonContext,
  guards: ApplicationRouteGuards,
): void {
  const guarded = { middleware: [guards.operator] };
  const peered = { middleware: [guards.peer] };

  /* Non-admin callers receive only reachable applications and no fleet labels. */
  app.get(
    APPLICATIONS_PATH,
    async (event): Promise<ApplicationsResult> => {
      const caller = requireCaller(event);
      const applications = await listApplicationRecords(daemon.registry);
      if (caller.role === "admin") return { applications };

      return {
        applications: applications
          .filter((application) => canReachApplication(caller, application.name))
          .map((application) => tenantView(application)),
        scoped: true,
      };
    },
    guarded,
  );

  app.get(
    `${APPLICATIONS_PATH}/:name`,
    async (event): Promise<ApplicationResult> => {
      const [caller, name] = scopedTarget(event);
      const application = await getApplication(daemon.registry, name);
      return { application: caller.role === "admin" ? application : tenantView(application) };
    },
    guarded,
  );

  /* Blocking is one CAS update; reconciliation stops serving it. */
  app.post(
    `${APPLICATIONS_PATH}/:name/block`,
    async (event): Promise<ApplicationResult> => {
      const [caller, name] = adminTarget(event);
      const application = await blockApplication(daemon.registry, name);

      daemon.observability?.emit({
        type: "application.blocked",
        actor: caller.id,
        application: name,
      });
      return { application };
    },
    guarded,
  );

  /* Unblocking immediately restores the prior desired state. */
  app.post(
    `${APPLICATIONS_PATH}/:name/unblock`,
    async (event): Promise<ApplicationResult> => {
      const [caller, name] = adminTarget(event);
      const application = await unblockApplication(daemon.registry, name);

      daemon.observability?.emit({
        type: "application.unblocked",
        actor: caller.id,
        application: name,
      });
      return { application };
    },
    guarded,
  );

  /* Fleet metadata is replaced wholesale and does not emit operational events. */
  app.post(
    `${APPLICATIONS_PATH}/:name/labels`,
    async (event): Promise<ApplicationResult> => {
      const [, name] = adminTarget(event);
      const labels = await readLabels(event, daemon.config.api.jsonBytes);

      /* Preserve the explicit missing-application response. */
      await getApplication(daemon.registry, name);
      return { application: await setApplicationLabels(daemon.registry, name, labels) };
    },
    guarded,
  );

  /* Retirement is one CAS update, so it does not require coordinator authority. */
  app.post(
    `${APPLICATIONS_PATH}/:name/retire`,
    async (event): Promise<ApplicationResult> => {
      const name = reachableTarget(event);
      return { application: await retireApplication(daemon.registry, name) };
    },
    peered,
  );

  /* Retirement remains reversible during its grace period. */
  app.post(
    `${APPLICATIONS_PATH}/:name/unretire`,
    async (event): Promise<ApplicationResult> => {
      const name = reachableTarget(event);
      return { application: await unretireApplication(daemon.registry, name) };
    },
    peered,
  );

  /* Selectors are CAS-updated intent. Unsatisfied selectors remain valid and
     are reported by assignment rather than rejected here. */
  app.post(
    `${APPLICATIONS_PATH}/:name/selector`,
    async (event): Promise<ApplicationResult> => {
      const name = reachableTarget(event);
      const request = await readSelectorRequest(event, { maxBytes: daemon.config.api.jsonBytes });
      return { application: await setNodeSelector(daemon.registry, name, request.selector) };
    },
    peered,
  );

  /* How many nodes should serve it; the coordinator's next pass acts on it. */
  app.post(
    `${APPLICATIONS_PATH}/:name/replicas`,
    async (event): Promise<ApplicationResult> => {
      const name = reachableTarget(event);
      const request = await readReplicasRequest(event, { maxBytes: daemon.config.api.jsonBytes });
      return { application: await setReplicas(daemon.registry, name, request.replicas) };
    },
    peered,
  );

  /* Deletion is coordinator-gated and transparently forwarded. `force=1` skips
     the retirement-grace check. */
  app.delete(
    `${APPLICATIONS_PATH}/:name`,
    async (event): Promise<Response | ApplicationDeleted> => {
      /* Check operator scope before forwarding under a node token. */
      reachableTarget(event);
      return deleteApplicationRequest(daemon, event);
    },
    peered,
  );
}

/* ---------------------------------------------------------------- internals */

/** Removes fleet-owned labels for a tenant view; blocked state remains visible. */
function tenantView(application: ApplicationRecord): ApplicationRecord {
  const { labels: _labels, ...rest } = application;
  return rest;
}

/**
 * The application a route was matched on, once whoever asked may reach it: an
 * operator within its scope, or a node of this installation, which is not scoped.
 */
function reachableTarget(event: H3Event): string {
  const name = event.context.params?.name ?? "";
  assertSlug(name);

  const identity = nodeIdentity(event);
  if (identity === undefined) {
    throw new ScafoError("auth-scope", "Not an operator or a node of this fleet");
  }
  assertApplicationScope(identity, name);
  return name;
}

/** The same, for a route only an operator may call. */
function scopedTarget(event: H3Event): [caller: TrustedOperator, application: string] {
  return [requireCaller(event), reachableTarget(event)];
}

/** Resolves an admin write target, checking application reach before admin tier. */
function adminTarget(event: H3Event): [caller: TrustedOperator, application: string] {
  const [caller, name] = scopedTarget(event);
  if (caller.role !== "admin") {
    throw new ScafoError("auth-scope", "Only an admin administers an application", {
      detail:
        `"${caller.id}" is an ${caller.role}-tier key: it may deploy "${name}" and run it, and ` +
        `it may not block it or label it — those are decisions this fleet makes about an ` +
        `application rather than decisions taken inside one; ask an admin of this fleet`,
    });
  }
  return [caller, name];
}

/**
 * The caller as the operator guard read it. Every route that asks stands behind
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
