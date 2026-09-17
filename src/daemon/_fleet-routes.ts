/* Operator-authenticated fleet routes: the statements an admin makes about the
   installation itself rather than about one project. */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import { freezeDeploys, readFreeze, unfreezeDeploys } from "../core/registry/freeze.ts";
import type { TrustedOperator } from "../core/registry/operators.ts";
import type { FreezeRecord } from "../core/types/registry.ts";
import type { DaemonContext } from "./app.ts";
import { nodeIdentity, operatorIdentity } from "./middleware.ts";
import { readJsonBody } from "./_json.ts";

/** Where the deploy freeze lives. */
export const FLEET_FREEZE_PATH: string = "/v1/fleet/freeze";

/** Body of `GET /v1/fleet/freeze`: the freeze that stands. */
export interface FreezeView {
  freeze: FreezeRecord;
}

/** Body of `POST /v1/fleet/freeze`: the freeze that stands, and who set it. */
export interface FreezeSet extends FreezeView {
  /** False when deploys were already frozen, and the first freeze is returned. */
  created: boolean;
}

/** Body of `DELETE /v1/fleet/freeze`. */
export interface FreezeLifted {
  lifted: boolean;
}

/** Adds the fleet routes to `app`, each behind `guard`. */
export function registerFleetRoutes(app: H3, daemon: DaemonContext, guard: Middleware): void {
  const guarded = { middleware: [guard] };

  /* Freezing is one conditional create; every node reads it at intake. */
  app.post(
    FLEET_FREEZE_PATH,
    async (event): Promise<FreezeSet> => {
      const caller = requireAdmin(event);
      const reason = await readFreezeReason(event, daemon.config.api.jsonBytes);

      /* `by` is the caller the guard verified, never anything the body said: the
         record is evidence of who stopped the fleet's deploys. */
      return freezeDeploys(daemon.registry, {
        by: caller.id,
        ...(reason === undefined ? {} : { reason }),
      });
    },
    guarded,
  );

  /* Lifting it is one delete, and nodes accept deploys again on the next one. */
  app.delete(
    FLEET_FREEZE_PATH,
    async (event): Promise<FreezeLifted> => {
      requireAdmin(event);
      return { lifted: await unfreezeDeploys(daemon.registry) };
    },
    guarded,
  );

  /* Readable by any operator of the fleet: whoever is refused a deploy is owed
     the reason, whatever tier their key is. */
  app.get(
    FLEET_FREEZE_PATH,
    async (event): Promise<FreezeView> => {
      requireCaller(event);
      const freeze = await readFreeze(daemon.registry);
      if (freeze !== null) return { freeze };

      throw new ScafoError("not-found", "Deploys are not frozen", {
        detail: "this fleet holds no freeze record, so its nodes are taking deploys",
      });
    },
    guarded,
  );
}

/* ---------------------------------------------------------------- internals */

/** The caller, once its admin tier is established. */
function requireAdmin(event: H3Event): TrustedOperator {
  const caller = requireCaller(event);
  if (caller.role === "admin") return caller;

  throw new ScafoError("auth-scope", "Only an admin freezes this fleet's deploys", {
    detail:
      `"${caller.id}" is an ${caller.role}-tier key: it may deploy to the projects it reaches ` +
      `and run their environments, and it may not stop every deploy of this installation — ` +
      `that is a decision this fleet makes about itself rather than one taken inside a ` +
      `project; ask an admin of this fleet`,
  });
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
 * The reason the caller gave, or undefined when it gave none.
 *
 * THE BODY IS OPTIONAL. A freeze with nothing to say is a POST with no body at
 * all, which is not a malformed document, so an empty request is not read as
 * JSON — `JSON.parse("")` would refuse it.
 */
async function readFreezeReason(event: H3Event, maxBytes: number): Promise<string | undefined> {
  if (event.req.body === null || event.req.headers.get("content-length") === "0") return undefined;

  const parsed = await readJsonBody(event, { maxBytes });
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw malformed(`the body must hold a JSON object, or be left off entirely`);
  }

  const reason = (parsed as { reason?: unknown }).reason;
  if (reason === undefined) return undefined;
  if (typeof reason !== "string") throw malformed(`"reason" must be a string`);

  return reason;
}

function malformed(detail: string): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail });
}
