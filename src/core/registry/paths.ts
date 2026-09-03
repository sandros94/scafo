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

/** Validates an operator id with the node-id charset to preserve shared identity space. */
export function assertOperatorId(id: string): void {
  if (!NODE_ID_RE.test(id)) {
    throw new ScafoError("invalid-slug", "Invalid operator id", {
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

/** Prefix for node records. */
export function nodesPrefix(): string {
  return `${ROOT}/nodes/`;
}

export function nodeKey(id: string): string {
  assertNodeId(id);
  return `${nodesPrefix()}${id}.json`;
}

/** Prefix for trusted operator records, isolated from node records. */
export function operatorsPrefix(): string {
  return `${ROOT}/operators/`;
}

export function operatorKey(id: string): string {
  assertOperatorId(id);
  return `${operatorsPrefix()}${id}.json`;
}

/** Durable identity reservations, one conditional-create object per shared id. */
export function identitiesPrefix(): string {
  return `${ROOT}/identities/`;
}

export function identityKey(id: string): string {
  assertNodeId(id);
  return `${identitiesPrefix()}${id}.json`;
}

/** Prefix for one project's placement decisions. */
export function placementPrefix(project: string): string {
  assertSlug(project);
  return `${ROOT}/placement/${project}/`;
}

export function placementKey(project: string, env: string): string {
  assertSlug(env);
  return `${placementPrefix(project)}${env}.json`;
}

/** Prefix for node-scoped observation records, partitioned by UTC hour. */
export function observePrefix(): string {
  return `${ROOT}/observe/`;
}

export function observeNodePrefix(nodeId: string): string {
  assertNodeId(nodeId);
  return `${observePrefix()}${nodeId}/`;
}

/** Prefix one node's flushes of one UTC day live under. */
export function observeDayPrefix(nodeId: string, at: Date): string {
  const day = [
    String(at.getUTCFullYear()).padStart(4, "0"),
    String(at.getUTCMonth() + 1).padStart(2, "0"),
    String(at.getUTCDate()).padStart(2, "0"),
  ].join("/");
  return `${observeNodePrefix(nodeId)}${day}/`;
}

/** Prefix one node's flushes of one UTC hour live under. */
export function observeHourPrefix(nodeId: string, at: Date): string {
  return `${observeDayPrefix(nodeId, at)}${String(at.getUTCHours()).padStart(2, "0")}/`;
}

/** Digits a flush's sequence number is padded to, so a listing sorts by write order. */
const OBSERVE_SEQ_DIGITS = 6;

/** Key for one flush; sequence prevents same-millisecond collisions. */
export function observeKey(nodeId: string, at: Date, seq: number, extension: string): string {
  if (!/^[a-z\d]{1,16}$/.test(extension)) {
    throw new ScafoError("invalid-input", "Invalid observation extension", {
      detail: `"${extension}" must be 1-16 lowercase alphanumerics`,
    });
  }
  const name = `${String(at.getTime())}-${String(seq).padStart(OBSERVE_SEQ_DIGITS, "0")}`;
  return `${observeHourPrefix(nodeId, at)}${name}.${extension}`;
}

/** What an observation key says about itself. */
export interface ObserveKeyParts {
  /** Node that wrote it, which is the only node allowed to delete it. */
  node: string;
  /** Moment it was written, in epoch milliseconds. */
  atMs: number;
  /** Its writer's flush number since that node booted. */
  seq: number;
  /** Filename extension, without the dot: which decoder the file needs. */
  extension: string;
}

/** Parses an observation key; calendar/timestamp mismatch is rejected to protect sweeps. */
export function parseObserveKey(key: string): ObserveKeyParts | null {
  const root = observePrefix();
  if (!key.startsWith(root)) return null;

  const parts = key.slice(root.length).split("/");
  if (parts.length !== 6) return null;

  const [node, , , , , name] = parts;
  if (!NODE_ID_RE.test(node)) return null;

  const match = /^(\d{1,15})-(\d{1,15})\.([a-z\d]{1,16})$/.exec(name);
  if (match === null) return null;

  const atMs = Number(match[1]);
  const at = new Date(atMs);
  if (!Number.isFinite(atMs) || Number.isNaN(at.getTime())) return null;
  if (observeHourPrefix(node, at) !== `${root}${parts.slice(0, 5).join("/")}/`) return null;

  return { node, atMs, seq: Number(match[2]), extension: match[3] };
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

/**
 * Prefix the TLS material an ingress persists through this node lives under:
 * its certificates, its account keys, and anything else it must keep across
 * restarts. The keys beneath it are the CALLER's, not the registry's — nothing
 * here parses them.
 */
export function tlsObjectsPrefix(): string {
  return `${ROOT}/tls/objects/`;
}

export function tlsObjectKey(key: string): string {
  assertTlsKey(key);
  return `${tlsObjectsPrefix()}${key}`;
}

/** Prefix the named locks that serialize TLS issuance live under. */
export function tlsLocksPrefix(): string {
  return `${ROOT}/tls/locks/`;
}

export function tlsLockKey(name: string): string {
  assertTlsKey(name);
  return `${tlsLocksPrefix()}${name}`;
}

/**
 * Throws `ScafoError("invalid-input")` when `key` could not name one TLS object
 * or one lock: it is empty, absolute, carries an empty, `.` or `..` segment, or
 * holds a character outside printable ASCII.
 *
 * The relative-path rules are what keep a caller's key inside the prefix it was
 * given — `..` would otherwise address a registry record — and the charset is
 * what keeps a key addressable in a bucket that is not this one.
 */
export function assertTlsKey(key: string): void {
  const wrong = tlsKeyProblem(key);
  if (wrong === null) return;

  throw new ScafoError("invalid-input", "Invalid storage key", { detail: `"${key}" ${wrong}` });
}

/** Why `key` is unusable, or null when it is fine. */
function tlsKeyProblem(key: string): string | null {
  if (key === "") return "is empty";
  if (key.startsWith("/")) return "is absolute, and keys are relative to the storage root";
  if (!/^[ -~]+$/.test(key)) return "holds a character outside printable ASCII";

  for (const segment of key.split("/")) {
    if (segment === "") return "has an empty segment";
    if (segment === "." || segment === "..") return `has a "${segment}" segment`;
  }
  return null;
}
