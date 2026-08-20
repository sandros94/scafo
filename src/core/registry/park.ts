/*
 * What scale-to-zero means for one environment: the policy fields an operator
 * set, resolved against what the environment's kind implies.
 */

import { ScafoError } from "../error.ts";
import type { EnvironmentRecord, ParkPolicy } from "../types/registry.ts";
import { updateJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { environmentKey } from "./paths.ts";

/** Seconds an ephemeral environment runs past its last wake before it parks. */
export const DEFAULT_EPHEMERAL_PARK_AFTER_S: number = 900;

/** Seconds a woken superseded build runs past its last wake before it parks again. */
export const DEFAULT_BUILD_IDLE_S: number = 300;

/** Seconds a request held for a wake may wait before it is answered `503`. */
export const DEFAULT_WAKE_DEADLINE_S: number = 30;

/** {@link ParkPolicy} with every blank filled in; what readers act on. */
export interface ResolvedParkPolicy {
  afterS: number;
  recallBuilds: boolean;
  buildIdleS: number;
  wakeDeadlineS: number;
}

/**
 * The policy an environment actually runs under.
 *
 * A LONG-LIVED ENVIRONMENT NEVER PARKS, whatever its record says: it serves
 * live traffic no wake stamp reflects — a stamp is written when something is
 * woken, and a warm environment is never woken — so a clock against the last
 * stamp would park it mid-traffic. Until scafo can measure real traffic,
 * `afterS` resolves to `0` for one. {@link setParkPolicy} refuses to store the
 * field on one for the same reason; this belt covers records written by
 * anything else.
 */
export function resolveParkPolicy(env: EnvironmentRecord): ResolvedParkPolicy {
  const park = env.park ?? {};
  return {
    afterS: env.ephemeral ? (park.afterS ?? DEFAULT_EPHEMERAL_PARK_AFTER_S) : 0,
    recallBuilds: park.recallBuilds ?? true,
    buildIdleS: park.buildIdleS ?? DEFAULT_BUILD_IDLE_S,
    wakeDeadlineS: park.wakeDeadlineS ?? DEFAULT_WAKE_DEADLINE_S,
  };
}

/**
 * Sets or clears an environment's park policy, as one CAS update on its
 * record. `null` clears the whole field, so the environment falls back to what
 * its kind implies; readers never see a stored-but-empty policy.
 */
export async function setParkPolicy(
  ctx: RegistryContext,
  project: string,
  env: string,
  policy: ParkPolicy | null,
): Promise<EnvironmentRecord> {
  if (policy !== null) assertPolicy(policy);

  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => {
      if (policy?.afterS !== undefined && !current.ephemeral) {
        throw new ScafoError("invalid-input", "Long-lived environments do not park", {
          detail:
            `"${project}/${env}" is not ephemeral: parking it on a clock would stop it ` +
            `under live traffic, so "afterS" is refused until scafo can measure traffic. ` +
            `Superseded-build recall ("recallBuilds", "buildIdleS") works on any environment`,
        });
      }
      const { park: _cleared, ...rest } = current;
      return policy === null ? rest : { ...rest, park: { ...policy } };
    },
  );
  return updated.value;
}

function assertPolicy(policy: ParkPolicy): void {
  const seconds: Array<[string, number | undefined]> = [
    ["afterS", policy.afterS],
    ["buildIdleS", policy.buildIdleS],
    ["wakeDeadlineS", policy.wakeDeadlineS],
  ];
  for (const [name, value] of seconds) {
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new ScafoError("invalid-input", "Invalid park policy", {
        detail: `"${name}" must be a whole number of seconds, got ${JSON.stringify(value)}`,
      });
    }
  }
  if (policy.wakeDeadlineS === 0) {
    throw new ScafoError("invalid-input", "Invalid park policy", {
      detail: `"wakeDeadlineS" cannot be 0: a wake nothing may wait for can never succeed`,
    });
  }
  if (policy.recallBuilds !== undefined && typeof policy.recallBuilds !== "boolean") {
    throw new ScafoError("invalid-input", "Invalid park policy", {
      detail: `"recallBuilds" must be true or false, got ${JSON.stringify(policy.recallBuilds)}`,
    });
  }
}
