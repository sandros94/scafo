/* Every bucket key the registry uses. Inputs are validated at the key builder. */

import { ScafoError } from "../error.ts";
import { assertHost } from "../utils/host.ts";
import { assertSlug, isSlug } from "../utils/slug.ts";

/** Prefix all registry documents live under. */
const ROOT = "_scafo";

/**
 * Content ids (deployment versions) are lowercase hex digests; Celld's own are
 * the first sixteen characters of a sha256.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L467-L500 (v0.5.0)
 */
export const ID_RE: RegExp = /^[a-f\d]{8,64}$/;

/**
 * Node ids double as celld session ids, which may contain underscores.
 *
 * DELIBERATELY NARROWER than the names Celld admits — ASCII alphanumerics,
 * `_`, `-` and `.`, up to 128 bytes, and neither `.` nor `..` — so that every id
 * this accepts is a name a supervised process may be started under. That
 * containment is what `test/node-name.test.ts` proves, against the rule mirrored
 * from the release this build runs.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/peer.rs#L18-L25 (v0.5.0)
 */
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

/**
 * The installation's change hint: one object every node reads once a pass to
 * find out whether the registry is worth listing again.
 *
 * A HINT AND NOT A RECORD. Nothing about the installation is stored here, and
 * losing a write of it costs latency — bounded by the resync interval — rather
 * than correctness.
 */
