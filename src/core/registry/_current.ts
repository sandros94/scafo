/* Internal current-build marker retained until the runtime becomes environment keyed. */

import type { EnvironmentUpdate } from "./environments.ts";
import { varsetWarnings } from "./_varset-warning.ts";
import type { BuildRecord, EnvironmentRecord } from "../types/registry.ts";
import { requireJson, updateJson } from "./cas.ts";
import { nowIso, type RegistryContext } from "./context.ts";
import { buildKey, environmentKey } from "./paths.ts";

/** Records the build a successful deploy made current in celld. */
export async function setCurrentBuild(
  ctx: RegistryContext,
  project: string,
  env: string,
  buildId: string,
  opts?: { signal?: AbortSignal },
): Promise<EnvironmentUpdate> {
  const build = await requireJson<BuildRecord>(ctx, buildKey(project, buildId));
  const updated = await updateJson<EnvironmentRecord>(
    ctx,
    environmentKey(project, env),
    (current) => ({
      ...current,
      alias: { build: buildId, flippedAt: nowIso(ctx) },
    }),
    opts,
  );
  return {
    environment: updated.value,
    warnings: varsetWarnings(updated.value, build.value),
  };
}
