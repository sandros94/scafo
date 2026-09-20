/* Operator-authenticated application routes. Reads are scope-filtered; blocking
   and fleet-owned labels require admin. */

import type { H3, H3Event, Middleware } from "h3";
import { isScafoError, ScafoError } from "../core/error.ts";
import {
  canGrantScope,
  canReachApplication,
  type TrustedOperator,
} from "../core/registry/operators.ts";
import {
  blockApplication,
  getApplication,
  listApplicationRecords,
  setApplicationLabels,
  unblockApplication,
} from "../core/registry/applications.ts";
import {
  type ClaimDomainOptions,
  claimDomain,
  describeDomainConflict,
  domainConflict,
  releaseApplicationDomain,
} from "../core/registry/domains.ts";
import { setNodeSelector, setReplicas } from "../core/registry/placement.ts";
import { retireApplication, unretireApplication } from "../core/registry/retirement.ts";
import { assertClaimableHost } from "../core/placement/hosts.ts";
import { hostUnder } from "../core/placement/routes.ts";
import type { ApplicationRecord } from "../core/types/registry.ts";
import { normalizeCustomDomain } from "../core/utils/host.ts";
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

/** Body of both domain routes: the application, and the host they acted on. */
export interface ApplicationDomain extends ApplicationResult {
  /** The host as the registry holds it, which is the lowercased one. */
  host: string;
  /**
   * Where the application answers under this installation's own domains, which
   * is what a custom host is pointed at. Empty when the installation serves no
   * platform domain.
   */
  platformHosts: string[];
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

  /* A custom domain is one claim per host for the whole installation, and an
     OPERATOR's to make: this group is behind the operator guard, so the workload
     token a deploy pipeline holds never reaches it — a pipeline publishes an
     application, it does not decide what the fleet answers on. `?wildcard=1`
     claims the one label below the host as well, and asks for more of the key
     that makes it: see {@link claimOptions}. */
  app.post(
    `${APPLICATIONS_PATH}/:name/domains/:host`,
    async (event): Promise<ApplicationDomain> => {
      const [caller, name] = scopedTarget(event);
      const host = claimedHost(event, daemon);
      const claim = claimOptions(event, caller, name);

      try {
        await claimDomain(daemon.registry, host, name, claim);
      } catch (error) {
        throw await heldElsewhere(daemon, caller, name, host, claim, error);
      }
      return domainAnswer(daemon, await getApplication(daemon.registry, name), host);
    },
    guarded,
  );

  /* Releasing is the same authority, and it stays open while an application is
     blocked: a host is the operator's to take back whatever state it is in. */
  app.delete(
    `${APPLICATIONS_PATH}/:name/domains/:host`,
    async (event): Promise<ApplicationDomain> => {
      const [, name] = scopedTarget(event);
      const host = normalizeCustomDomain(event.context.params?.host ?? "");

      await releaseApplicationDomain(daemon.registry, host, name);
      return domainAnswer(daemon, await getApplication(daemon.registry, name), host);
    },
    guarded,
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

/**
 * The host a claim was asked for: checked against the rule a claimed host
 * follows, and then against this installation's own domains.
 *
 * THE SECOND HALF IS THE DAEMON'S because only it knows them. Every host under a
 * platform domain is rendered from an application's name, so one claimed there
 * could only shadow a host the fleet already answers on.
 */
function claimedHost(event: H3Event, daemon: DaemonContext): string {
  const host = normalizeCustomDomain(event.context.params?.host ?? "");
  assertClaimableHost(host, daemon.config.platformDomains);
  return host;
}

/**
 * What the claim asks for beyond the host, and whether this caller may ask it.
 *
 * `?wildcard=1` claims the one label below the host too, where every name is
 * either the application itself or one of its `<name>-<env>` environments. So it
 * takes a key that reaches THOSE as well: the same coverage rule enrolment
 * measures a requested scope by, asked here about `<name>-*`.
 */
function claimOptions(
  event: H3Event,
  caller: TrustedOperator,
  application: string,
): ClaimDomainOptions {
  if (event.url.searchParams.get("wildcard") !== "1") return {};

  if (!canGrantScope(caller, [`${application}-*`])) {
    throw new ScafoError("auth-scope", "Beyond this key's applications", {
      detail:
        `"${caller.id}" reaches "${application}", and claiming a host with its subdomains ` +
        `also decides what "${application}-<env>" answers on: ask an admin of this fleet for a ` +
        `key scoped to "${application}-*", or claim the host on its own`,
    });
  }
  return { wildcard: true };
}

/** What both domain routes answer with: the record, the host, and where it points. */
function domainAnswer(
  daemon: DaemonContext,
  application: ApplicationRecord,
  host: string,
): ApplicationDomain {
  const platformHosts = daemon.config.platformDomains
    .map((domain) => hostUnder(domain, application.name))
    .filter((named): named is string => named !== null);
  return { application, host, platformHosts };
}

/**
 * A `reference-held` refusal worded for whoever is reading it.
 *
 * The holder is named only to a caller whose scope reaches it; to anyone else it
 * is "another application", because an operator scoped to one tenant must not be
 * able to read off which of a fleet's applications holds a host by asking for
 * it. Anything that is not that refusal passes through untouched.
 */
async function heldElsewhere(
  daemon: DaemonContext,
  caller: TrustedOperator,
  application: string,
  host: string,
  claim: ClaimDomainOptions,
  error: unknown,
): Promise<unknown> {
  if (!isScafoError(error) || error.code !== "reference-held") return error;

  const conflict = await domainConflict(daemon.registry, host, application, claim);
  if (conflict === null || canReachApplication(caller, conflict.application)) return error;

  /* The same sentence the registry wrote, with the holder's name taken out of
     it: which host stands in the way is the caller's own business, and which
     application holds it is not. */
  return new ScafoError("reference-held", error.message, {
    detail: describeDomainConflict(host, conflict, "another application of this installation"),
    cause: error,
  });
}

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
