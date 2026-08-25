/* The durable CAS claim that makes node and operator identities mutually exclusive. */

import { ScafoError } from "../error.ts";
import type { IdentityKind, IdentityReservation } from "../types/registry.ts";
import { deepEqual, isCasConflict } from "./_shared.ts";
import { createJson, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { identityKey } from "./paths.ts";

/**
 * Claims `id` for one kind and key. An exact retry recovers an interrupted
 * registration; every other claimant is refused without changing the claim.
 */
export async function claimIdentity(
  ctx: RegistryContext,
  id: string,
  reservation: IdentityReservation,
): Promise<void> {
  const key = identityKey(id);
  try {
    await createJson(ctx, key, reservation);
    return;
  } catch (error) {
    if (!isCasConflict(error)) throw error;
  }

  const found = await readJson<IdentityReservation>(ctx, key);
  if (found !== null && sameIdentity(found.value, reservation)) return;

  throw new ScafoError("reference-held", "Id belongs to another identity of this installation", {
    detail: `"${id}" is already reserved by another identity; choose another id`,
  });
}

/** Builds the identity object both record namespaces reserve. */
export function identityReservation(
  kind: IdentityKind,
  publicKey: IdentityReservation["publicKey"],
): IdentityReservation {
  return { v: 1, kind, publicKey };
}

function sameIdentity(a: IdentityReservation, b: IdentityReservation): boolean {
  return a.v === b.v && a.kind === b.kind && deepEqual(a.publicKey, b.publicKey);
}
