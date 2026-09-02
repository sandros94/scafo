/* Shared project authorization and state filtering for operator tokens. Node
   peer tokens remain unfiltered; workload tokens use their trust policy. */

import type { NodeIdentity } from "../core/auth/node-token.ts";
import { ScafoError } from "../core/error.ts";
import { canReachProject, type TrustedOperator } from "../core/registry/operators.ts";
import { parseProcessId } from "../core/placement/ids.ts";
import type { DaemonState } from "./app.ts";

/** Enforces the verified operator scope; node identities are unrestricted. */
export function assertProjectScope(identity: NodeIdentity, project: string): void {
  if (identity.kind === "node" || canReachProject(identity.operator, project)) return;
  const caller = identity.operator;

  /* Do not disclose projects outside the caller's scope. */
  throw new ScafoError("auth-scope", "Beyond this key's projects", {
    detail:
      `"${caller.id}" is scoped to the projects it was enrolled for, and "${project}" is not ` +
      `one of them; ask an admin of this fleet for a key that reaches it, or make the request ` +
      `with one`,
  });
}

/** Filters project-bearing state for non-admin operators. Unparseable process
 * ids are hidden; `scoped` denotes scope-dependent output. */
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
            /* Failure text without a project cannot be safely attributed. */
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

/** Filters coordinator failures while preserving absent-versus-empty semantics. */
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
