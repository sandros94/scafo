/* Every bucket key the registry uses. Inputs are validated at the key builder. */

import { ScafoError } from "../error.ts";
import { assertHost } from "../utils/host.ts";
import { assertSlug, isSlug } from "../utils/slug.ts";

/** Prefix all registry documents live under. */
const ROOT = "_scafo";

/** Content ids (deployment versions) are lowercase hex digests. */
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

/** The fleet-wide deploy freeze; its absence is what "deploys are taken" means. */
export function freezeKey(): string {
  return `${ROOT}/freeze.json`;
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

/** Prefix one project's deployment records live under, keyed by Celld version. */
export function deploymentsPrefix(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/deployments/`;
}

export function deploymentKey(project: string, version: string): string {
  assertId(version);
  return `${deploymentsPrefix(project)}${version}.json`;
}

/** The unguessable half of a deploy id, as it is written and as it is read. */
const DEPLOY_TOKEN_RE = /^[a-f\d]{16}$/;

/** The two halves a deploy id is made of. */
export interface DeployIdParts {
  /** Project the deploy belongs to, and the only thing a poll can be authenticated against. */
  project: string;
  /** The unguessable half; knowing it is evidence of having started the deploy. */
  token: string;
}

/**
 * The project and token `id` names, or null when it is not a deploy id at all.
 *
 * The grammar lives here because this is where the key built from it is built:
 * a caller that split an id by hand would be the thing that put a read one
 * segment away from another project's records.
 */
export function parseDeployId(id: string): DeployIdParts | null {
  const dot = id.indexOf(".");
  if (dot < 0) return null;

  const project = id.slice(0, dot);
  const token = id.slice(dot + 1);
  /* A slug carries no dot, so the first one is the separator and anything
     before it that is not a slug makes the whole id no id of ours. */
  if (!isSlug(project) || !DEPLOY_TOKEN_RE.test(token)) return null;
  return { project, token };
}

/** Throws `ScafoError("invalid-slug")` when `id` is not a deploy id. */
export function assertDeployId(id: string): void {
  if (parseDeployId(id) !== null) return;

  throw new ScafoError("invalid-slug", "Invalid deploy id", {
    detail: `"${id}" must be a project slug, a dot, and 16 lowercase hexadecimal characters`,
  });
}

/** Prefix one project's deploy records live under. */
export function deploysPrefix(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/deploys/`;
}

export function deployKey(project: string, id: string): string {
  assertDeployId(id);
  return `${deploysPrefix(project)}${id}.json`;
}

export function environmentsPrefix(project: string): string {
  assertSlug(project);
  return `${projectsPrefix()}${project}/environments/`;
}

export function environmentKey(project: string, env: string): string {
  assertSlug(env);
  return `${environmentsPrefix(project)}${env}.json`;
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

/*
 * The three keyspaces below are CELLD's, not the registry's. Scafo reads them —
 * to tell what an environment is serving, and what it has published before —
 * and writes none of them: Celld owns everything under an environment's fleet
 * prefix. They are named here all the same, because this file is where a key is
 * built and a caller that assembled one by hand would be the thing that put a
 * deletion one segment away from the wrong prefix.
 */

/** Prefix Celld publishes an environment's deployments under. */
export function deployPrefix(project: string, env: string): string {
  return `${fleetPrefix(project, env)}/deploy/`;
}

/**
 * The fleet-wide pointer: the SOLE selector of what an environment serves, and
 * the one object that says which publication must survive anything scafo
 * deletes underneath it.
 */
export function deployPointerKey(project: string, env: string): string {
  return `${deployPrefix(project, env)}current.json`;
}

/**
 * Prefix the static-asset blobs every deployment shares.
 *
 * Content-addressed, so two deployments that ship the same file name the same
 * blob: `assets/sha256/<first two hex>/<digest>` beneath here. Only
 * `scafo deployment prune` deletes under this prefix, and only by reference —
 * a blob every deployment that stays has stopped naming, once it is older than
 * the window that covers a deploy in flight.
 */
export function deployBlobsPrefix(project: string, env: string): string {
  return `${fleetPrefix(project, env)}/deploy-blobs/`;
}

/**
 * Prefix Celld saves container images under: one `<content key>.tar` per
 * image, shared by every deployment that runs it.
 *
 * A KEYSPACE OF CELLD'S PROTOCOL, not a deployment. Nothing here reads it, and
 * `scafo deployment prune` never weighs what is under it as one.
 */
export function deployImagesPrefix(project: string, env: string): string {
  return `${deployPrefix(project, env)}images/`;
}

/**
 * Prefix Celld records queue consumers under: one
 * `<queue>/consumer.json` naming the single deployment allowed to consume that
 * fleet-global queue.
 *
 * A KEYSPACE OF CELLD'S PROTOCOL, not a deployment, though it sits at the same
 * depth as one. Nothing here reads it and `scafo deployment prune` never
 * deletes under it: an attachment outlives the deploy that wrote it, and the
 * fleet that stops consuming a queue is Celld's to decide, not scafo's.
 */
export function deployQueuesPrefix(project: string, env: string): string {
  return `${deployPrefix(project, env)}queues/`;
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
