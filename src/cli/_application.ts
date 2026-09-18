/*
 * The one place `--name` and `--env` become the application a command acts on.
 *
 * `--env` is a naming convenience and nothing else: the node never sees it, and
 * `--name shop --env preview` addresses the application `shop-preview` exactly
 * as `--name shop-preview` would. It is resolved here, client-side, so every
 * command spells the same rule the same way.
 */

import { ScafoError } from "../core/error.ts";
import { assertSlug, isSlug, SLUG_MAX_LENGTH } from "../core/utils/slug.ts";

/** The two flags every application-addressing command declares. */
export interface ApplicationFlags {
  /** `--name`, the application itself. */
  name?: string | undefined;
  /** `--env`, appended to the name with a hyphen. */
  env?: string | undefined;
}

/**
 * The application `--name` and `--env` address.
 *
 * Both halves are names in their own right, and so is what they make: a joined
 * name that is not one — too long for a DNS label, above all — is refused with
 * `invalid-slug` naming both parts, because the operator typed two things and
 * only one of them is likely to be the problem.
 */
export function resolveApplication(flags: ApplicationFlags): string {
  const name = text(flags.name);
  if (name === undefined) {
    throw new ScafoError("invalid-input", "Missing required argument", {
      detail: `--name must be given: the application to act on`,
    });
  }
  assertSlug(name);

  const env = text(flags.env);
  if (env === undefined) return name;
  assertSlug(env);

  const joined = `${name}-${env}`;
  if (!isSlug(joined)) {
    throw new ScafoError("invalid-slug", "Invalid application name", {
      detail:
        `--name "${name}" and --env "${env}" make "${joined}", which is ${String(joined.length)} ` +
        `characters and no application name: one is at most ${String(SLUG_MAX_LENGTH)} lowercase ` +
        `alphanumeric characters separated by single hyphens`,
    });
  }
  return joined;
}

function text(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
