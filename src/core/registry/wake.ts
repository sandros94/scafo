/*
 * Wake stamps: when an environment or a superseded build was last asked for.
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
import { buildWakeKey, buildWakesPrefix, envWakeKey } from "./paths.ts";

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

/** Marks one superseded build awake as of now. */
export async function stampBuildWake(
  ctx: RegistryContext,
  project: string,
  env: string,
  build: string,
): Promise<void> {
  await putJson<WakeStamp>(ctx, buildWakeKey(project, env, build), { at: nowIso(ctx) });
}

/**
 * Every build wake the environment has, freshest first. Unreadable stamps are
 * skipped: a stamp exists to keep something awake, and one that cannot say
 * when keeps nothing awake.
 */
export async function listBuildWakes(
  ctx: RegistryContext,
  project: string,
  env: string,
): Promise<Map<string, Date>> {
  const prefix = buildWakesPrefix(project, env);
  const keys = await ctx.store.list(prefix);

  const wakes: Array<[string, Date]> = [];
  for (const key of keys) {
    const build = key.slice(prefix.length).replace(/\.json$/, "");
    if (build === "") continue;
    const found = await readJson<WakeStamp>(ctx, key);
    if (found === null) continue;
    const at = Date.parse(found.value.at);
    if (!Number.isNaN(at)) wakes.push([build, new Date(at)]);
  }
  wakes.sort((a, b) => b[1].getTime() - a[1].getTime());
  return new Map(wakes);
}

/**
 * The reaper's view of these stamps: an environment's last wake is its last
 * activity. The fallback for an environment that has never been woken —
 * its alias flip, then its creation — stays where it always was, in the
 * reaper itself.
 */
export function wakeActivity(ctx: RegistryContext): ActivitySource {
  return {
    lastActiveAt: (project, env) => readEnvironmentWake(ctx, project, env),
  };
}
