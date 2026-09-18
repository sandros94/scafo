/* Shared application authorization and state filtering for operator tokens. Node
   peer tokens remain unfiltered; workload tokens use their trust policy. */

import type { NodeIdentity } from "../core/auth/node-token.ts";
import { ScafoError } from "../core/error.ts";
import { canReachApplication, type TrustedOperator } from "../core/registry/operators.ts";
import type { DaemonState } from "./app.ts";

/** Enforces the verified operator scope; node identities are unrestricted. */
export function assertApplicationScope(identity: NodeIdentity, application: string): void {
  if (identity.kind === "node" || canReachApplication(identity.operator, application)) return;
  const caller = identity.operator;

  /* Do not disclose applications outside the caller's scope. */
  throw new ScafoError("auth-scope", "Beyond this key's applications", {
    detail:
      `"${caller.id}" is scoped to the applications it was enrolled for, and "${application}" ` +
      `is not one of them; ask an admin of this fleet for a key that reaches it, or make the ` +
      `request with one`,
  });
}

/** Filters application-bearing state for non-admin operators. `scoped` denotes
 * scope-dependent output. */
export function scopedState(caller: TrustedOperator | null, state: DaemonState): DaemonState {
  if (caller === null || caller.role === "admin") return state;

  const reaches = (application: string | undefined): boolean =>
    application !== undefined && canReachApplication(caller, application);

  const reconcile = state.reconcile;
  return {
    ...state,
    coordinator: scopedCoordinator(state.coordinator, reaches),
    processes: state.processes.filter((entry) => reaches(entry.id)),
    placements: state.placements.filter((entry) => reaches(entry.application)),
    ...(reconcile === undefined
      ? {}
      : {
          reconcile: {
            ...reconcile,
            processes: reconcile.processes.filter((entry) => reaches(entry.application)),
            placements: reconcile.placements.filter((entry) => reaches(entry.application)),
            /* Failure text without an application cannot be safely attributed. */
            failures: reconcile.failures.filter((entry) => reaches(entry.subject)),
            lastActions: reconcile.lastActions.filter((action) => reaches(action.application)),
          },
        }),
    scoped: true,
  };
}

/* ---------------------------------------------------------------- internals */

/** Filters coordinator failures while preserving absent-versus-empty semantics. */
function scopedCoordinator(
  view: DaemonState["coordinator"],
  reaches: (application: string | undefined) => boolean,
): DaemonState["coordinator"] {
  if (view === null) return null;

  const { unplaced: all, ...rest } = view;
  const unplaced = (all ?? []).filter((entry) => reaches(entry.target));
  return { ...rest, ...(unplaced.length === 0 ? {} : { unplaced }) };
}
