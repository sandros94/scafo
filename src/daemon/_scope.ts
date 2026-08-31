/*
 * Internal: the one place an operator's PROJECT scope is enforced.
 *
 * An operator key is scoped to a list of projects, and this is where that list
 * meets a request. It does so two ways, and they are the two halves of the same
 * boundary:
 *
 * WHAT A CALLER MAY DO — {@link assertProjectScope} — at the point an
 * operator-authed call NAMES a project, in a path or in deploy metadata. Every
 * route of the node API that takes a project goes through
 * it, and no route that does not take one has anything to ask.
 *
 * WHAT A CALLER MAY LEARN — {@link scopedState} — at the point a route hands
 * back a document that names projects it was never asked about. `GET /v1/state`
 * reports every placement, every process and every
 * unplaced environment this node knows of, and on a multi-tenant fleet that is
 * the tenant list. A boundary that refuses to act on another tenant's project
 * while reporting that the project exists is half a boundary.
 *
 * BOTH ANSWER FROM {@link canReachProject}, so there is one rule and not two:
 * a NODE's own token is not an operator's record at all and passes untouched —
 * the deploy-await hop between peers reads the full state and must go on doing
 * so — an ADMIN reaches everything, a wildcard-scoped key reaches everything,
 * and an operator-tier key reaches what it names and nothing else.
 *
 * THE WORKLOAD PATH IS NOT THIS PATH. A project's CI presents an OIDC token and
 * is governed by that project's own trust policy (`registry/trust.ts`), which
 * already binds it to one project and one set of subjects. Nothing here touches
 * it: a caller that presented no node token has no operator record to be scoped
 * by, and this surface says nothing about it.
 */

import type { NodeIdentity } from "../core/auth/node-token.ts";
import { ScafoError } from "../core/error.ts";
import { canReachProject, type TrustedOperator } from "../core/registry/operators.ts";
import { parseProcessId } from "../core/placement/ids.ts";
import type { DaemonState } from "./app.ts";

/**
 * Refuses a scoped operator that named a project outside its list.
 *
 * A node identity resolves unchanged; an operator identity is checked against
 * the scope carried with the verification key, rather than a later registry
 * lookup that could describe a different caller.
 *
 * Throws `ScafoError("auth-scope")`, which is authorization rather than
 * authentication: the caller has proved which key it holds, so what is left to
 * say is that the key is not for this project.
 */
export function assertProjectScope(identity: NodeIdentity, project: string): void {
  if (identity.kind === "node" || canReachProject(identity.operator, project)) return;
  const caller = identity.operator;

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

/**
 * The node's state as `caller` is allowed to see it: every section that names a
 * project narrowed to the ones the caller reaches, and every MACHINE fact left
 * exactly as it stands.
 *
 * A `null` caller is a machine of the fleet rather than an operator, and an
 * admin is not a tenant, so both are handed the document unchanged and unmarked.
 * That first case is load-bearing: a node awaiting a deploy polls a peer's
 * `/v1/state` for the process it is waiting on, so a filtered answer between
 * peers would be a deploy that never completes.
 *
 * WHAT STAYS, AND WHY. The node's own record, the coordinator lease, who holds
 * it are facts about this MACHINE. None names another tenant.
 *
 * WHAT GOES. Placements, running processes and the
 * environments the last assignment pass could not place — in the top-level
 * document and again inside `reconcile`, which is the same reads reported at
 * more length. A process is matched by parsing its supervisor id, and one whose
 * id does not parse is DROPPED rather than kept: an id that names no project
 * cannot be shown to belong to this caller, and the safe direction to be wrong
 * in here is the one that hides.
 *
 * THE MARKER IS ABOUT THE CALLER, NOT ABOUT WHAT WAS HIDDEN. `scoped` is set
 * whenever the caller is a non-admin operator, including one whose scope reaches
 * every project and therefore had nothing removed. The alternative — marking it
 * only when a filter actually dropped something — would make the flag's absence
 * mean two different things, "you are seeing everything there is" and "you are
 * seeing everything you may", and a client cannot tell those apart when it
 * matters. What the flag states is that the answer is SCOPE-DEPENDENT.
 */
export function scopedState(caller: TrustedOperator | null, state: DaemonState): DaemonState {
  if (caller === null || caller.role === "admin") return state;

  const reaches = (project: string | null): boolean =>
    project !== null && canReachProject(caller, project);
  const byProject = <T extends { project: string }>(entries: T[]): T[] =>
    entries.filter((entry) => reaches(entry.project));

  const reconcile = state.reconcile;
  return {
    ...state,
    coordinator: scopedCoordinator(state.coordinator, reaches),
    processes: state.processes.filter((entry) =>
      reaches(parseProcessId(entry.id)?.project ?? null),
    ),
    placements: byProject(state.placements),
    ...(reconcile === undefined
      ? {}
      : {
          reconcile: {
            ...reconcile,
            processes: byProject(reconcile.processes),
            placements: byProject(reconcile.placements),
            /*
             * A failure whose subject names NO project — the ingress's own
             * convergence, or one recorded before there was a subject to record
             * — is dropped rather than kept. Its `detail` is free text written
             * for whoever runs the node, and the ingress's names every host the
             * pass was trying to publish; there is no way to hand a tenant one
             * of those and be sure of what went with it.
             */
            failures: reconcile.failures.filter((entry) => reaches(subjectProject(entry.subject))),
            lastActions: reconcile.lastActions.filter((action) =>
              reaches(
                action.type === "start"
                  ? action.project
                  : (parseProcessId(action.processId)?.project ?? null),
              ),
            ),
          },
        }),
    scoped: true,
  };
}

/* ---------------------------------------------------------------- internals */

/**
 * The election as a scoped caller sees it: who holds the lease, unchanged, and
 * only the unplaced environments the caller reaches.
 *
 * The list is rebuilt rather than overwritten, because ABSENT and EMPTY are
 * different answers on this view — absent means the pass placed everything it
 * was asked to, and a scoped caller whose own projects all placed cleanly must
 * read that rather than an empty list that says the field exists for a reason.
 */
function scopedCoordinator(
  view: DaemonState["coordinator"],
  reaches: (project: string | null) => boolean,
): DaemonState["coordinator"] {
  if (view === null) return null;

  const { unplaced: all, ...rest } = view;
  const unplaced = (all ?? []).filter((entry) => reaches(subjectProject(entry.target)));
  return { ...rest, ...(unplaced.length === 0 ? {} : { unplaced }) };
}

/**
 * The project a status line is recorded against: a `project/environment` target,
 * a supervisor process id, or null for a subject that names neither.
 */
function subjectProject(subject: string | undefined): string | null {
  if (subject === undefined) return null;

  const identity = parseProcessId(subject);
  if (identity !== null) return identity.project;
  const [project, environment] = subject.split("/");
  return project !== undefined && project !== "" && environment !== undefined ? project : null;
}
