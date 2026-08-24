/*
 * Internal: the one place an operator's PROJECT scope is enforced.
 *
 * An operator key may be scoped to a list of projects, and this is where that
 * list meets a request: at the point an operator-authed call NAMES a project —
 * in a path, in a deploy's meta, or in the body of a flip. Every route of the
 * node API that takes a project goes through here, and no route that does not
 * take one has anything to ask.
 *
 * ABSENT IS EVERY PROJECT, so a fleet nobody has scoped never reaches the
 * refusal below: an unscoped key, a role-less key from before any of this, and a
 * NODE's own token — which is not an operator's record at all — all pass
 * untouched. That is what makes the whole layer opt-in.
 *
 * THE WORKLOAD PATH IS NOT THIS PATH. A project's CI presents an OIDC token and
 * is governed by that project's own trust policy (`registry/trust.ts`), which
 * already binds it to one project and one set of subjects. Nothing here touches
 * it: a caller that presented no node token has no operator record to be scoped
 * by, and this surface says nothing about it.
 */

import type { H3Event } from "h3";
import { ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { canReachProject } from "../core/registry/operators.ts";
import { callerOperator } from "./middleware.ts";

/**
 * Refuses a scoped operator that named a project outside its list.
 *
 * `callerId` is the id of the verified NODE token the request carried; a request
 * that carried none never reaches this. Resolves for a caller that is not an
 * operator record — a machine of the fleet — and for one carrying no scope.
 *
 * Throws `ScafoError("auth-scope")`, which is authorization rather than
 * authentication: the caller has proved which key it holds, so what is left to
 * say is that the key is not for this project.
 */
export async function assertProjectScope(
  registry: RegistryContext,
  event: H3Event,
  callerId: string,
  project: string,
): Promise<void> {
  const caller = await callerOperator(event, registry, callerId);
  if (caller === null || canReachProject(caller, project)) return;

  /*
   * THE OTHER PROJECTS ARE NEVER NAMED. The point of handing a tenant an
   * operator key rather than a bucket credential is that the tenant learns
   * nothing about the fleet it shares — and a refusal that enumerated the key's
   * own list, or the fleet's, would be exactly the disclosure this exists to
   * prevent. The project that was ASKED for is named, because the caller named
   * it, and nothing else is.
   */
  throw new ScafoError("auth-scope", "Beyond this key's projects", {
    detail:
      `"${caller.id}" is scoped to the projects it was enrolled for, and "${project}" is not ` +
      `one of them; ask an admin of this fleet for a key that reaches it, or make the request ` +
      `with one`,
  });
}
