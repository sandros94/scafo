/* The id convention tying a supervised process to what it serves. */

import { assertId, ID_RE } from "../registry/paths.ts";
import { assertSlug, isSlug } from "../utils/slug.ts";

/**
 * Separator between the parts of a process id. Slugs never contain two hyphens
 * in a row and build ids are hexadecimal, so the parts stay unambiguous.
 */
const SEPARATOR = "--";

/** Matches the retry part of a process id. */
const RETRY_RE = /^r(\d+)$/;

/** What a process id encodes. */
export interface ProcessIdentity {
  project: string;
  env: string;
  build: string;
  /** Attempt number, when an earlier process for the same three parts is still around. */
  retry?: number;
}

/**
 * Builds the supervisor id a runtime process runs under. One id per
 * project/environment/build, which is what makes a second build of the same
 * environment a second process rather than a restart of the first.
 *
 * Throws `ScaloError("invalid-slug")` when a part is not a slug or a content id,
 * so an id can never name something the registry would refuse to address.
 */
export function formatProcessId(identity: ProcessIdentity): string {
  assertSlug(identity.project);
  assertSlug(identity.env);
  assertId(identity.build);

  const parts = [identity.project, identity.env, identity.build];
  if (identity.retry !== undefined) parts.push(`r${String(identity.retry)}`);
  return parts.join(SEPARATOR);
}

/** Inverse of {@link formatProcessId}; returns null when `id` is not one. */
export function parseProcessId(id: string): ProcessIdentity | null {
  const parts = id.split(SEPARATOR);
  if (parts.length < 3 || parts.length > 4) return null;

  const [project, env, build, retry] = parts;
  if (!isSlug(project) || !isSlug(env) || !ID_RE.test(build)) return null;
  if (retry === undefined) return { project, env, build };

  const match = RETRY_RE.exec(retry);
  return match === null ? null : { project, env, build, retry: Number(match[1]) };
}
