/* Integer MiB accounting for the credits one node owns across its work. */

import { ScafoError } from "../error.ts";
import { assertPositiveSafeInteger } from "../utils/number.ts";

/** One named reservation against a node-wide credit pool. */
export interface CreditReservation {
  /** Stable owner name; it is unique across every reservation in one account. */
  target: string;
  /** Whole MiB reserved by this owner. */
  mb: number;
}

/** Every source of memory credit a node has reserved at one instant. */
export interface CreditAccountInput {
  /** Total allocatable node memory, in MiB. */
  allocatableMb: number;
  /** Runtime credit held back from deploy work, in MiB. */
  surgeMb: number;
  /** Serving runtime processes. */
  runtime?: CreditReservation[];
  /** Runtime starts, wakes and rollouts that may consume surge credit. */
  transition?: CreditReservation[];
  /** Active deploy builders; these cannot consume surge credit. */
  deploy?: CreditReservation[];
}

/** The deterministic, integer-MiB state of one node's unified credit pool. */
export interface CreditAccount {
  allocatableMb: number;
  surgeMb: number;
  runtimeMb: number;
  transitionMb: number;
  deployMb: number;
  /** Runtime, transition and deploy reservations combined. */
  usedMb: number;
  /** Credits that can be admitted right now, never below zero. */
  availableMb: number;
  /** Excess demand in an upgraded or otherwise overcommitted snapshot. */
  deficitMb: number;
  /** The portion of surge not currently occupied by a runtime transition. */
  protectedMb: number;
  /** What another deploy may reserve while preserving runtime surge. */
  deployAvailableMb: number;
  /** What a transition or wake may reserve before the total pool is exhausted. */
  runtimeAvailableMb: number;
  /** What a steady runtime may reserve while preserving the full surge credit. */
  steadyAvailableMb: number;
  /** Deficit after steady runtime and deploy work retain surge headroom. */
  steadyDeficitMb: number;
  /** Whether no reservation exceeds the total pool. */
  fits: boolean;
  /** Whether steady work still leaves its runtime surge headroom. */
  steadyFits: boolean;
}

/**
 * Accounts one node's runtime and deploy credits.
 *
 * Deploy admission uses {@link CreditAccount.deployAvailableMb}; a runtime
 * transition or wake uses {@link CreditAccount.runtimeAvailableMb}. A caller
 * proposing a lasting placement must also check `steadyFits` for the state
 * after the transition finishes.
 */
export function accountCredits(input: CreditAccountInput): CreditAccount {
  if (typeof input !== "object" || input === null) {
    throw new ScafoError("invalid-input", "Invalid credit account", {
      detail: `a credit account must be an object`,
    });
  }
  assertPositiveSafeInteger(input.allocatableMb, "allocatableMb");
  assertPositiveSafeInteger(input.surgeMb, "surgeMb");
  if (input.surgeMb > input.allocatableMb) {
    throw new ScafoError("invalid-input", "Invalid surgeMb", {
      detail: `"surgeMb" must not exceed "allocatableMb"`,
    });
  }

  const seen = new Set<string>();
  const runtimeMb = sum(reservations(input.runtime, "runtime"), "runtime", seen);
  const transitionMb = sum(reservations(input.transition, "transition"), "transition", seen);
  const deployMb = sum(reservations(input.deploy, "deploy"), "deploy", seen);
  const usedMb = add(add(runtimeMb, transitionMb), deployMb);
  const remainingMb = input.allocatableMb - usedMb;
  const protectedMb = Math.max(0, input.surgeMb - transitionMb);
  const steadyRemainingMb = input.allocatableMb - runtimeMb - deployMb - input.surgeMb;

  return {
    allocatableMb: input.allocatableMb,
    surgeMb: input.surgeMb,
    runtimeMb,
    transitionMb,
    deployMb,
    usedMb,
    availableMb: Math.max(0, remainingMb),
    deficitMb: Math.max(0, -remainingMb),
    protectedMb,
    deployAvailableMb: Math.max(0, remainingMb - protectedMb),
    runtimeAvailableMb: Math.max(0, remainingMb),
    steadyAvailableMb: Math.max(0, steadyRemainingMb),
    steadyDeficitMb: Math.max(0, -steadyRemainingMb),
    fits: remainingMb >= 0,
    steadyFits: steadyRemainingMb >= 0,
  };
}

function sum(reservations: CreditReservation[], kind: string, seen: Set<string>): number {
  let total = 0;
  for (const reservation of reservations) {
    if (typeof reservation?.target !== "string" || reservation.target.length === 0) {
      throw new ScafoError("invalid-input", `Invalid ${kind} reservation`, {
        detail: `"${kind}.target" must be a non-empty string`,
      });
    }
    if (seen.has(reservation.target)) {
      throw new ScafoError("invalid-input", "Duplicate credit reservation", {
        detail: `"${reservation.target}" appears more than once in one credit account`,
      });
    }
    seen.add(reservation.target);
    assertPositiveSafeInteger(reservation.mb, `${kind}.mb`);
    total = add(total, reservation.mb);
  }
  return total;
}

function reservations(value: CreditReservation[] | undefined, kind: string): CreditReservation[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  throw new ScafoError("invalid-input", `Invalid ${kind} reservations`, {
    detail: `"${kind}" must be an array of named positive MiB reservations`,
  });
}

function add(left: number, right: number): number {
  const total = left + right;
  if (Number.isSafeInteger(total)) return total;
  throw new ScafoError("invalid-input", "Credit arithmetic overflow", {
    detail: `credit reservations exceed the largest safe integer MiB value`,
  });
}