export function changesKey(): string {
  return `${ROOT}/changes.json`;
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

/** Prefix every placement decision of the installation lives under. */
export function placementPrefix(): string {
  return `${ROOT}/placement/`;
}

export function placementKey(application: string): string {
  assertSlug(application);
  return `${placementPrefix()}${application}.json`;
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

/*
 * The layout below is FLAT AND KIND-PREFIXED: every kind of record has a prefix
 * of its own, so listing one kind never reads another kind's keys. That is what
 * keeps `_scafo/applications/` at exactly one key per application, and it is the
 * listing every node runs on every reconcile pass — a layout that filed an
 * application's history beneath its own name would make each of those passes
 * read every deployment and every deploy of the whole installation to learn the
 * names.
 *
 * Every per-application prefix carries its trailing separator, so listing under
 * `shop` never reaches `shop-preview` or `shop2`.
 */

export function applicationsPrefix(): string {
  return `${ROOT}/applications/`;
}

export function applicationKey(application: string): string {
  assertSlug(application);
  return `${applicationsPrefix()}${application}.json`;
}

export function trustKey(application: string): string {
  assertSlug(application);
  return `${ROOT}/trust/${application}.json`;
}

/**
 * Prefix EVERY application's deployment records live under.
 *
 * One listing of this answers the whole installation's deployment history, for
 * the same reason {@link deploysRootPrefix} exists: a listing per application is
 * one request per application on every sweep.
 */
export function deploymentsRootPrefix(): string {
  return `${ROOT}/deployments/`;
}

/** Prefix one application's deployment records live under, keyed by Celld version. */
export function deploymentsPrefix(application: string): string {
  assertSlug(application);
  return `${deploymentsRootPrefix()}${application}/`;
}

/**
 * The application and version a key under {@link deploymentsRootPrefix} names,
 * or null when the key is no deployment record of ours.
 */
export function parseDeploymentKey(key: string): { application: string; version: string } | null {
  const root = deploymentsRootPrefix();
  if (!key.startsWith(root) || !key.endsWith(".json")) return null;

  const rest = key.slice(root.length, -".json".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;

  const application = rest.slice(0, slash);
  const version = rest.slice(slash + 1);
  if (version.includes("/") || !isSlug(application) || !ID_RE.test(version)) return null;
  return { application, version };
}

export function deploymentKey(application: string, version: string): string {
  assertId(version);
  return `${deploymentsPrefix(application)}${version}.json`;
}

/** The unguessable half of a deploy id, as it is written and as it is read. */
const DEPLOY_TOKEN_RE = /^[a-f\d]{16}$/;

/** The two halves a deploy id is made of. */
export interface DeployIdParts {
  /** Application the deploy belongs to, and the only thing a poll can be authenticated against. */
  application: string;
  /** The unguessable half; knowing it is evidence of having started the deploy. */
  token: string;
}

/**
 * The application and token `id` names, or null when it is not a deploy id at all.
 *
 * The grammar lives here because this is where the key built from it is built:
 * a caller that split an id by hand would be the thing that put a read one
 * segment away from another application's records.
 */
export function parseDeployId(id: string): DeployIdParts | null {
  const dot = id.indexOf(".");
  if (dot < 0) return null;

  const application = id.slice(0, dot);
  const token = id.slice(dot + 1);
  /* A slug carries no dot, so the first one is the separator and anything
     before it that is not a slug makes the whole id no id of ours. */
  if (!isSlug(application) || !DEPLOY_TOKEN_RE.test(token)) return null;
  return { application, token };
}

/** Throws `ScafoError("invalid-slug")` when `id` is not a deploy id. */
export function assertDeployId(id: string): void {
  if (parseDeployId(id) !== null) return;

  throw new ScafoError("invalid-slug", "Invalid deploy id", {
    detail: `"${id}" must be an application name, a dot, and 16 lowercase hexadecimal characters`,
  });
}

/**
 * Prefix EVERY application's deploy records live under.
 *
 * One listing of this answers the whole installation's deploy history, which is
 * what the reaper walks: a listing per application would be one request per
 * application on every sweep, where this is one per thousand records.
 */
export function deploysRootPrefix(): string {
  return `${ROOT}/deploys/`;
}

/** Prefix one application's deploy records live under. */
export function deploysPrefix(application: string): string {
  assertSlug(application);
  return `${deploysRootPrefix()}${application}/`;
}

export function deployKey(application: string, id: string): string {
  assertDeployId(id);
  return `${deploysPrefix(application)}${id}.json`;
}

/**
 * The application and deploy a key under {@link deploysRootPrefix} names, or
 * null when the key is no deploy record of ours.
 *
 * The id must name the very application the key is filed under. A record that
 * disagrees with its own key is one nothing here may act on: the caller reading
 * it would be reading it on behalf of another application.
 */
export function parseDeployKey(key: string): { application: string; id: string } | null {
  const root = deploysRootPrefix();
  if (!key.startsWith(root) || !key.endsWith(".json")) return null;

  const rest = key.slice(root.length, -".json".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;

  const application = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  if (id.includes("/")) return null;

  const parsed = parseDeployId(id);
  if (parsed === null || parsed.application !== application) return null;
  return { application, id };
}

/**
 * Prefix an application's fleet state lives under. It carries no trailing
 * separator, so listing under it must append one to avoid matching siblings
 * (`fleets/shop` would otherwise match `fleets/shop2/...`).
 */
export function fleetPrefix(application: string): string {
  assertSlug(application);
  return `fleets/${application}`;
}

/*
 * The three keyspaces below are CELLD's, not the registry's. Scafo reads them —
 * to tell what an application is serving, and what it has published before —
 * and writes none of them: Celld owns everything under an application's fleet
 * prefix. They are named here all the same, because this file is where a key is
 * built and a caller that assembled one by hand would be the thing that put a
 * deletion one segment away from the wrong prefix.
 *
 * Their shapes are pinned to the Celld releases `_celld-contract.ts` names, and
 * every one below links the upstream lines it mirrors.
 */

/**
 * Prefix Celld publishes an application's deployments under; one deployment is
 * `<script>/<version>/` beneath it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L575 (v0.5.0)
 */
export function deployPrefix(application: string): string {
  return `${fleetPrefix(application)}/deploy/`;
}

/**
 * The fleet-wide pointer: the SOLE selector of what an application serves, and
 * the one object that says which publication must survive anything scafo
 * deletes underneath it.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L450-L460 (v0.5.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L842-L848 (v0.5.0)
 */
export function deployPointerKey(application: string): string {
  return `${deployPrefix(application)}current.json`;
}

/**
 * Prefix the static-asset blobs every deployment shares.
 *
 * Content-addressed, so two deployments that ship the same file name the same
 * blob: `assets/sha256/<first two hex>/<digest>` beneath here.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L433-L448 (v0.5.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/deploy.rs#L998-L1008 (v0.5.0)
 *
 * Only `scafo deployment prune` deletes under this prefix, and only by reference —
 * a blob every deployment that stays has stopped naming, once it is older than
 * the window that covers a deploy in flight.
 */
export function deployBlobsPrefix(application: string): string {
  return `${fleetPrefix(application)}/deploy-blobs/`;
}

/**
 * Prefix Celld saves container images under: one `<content key>.tar` per
 * image, shared by every deployment that runs it.
 *
 * A KEYSPACE OF CELLD'S PROTOCOL, not a deployment. Nothing here reads it, and
 * `scafo deployment prune` never weighs what is under it as one.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/container.rs#L67-L73 (v0.5.0)
 */
export function deployImagesPrefix(application: string): string {
  return `${deployPrefix(application)}images/`;
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
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/protocol.rs#L119-L141 (v0.5.0)
 */
export function deployQueuesPrefix(application: string): string {
  return `${deployPrefix(application)}queues/`;
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
