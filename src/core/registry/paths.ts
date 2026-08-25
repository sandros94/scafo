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

/**
 * The same charset as a node id, said separately because it is a different
 * NAME for the same rule.
 *
 * ONE ID SPACE, TWO NAMESPACES, and the shared regular expression is what makes
 * that true rather than nearly true: a machine and an operator key are refused
 * each other's ids ({@link nodeKey}, {@link operatorKey} and the guards in
 * `registry/nodes.ts` and `registry/operators.ts`), and a check like that is
 * only sound while both sides accept exactly the same strings. Were the two
 * charsets to drift apart, an id one namespace could hold and the other could
 * not would slip past the guard on the side that refuses it early.
 *
 * Throws `ScafoError("invalid-slug")`.
 */
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

/** Prefix the MACHINES of the fleet live under, and nothing else. */
export function nodesPrefix(): string {
  return `${ROOT}/nodes/`;
}

export function nodeKey(id: string): string {
  assertNodeId(id);
  return `${nodesPrefix()}${id}.json`;
}

/**
 * Prefix the OPERATOR KEYS the fleet trusts live under.
 *
 * A NAMESPACE OF ITS OWN, and it is the structural half of a boundary the code
 * used to keep by convention. Operator records once lived among the machines
 * under {@link nodesPrefix}, told apart by an address a machine would never
 * publish — which made one keyspace do two jobs. Every listing of the machines
 * had to know what an operator looked like or show one as a node that never
 * answers; a node id and an operator id could collide; and the refusal that kept
 * them apart had to say what was in the way, which meant naming a MACHINE's
 * internal address to whoever asked for the id.
 *
 * Split, a prefix listing IS the filtered view, and neither surface reads the
 * other's keys. What the split does not change is what a VERIFIER does with
 * them: a token is resolved against whichever namespace holds its `kid`, because
 * a node calling a peer and an operator calling a node are the same kind of
 * caller on every route but key administration.
 */
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

/**
 * Where wake stamps live: one per environment, one per woken superseded build.
 * The environment stamp and the build stamps share the environment's segment
 * (`<env>.json` beside `<env>/builds/…`), so one listing under the project
 * finds everything a reaper or a desired-state read could want.
 */
export function envWakeKey(project: string, env: string): string {
  assertSlug(project);
  assertSlug(env);
  return `${ROOT}/wake/${project}/${env}.json`;
}

export function buildWakesPrefix(project: string, env: string): string {
  assertSlug(project);
  assertSlug(env);
  return `${ROOT}/wake/${project}/${env}/builds/`;
}

export function buildWakeKey(project: string, env: string, build: string): string {
  assertId(build);
  return `${buildWakesPrefix(project, env)}${build}.json`;
}

/**
 * Prefix everything the nodes have flushed about themselves lives under.
 *
 * NODE-SCOPED ONE LEVEL DOWN, and that is the whole of the write rule: a node
 * writes only under its own segment and sweeps only its own segment, so no node
 * can delete another's history and a listing of one node costs only that node's
 * keys. Below it the path is the UTC calendar — `<YYYY>/<MM>/<DD>/<HH>/` — so a
 * reader asking for a window lists a node once and skips whole hours by name,
 * and the keys sort lexicographically in the order they were written.
 */
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

/**
 * Where one flush lands. `at` is the moment the flush was written and `seq` its
 * number since this node booted, which is what keeps two flushes of the same
 * millisecond apart; `extension` is the one the encoder that produced the bytes
 * declared, and is what tells a reader which decoder the file needs.
 */
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

/**
 * Inverse of {@link observeKey}; returns null for anything that is not one.
 *
 * The calendar segments are checked against the timestamp rather than read out
 * of it, so a key whose path and stamp disagree is not one of ours and is left
 * alone — which is what keeps a sweep from deleting a key it cannot account for.
 */
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

/**
 * Prefix the FLEET's OWN named locks live under.
 *
 * Deliberately apart from `_scafo/tls/locks/`, which is the same mechanism for a
 * different owner: the names under that one come from the colocated ingress
 * through `/v1/storage/locks`, free-form and validated only for being
 * addressable, so an ingress could otherwise take — or take over — a lock the
 * fleet's own writers serialize on. Names here are built from validated slugs
 * and file as `<name>.json`, like every other registry record.
 */
export function locksPrefix(): string {
  return `${ROOT}/locks/`;
}

/**
 * Lock every writer of one environment's DEPLOYMENT POINTER takes: the
 * reconciler rolling a build out on any node, and the deploy service publishing
 * an artifact on any node. One key per project and environment, because that is
 * the granularity of the pointer they contend for.
 */
export function pointerLockKey(project: string, env: string): string {
  assertSlug(project);
  assertSlug(env);
  return `${locksPrefix()}pointer/${project}/${env}.json`;
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
