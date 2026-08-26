import { ScafoError } from "../error.ts";
import type { NodeCreditProfile } from "../types/registry.ts";
import { accountCredits } from "./credits.ts";

/** Validates one advertised profile and returns a detached canonical copy. */
export function readCreditProfile(value: unknown): NodeCreditProfile | null {
  if (typeof value !== "object" || value === null) return null;
  const profile = value as Partial<NodeCreditProfile>;
  if (
    !positive(profile.allocatableMb) ||
    !positive(profile.runtimeMb) ||
    !positive(profile.deployMb)
  ) {
    return null;
  }
  try {
    const account = accountCredits({
      allocatableMb: profile.allocatableMb,
      surgeMb: profile.runtimeMb,
    });
    if (
      account.steadyAvailableMb < profile.runtimeMb ||
      account.deployAvailableMb < profile.deployMb
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    allocatableMb: profile.allocatableMb,
    runtimeMb: profile.runtimeMb,
    deployMb: profile.deployMb,
  };
}

/** Refuses an invalid local profile before this node can advertise it. */
export function assertCreditProfile(profile: NodeCreditProfile): NodeCreditProfile {
  const valid = readCreditProfile(profile);
  if (valid !== null) return valid;
  throw new ScafoError("invalid-input", "Insufficient node credit", {
    detail:
      `the advertised pool must be positive safe integers and separately admit one runtime ` +
      `and one deploy while preserving the runtime-sized surge`,
  });
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
