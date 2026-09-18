/* Two-step application decommissioning: retirement stops serving immediately;
   deletion follows grace expiry or explicit force. */

import { ScafoError } from "../error.ts";
import type { ApplicationRecord } from "../types/registry.ts";
import { formatDuration } from "./_shared.ts";
import { updateApplication } from "./applications.ts";
import { nowDate, nowIso, type RegistryContext } from "./context.ts";

/** Default grace before a retired application may be deleted: 24 hours. */
export const DEFAULT_RETIREMENT_GRACE_MS: number = 86_400_000;

/** Where a retired application stands in its grace period. */
export interface RetirementState {
  /** When it was retired, as its record carries it. */
  retiredAt: string;
  /** How long it has been retired; negative when the stamp is in the future. */
  elapsedMs: number;
  /** What is left of the grace before deletion is allowed; 0 once there is none. */
  remainingMs: number;
  /** True once the grace has run out and the application may be deleted. */
  expired: boolean;
}

/** Options shared by everything that decides whether an application may go. */
export interface RetirementOptions {
  /** How long a retired application is kept. Defaults to {@link DEFAULT_RETIREMENT_GRACE_MS}. */
  graceMs?: number;
}

/** Retires an application without restamping retries, preserving its grace. */
export async function retireApplication(
  ctx: RegistryContext,
  name: string,
): Promise<ApplicationRecord> {
  const at = nowIso(ctx);
  return updateApplication(ctx, name, (current) =>
    current.retiredAt === undefined ? { ...current, retiredAt: at } : current,
  );
}

/** Removes retirement; idempotent until the application has been deleted. */
export async function unretireApplication(
  ctx: RegistryContext,
  name: string,
): Promise<ApplicationRecord> {
  return updateApplication(ctx, name, (current) => {
    if (current.retiredAt === undefined) return current;
    const { retiredAt: _retired, ...rest } = current;
    return rest;
  });
}

/** Retirement state, or null. Invalid timestamps retain full grace to prevent deletion. */
export function retirementState(
  application: ApplicationRecord,
  now: Date,
  opts?: RetirementOptions,
): RetirementState | null {
  const retiredAt = application.retiredAt;
  if (retiredAt === undefined) return null;

  const graceMs = opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS;
  const since = Date.parse(retiredAt);
  const elapsedMs = Number.isFinite(since) ? now.getTime() - since : 0;
  const remainingMs = Math.max(0, graceMs - elapsedMs);

  return { retiredAt, elapsedMs, remainingMs, expired: remainingMs === 0 };
}

/** Allows deletion only for forced or grace-expired applications. */
export function assertDeletable(
  ctx: RegistryContext,
  application: ApplicationRecord,
  opts?: RetirementOptions & { force?: boolean },
): void {
  if (opts?.force === true) return;

  const target = `"${application.name}"`;
  const graceMs = opts?.graceMs ?? DEFAULT_RETIREMENT_GRACE_MS;
  const state = retirementState(application, nowDate(ctx), { graceMs });
  if (state?.expired === true) return;

  if (state === null) {
    throw new ScafoError("invalid-input", "Application is not retired", {
      status: 409,
      detail:
        `${target} is not retired, and deleting an application takes two steps so the ` +
        `decision to discard it is made once and on its own: retire it ` +
        `("scafo app retire"), then delete it after the ${formatDuration(graceMs)} grace — or ` +
        `delete it now with force, which skips both`,
    });
  }

  throw new ScafoError("invalid-input", "Application is still within its retirement grace", {
    status: 409,
    detail:
      `${target} was retired at ${state.retiredAt} and ${formatDuration(state.remainingMs)} of ` +
      `its ${formatDuration(graceMs)} grace remains, during which it stays reversible ` +
      `("scafo app unretire"): wait for the grace to run out and delete it then, or delete it ` +
      `now with force`,
  });
}
