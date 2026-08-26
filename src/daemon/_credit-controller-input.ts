import type { CreditReservation } from "../core/capacity/credits.ts";
import { ScafoError } from "../core/error.ts";
import { assertPositiveSafeInteger } from "../core/utils/number.ts";
import type { CreditControllerOptions, RuntimeCreditReservation } from "./_credit-controller.ts";

export function normalizeRuntime(
  value: readonly RuntimeCreditReservation[],
): Map<string, CreditReservation> {
  if (!Array.isArray(value)) {
    throw new ScafoError("invalid-input", "Invalid runtime credit reservations", {
      detail: `runtime reservations must be an array`,
    });
  }
  const reservations = new Map<string, CreditReservation>();
  for (const input of value) {
    const reservation = normalizeRequest(input, "runtime");
    if (reservations.has(reservation.target)) throw duplicate(reservation.target);
    reservations.set(reservation.target, reservation);
  }
  return reservations;
}

export function creditOptions(value: unknown): CreditControllerOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScafoError("invalid-input", "Invalid credit controller options", {
      detail: `credit controller options must be an object`,
    });
  }
  const options = value as { allocatableMb?: unknown; surgeMb?: unknown };
  return { allocatableMb: options.allocatableMb as number, surgeMb: options.surgeMb as number };
}

export function normalizeRequest(value: unknown, kind: string): CreditReservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScafoError("invalid-input", `Invalid ${kind} credit reservation`, {
      detail: `${kind} credit reservations must be objects`,
    });
  }
  const input = value as { owner?: unknown; mb?: unknown };
  const target = targetOf(input.owner, kind);
  assertPositiveSafeInteger(input.mb, `${kind}.mb`);
  return { target, mb: input.mb };
}

export function assertDistinct(
  left: ReadonlyMap<string, CreditReservation>,
  right: ReadonlyMap<string, CreditReservation>,
): void {
  for (const key of left.keys()) {
    if (right.has(key)) throw duplicate(key);
  }
}

export function duplicate(target: string): ScafoError {
  return new ScafoError("invalid-input", "Duplicate credit reservation", {
    detail: `${target} already owns node-local credit`,
  });
}

function targetOf(value: unknown, kind: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScafoError("invalid-input", `Invalid ${kind} credit owner`, {
      detail: `${kind} credit reservations need a namespaced owner`,
    });
  }
  const owner = value as { namespace?: unknown; id?: unknown };
  if (typeof owner.namespace !== "string" || owner.namespace.length === 0) {
    throw new ScafoError("invalid-input", `Invalid ${kind} credit owner`, {
      detail: `${kind} credit owner namespace must be a non-empty string`,
    });
  }
  if (typeof owner.id !== "string" || owner.id.length === 0) {
    throw new ScafoError("invalid-input", `Invalid ${kind} credit owner`, {
      detail: `${kind} credit owner id must be a non-empty string`,
    });
  }
  return JSON.stringify([owner.namespace, owner.id]);
}
