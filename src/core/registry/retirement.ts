/*
 * Retirement: the two steps that decommission a long-lived environment, and the
 * rule that decides when the second one is allowed.
 *
 * Deleting an environment outright is the one destructive act nothing in the
 * registry can undo — a long-lived environment is the name that outlives every
 * build it ever served, and its domains, its variables and its history go with
 * it. So it is taken in two: retiring says "this is on its way out", which stops
 * it being served immediately and is reversible for as long as the grace runs;
 * deleting is only permitted once that grace has passed, or once a caller
 * explicitly forces it.
 */

import { ScafoError } from "../error.ts";
import type { EnvironmentRecord } from "../types/registry.ts";
import { formatDuration } from "./_shared.ts";
import { updateJson } from "./cas.ts";
import { nowDate, nowIso, type RegistryContext } from "./context.ts";
import { environmentKey } from "./paths.ts";

/**
 * How long a retired environment is kept before it may be deleted, unless the
 * caller says otherwise: 24 hours.
 *
 * Long enough that the working day which retired an environment by mistake is
 * the working day that can still take it back, and short enough that
 * decommissioning does not become a week-long ceremony.
 */
export const DEFAULT_RETIREMENT_GRACE_MS: number = 86_400_000;

/** Where a retired environment stands in its grace period. */
export interface RetirementState {
  /** When it was retired, as its record carries it. */
  retiredAt: string;
  /** How long it has been retired; negative when the stamp is in the future. */
  elapsedMs: number;
  /** What is left of the grace before deletion is allowed; 0 once there is none. */
  remainingMs: number;
  /** True once the grace has run out and the environment may be deleted. */
  expired: boolean;
}

/** Options shared by everything that decides whether an environment may go. */
export interface RetirementOptions {
  /** How long a retired environment is kept. Defaults to {@link DEFAULT_RETIREMENT_GRACE_MS}. */
  graceMs?: number;
}

/**
 * Retires an environment: it stops being served, and becomes deletable once the
 * grace has run.
 *
 * IDEMPOTENT, and the detail that makes it so is worth stating: an environment
 * that is already retired keeps the timestamp it already had. Restamping it
 * would restart the grace, so a retry — or an operator running the command twice
 * because the first run scrolled past — would silently push the deletion a full
 * day out, and a scripted "retire then delete" would never reach its second half.
 *
 * Throws `ScafoError("not-found")` when there is no such environment.
 */
export async function retireEnvironment(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<EnvironmentRecord> {
  const at = nowIso(ctx);
  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => (current.retiredAt === undefined ? { ...current, retiredAt: at } : current),
  );
  return updated.value;
}

/**
 * Takes an environment back out of retirement, putting it straight back into
 * service: the nodes pick it up again on their next pass, exactly as they
 * dropped it.
 *
 * Reversibility is half of what makes the two-step decommission worth having. An
 * environment retired by mistake — the wrong name, the wrong project, the wrong
 * day — is repaired by one command rather than by restoring a bucket, and that
 * is only true while the grace still has time on it. Past that the environment
 * may already have been reaped, and nothing here can bring it back.
 *
 * Idempotent: an environment that is not retired is left exactly as it is.
 */
export async function unretireEnvironment(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<EnvironmentRecord> {
  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      if (current.retiredAt === undefined) return current;
      const { retiredAt: _retired, ...rest } = current;
      return rest;
    },
  );
  return updated.value;
}

/**
 * Where `environment` stands in its retirement, or null when it is not retired.
 *
 * A `retiredAt` that cannot be parsed counts as retired with the FULL grace
 * still ahead of it, rather than as expired: a timestamp nothing can read is not
 * evidence that a day has passed, and the safe reading of a damaged record is
 * the one that does not delete anything. Forcing the deletion still works.
 *
 * Pure, so the caller decides what "now" is.
 */
export function retirementState(
  environment: EnvironmentRecord,
  now: Date,
  opts?: RetirementOptions,
): RetirementState | null {
  const retiredAt = environment.retiredAt;
  if (retiredAt === undefined) return null;

  const graceMs = opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS;
  const since = Date.parse(retiredAt);
  const elapsedMs = Number.isFinite(since) ? now.getTime() - since : 0;
  const remainingMs = Math.max(0, graceMs - elapsedMs);

  return { retiredAt, elapsedMs, remainingMs, expired: remainingMs === 0 };
}

/**
 * Throws unless this environment may be deleted right now. Three paths lead
 * through, and the refusal names whichever one the caller is closest to:
 *
 * - `force` — the caller has stated the decision outright, and bypasses BOTH the
 *   ephemeral and the grace requirement.
 * - ephemeral — a preview environment is disposable by construction, and is
 *   deleted the way it has always been.
 * - retired past its grace — the two-step decommission, completed.
 *
 * Throws `ScafoError("invalid-input")` at status 409 otherwise: the request is
 * well-formed, the environment is simply not yet in a state this call may act
 * on. The detail is the point of the refusal — it says which route applies and,
 * for an environment already retired, how much of the grace is left to wait.
 */
export function assertDeletable(
  ctx: RegistryContext,
  project: string,
  environment: EnvironmentRecord,
  opts?: RetirementOptions & { force?: boolean },
): void {
  if (opts?.force === true || environment.ephemeral) return;

  const target = `"${project}/${environment.name}"`;
  const graceMs = opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS;
  const state = retirementState(environment, nowDate(ctx), { graceMs });
  if (state?.expired === true) return;

  if (state === null) {
    throw new ScafoError("invalid-input", "Environment is not retired", {
      status: 409,
      detail:
        `${target} is neither ephemeral nor retired, and deleting a long-lived environment ` +
        `takes two steps so the decision to discard it is made once and on its own: retire it ` +
        `("scafo env retire"), then delete it after the ${formatDuration(graceMs)} grace — or ` +
        `delete it now with force, which skips both`,
    });
  }

  throw new ScafoError("invalid-input", "Environment is still within its retirement grace", {
    status: 409,
    detail:
      `${target} was retired at ${state.retiredAt} and ${formatDuration(state.remainingMs)} of ` +
      `its ${formatDuration(graceMs)} grace remains, during which it stays reversible ` +
      `("scafo env unretire"): wait for the grace to run out and delete it then, or delete it ` +
      `now with force`,
  });
}
