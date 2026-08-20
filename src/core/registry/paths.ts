/* Every bucket key the registry uses. Inputs are validated at the key builder. */

import { ScafoError } from "../error.ts";
import { assertHost } from "../utils/host.ts";
import { assertSlug } from "../utils/slug.ts";

/** Prefix all registry documents live under. */
const ROOT = "_scafo";

/** Content ids (builds, varsets) are lowercase hex digests. */
export const ID_RE: RegExp = /^[a-f\d]{8,64}$/;

/** Node ids double as celld session ids, which may contain underscores. */
export const NODE_ID_RE: RegExp = /^[a-z\d_-]{1,128}$/;

/** Throws `ScafoError("invalid-slug")` when `id` is not a content id. */
export function assertId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new ScafoError("invalid-slug", "Invalid content id", {
      detail: `"${id}" must be 8-64 lowercase hexadecimal characters`,
    });
  }
}

/** Throws `ScafoError("invalid-slug")` when `id` is not a node id. */
export function assertNodeId(id: string): void {
  if (!NODE_ID_RE.test(id)) {
    throw new ScafoError("invalid-slug", "Invalid node id", {
      detail: `"${id}" must be 1-128 lowercase alphanumerics, hyphens or underscores`,
    });
  }
}

export function metaKey(): string {
  return `${ROOT}/meta.json`;
}

export function coordinatorKey(): string {
  return `${ROOT}/coordinator/lease.json`;
}

/** Scratch key used by the store conformance probe; `token` is random hex. */
export function probeKey(token: string): string {
  assertId(token);
  return `${ROOT}/probe/${token}.json`;
}

export function nodesPrefix(): string {
  return `${ROOT}/nodes/`;
}

export function nodeKey(id: string): string {
  assertNodeId(id);
  return `${nodesPrefix()}${id}.json`;
}

/**
 * Prefix the placement decisions of one project live under. Listed once per
 * project rather than fetched per environment: an environment with no decision
 * yet has no object at all, and a listing says so without a read each.
 */
export function placementPrefix(project: string): string {
  assertSlug(project);
  return `${ROOT}/placement/${project}/`;
}

export function placementKey(project: string, env: string): string {
  assertSlug(env);
  return `${placementPrefix(project)}${env}.json`;
}

export function domainsPrefix(): string {
  return `${ROOT}/domains/`;
}

export function domainKey(host: string): string {
  assertHost(host);
  return `${domainsPrefix()}${host}.json`;
}

export function projectsPrefix(): string {
  return `${ROOT}/projects/`;
}

export function projectKey(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/project.json`;
}

export function trustKey(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/trust.json`;
}

export function buildsPrefix(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/builds/`;
}

export function buildKey(project: string, id: string): string {
  assertId(id);
  return `${buildsPrefix(project)}${id}.json`;
}

export function environmentsPrefix(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/environments/`;
}

export function environmentKey(project: string, env: string): string {
  assertSlug(env);
  return `${environmentsPrefix(project)}${env}.json`;
}

export function varsetsPrefix(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/varsets/`;
}

export function varsetKey(project: string, id: string): string {
  assertId(id);
  return `${varsetsPrefix(project)}${id}.json`;
}

/** Where a build's uploaded bundle lives. Outside `_scafo/`: it is not a record. */
export function artifactKey(project: string, buildId: string): string {
  assertSlug(project);
  assertId(buildId);
  return `artifacts/${project}/${buildId}.tar.zst`;
}

/**
 * Prefix an environment's fleet state lives under. It carries no trailing
 * separator, so listing under it must append one to avoid matching siblings
 * (`fleets/p/prod` would otherwise match `fleets/p/prod2/...`).
 */
export function fleetPrefix(project: string, env: string): string {
  assertSlug(project);
  assertSlug(env);
  return `fleets/${project}/${env}`;
}
