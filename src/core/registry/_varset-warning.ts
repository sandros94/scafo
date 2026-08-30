import type { EnvironmentRecord, ScafoWarning } from "../types/registry.ts";

/** Internal advisory for the build a deploy actually published. */
export function varsetWarnings(
  environment: EnvironmentRecord,
  subject: { runtimeConfigurable: boolean; builtWithVarset?: string; id?: string },
): ScafoWarning[] {
  if (subject.runtimeConfigurable) return [];

  const envVarset = environment.varset ?? null;
  const buildVarset = subject.builtWithVarset ?? null;
  if (envVarset === buildVarset) return [];

  return [
    {
      code: "build-not-runtime-configurable",
      detail:
        `${subject.id === undefined ? "the current deployment" : `build "${subject.id}"`} was ` +
        `built against varset ${describe(buildVarset)} and cannot pick ` +
        `up configuration at runtime, but environment "${environment.name}" uses ` +
        `${describe(envVarset)}; rebuild to apply it`,
    },
  ];
}

function describe(varset: string | null): string {
  return varset === null ? "no varset" : `"${varset}"`;
}
