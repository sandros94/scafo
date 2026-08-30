import type { BuildRecord, EnvironmentRecord, ScafoWarning } from "../types/registry.ts";

/** Internal advisory shared by current-build and varset mutations. */
export function varsetWarnings(environment: EnvironmentRecord, build: BuildRecord): ScafoWarning[] {
  if (build.runtimeConfigurable) return [];

  const envVarset = environment.varset ?? null;
  const buildVarset = build.builtWithVarset ?? null;
  if (envVarset === buildVarset) return [];

  return [
    {
      code: "build-not-runtime-configurable",
      detail:
        `build "${build.id}" was built against varset ${describe(buildVarset)} and cannot pick ` +
        `up configuration at runtime, but environment "${environment.name}" uses ` +
        `${describe(envVarset)}; rebuild to apply it`,
    },
  ];
}

function describe(varset: string | null): string {
  return varset === null ? "no varset" : `"${varset}"`;
}
