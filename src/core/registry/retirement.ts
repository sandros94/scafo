/* Two-step environment decommissioning: retirement stops serving immediately;
   deletion follows grace expiry or explicit force. */

import { ScafoError } from "../error.ts";
import type { EnvironmentRecord } from "../types/registry.ts";
import { formatDuration } from "./_shared.ts";
import { updateJson } from "./cas.ts";
import { nowDate, nowIso, type RegistryContext } from "./context.ts";
import { environmentKey } from "./paths.ts";

/** Default grace before a retired environment may be deleted: 24 hours. */
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

/** Retires an environment without restamping retries, preserving its grace. */
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

/** Removes retirement; idempotent until the environment has been deleted. */
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

/** Retirement state, or null. Invalid timestamps retain full grace to prevent deletion. */
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

/** Allows deletion only for forced or grace-expired environments. */
export function assertDeletable(
  ctx: RegistryContext,
  project: string,
  environment: EnvironmentRecord,
  opts?: RetirementOptions & { force?: boolean },
): void {
  if (opts?.force === true) return;

  const target = `"${project}/${environment.name}"`;
  const graceMs = opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS;
  const state = retirementState(environment, nowDate(ctx), { graceMs });
  if (state?.expired === true) return;

  if (state === null) {
    throw new ScafoError("invalid-input", "Environment is not retired", {
      status: 409,
      detail:
        `${target} is not retired, and deleting an environment takes two steps so the ` +
        `decision to discard it is made once and on its own: retire it ` +
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
