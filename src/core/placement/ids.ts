/* The id convention tying a supervised process to what it serves. */

import { assertSlug, isSlug } from "../utils/slug.ts";

/**
 * Separator between the parts of a process id. Slugs never contain two hyphens
 * in a row, so the parts stay unambiguous.
 */
const SEPARATOR = "--";

/** What a process id encodes. */
export interface ProcessIdentity {
  project: string;
  env: string;
}

/**
 * Builds the supervisor id a runtime process runs under. One id per
 * project/environment. Deployments are adopted by that process in place.
 *
 * Throws `ScafoError("invalid-slug")` when a part is not a slug,
 * so an id can never name something the registry would refuse to address.
 */
export function formatProcessId(identity: ProcessIdentity): string {
  assertSlug(identity.project);
  assertSlug(identity.env);
  return [identity.project, identity.env].join(SEPARATOR);
}

/** Inverse of {@link formatProcessId}; returns null when `id` is not one. */
export function parseProcessId(id: string): ProcessIdentity | null {
  const parts = id.split(SEPARATOR);
  if (parts.length !== 2) return null;
  const [project, env] = parts;
  return isSlug(project) && isSlug(env) ? { project, env } : null;
}
