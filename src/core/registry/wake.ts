/*
 * Wake stamps: when an environment was last asked for.
 *
 * A stamp is a plain last-writer-wins write, deliberately outside the CAS
 * discipline everything else here follows: two nodes stamping the same wake
 * differ by milliseconds, either value keeps the subject awake, and a lost
 * write only parks it those milliseconds sooner. Parked-ness itself is never
 * stored — readers derive it from a stamp's age against the park policy — so
 * there is no state to repair after a crash, and the bucket stays the one
 * source of truth.
 */

import type { ActivitySource } from "./reaper.ts";
import { putJson, readJson } from "./cas.ts";
import type { RegistryContext } from "./context.ts";
import { nowIso } from "./context.ts";
import { envWakeKey } from "./paths.ts";

/** What a wake stamp records; the time is the whole of it. */
export interface WakeStamp {
  at: string;
}

/** Marks the environment awake as of now. Deploys count: a deploy is a wake. */
export async function stampEnvironmentWake(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<void> {
  await putJson<WakeStamp>(ctx, envWakeKey(project, env), { at: nowIso(ctx) });
}

/** When the environment was last woken, or null when it never was. */
export async function readEnvironmentWake(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<Date | null> {
  const found = await readJson<WakeStamp>(ctx, envWakeKey(project, env));
  if (found === null) return null;
  const at = Date.parse(found.value.at);
  return Number.isNaN(at) ? null : new Date(at);
}

/**
 * The reaper's view of these stamps: an environment's last wake is its last
 * activity. The fallback for an environment that has never been woken —
 * its current deployment, then its creation — stays where it always was, in the
 * reaper itself.
 */
export function wakeActivity(ctx: RegistryContext): ActivitySource {
  return {
    lastActiveAt: (project, env) => readEnvironmentWake(ctx, project, env),
  };
}
