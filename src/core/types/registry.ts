/**
 * Shapes of the JSON documents that make up the registry. Every record carries
 * `v: 1`; readers must reject unknown versions. Keys are given relative to the
 * bucket root (or to the store prefix, when one is configured).
 */

/**
 * How many nodes serve one environment: a whole number of at least 1, or `"all"`
 * for every node that is live at the moment the decision is made.
 */
export type ReplicaCount = number | "all";

/** Exact-match AND selector. A node needs every listed label/value pair. */
export type NodeSelector = Record<string, string>;

/** Registry-wide settings written at bootstrap. Key: `_scafo/meta.json`. */
export interface RegistryMeta {
  v: 1;
  /** Apex domains the platform serves wildcard subdomains under. */
  platformDomains: string[];
  createdAt: string;
}

/**
 * Fenced lock held by the node currently acting as coordinator.
 * Key: `_scafo/coordinator/lease.json`.
 */
export interface CoordinatorLease {
  v: 1;
  /** Id of the node holding the lease. */
  node: string;
  acquiredAt: string;
  ttlMs: number;
  /** Monotonically increasing fencing token; stale holders are rejected by it. */
  fence: number;
}

/**
 * The fleet's deploy intake, stopped by an admin for a maintenance or an
 * upgrade. Key: `_scafo/freeze.json`, and its absence means deploys are taken.
 *
 * Serving is untouched while it stands: processes keep running, routing keeps
 * being published, and everything already deployed stays deployed. What stops
 * is intake, which every node refuses with `deploys-frozen` until it is lifted.
 */
export interface FreezeRecord {
  v: 1;
  frozenAt: string;
  /** Operator id of the admin who froze deploys, as their token was verified. */
  by: string;
  /** Why, when the admin said so; the first freeze's reason is the one that stands. */
  reason?: string;
}

/** Node WireGuard metadata for peers; the registry never holds private keys. */
export interface NodeWireguard {
  /** X25519 public key, base64 as `wg pubkey` prints it. */
  publicKey: string;
  /** `host:port` peers send this node's tunnel traffic to. */
  endpoint: string;
  /** The node's own address on the tunnel, with its prefix length: `10.83.0.1/24`. */
  address: string;
}

/** `admin` administers fleet keys; `operator` may administer only its replacement. */
export type OperatorRole = "admin" | "operator";

/** The two namespaces a registry identity may permanently belong to. */
export type IdentityKind = "node" | "operator";

/**
 * Durable first-claim record. Key: `_scafo/identities/<id>.json`.
 *
 * Deleting a node or an operator record deliberately leaves this object behind:
 * an id is a public-key identity, not a reusable name.
 */
export interface IdentityReservation {
  v: 1;
  kind: IdentityKind;
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
}

/** Trusted operator key. Its id is reserved across operator and node namespaces. */
export interface OperatorRecord {
  v: 1;
  id: string;
  /** Ed25519 public key every token signed by this operator is verified against. */
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  /** Omitted legacy roles read as admin; new records always set this. */
  role?: OperatorRole;
  /**
   * Key this one was registered to replace, recorded by the expand half of a
   * rotation. It is what authorizes the contract half: a key may revoke the one
   * it supersedes, whatever tier either of them is.
   */
  supersedes?: string;
  /** Project scope. Missing means no projects for an operator, all for an admin;
   * `*` grants all projects. */
  projects?: string[];
}

/** A registered node running the daemon. Key: `_scafo/nodes/<id>.json`. */
export interface NodeRecord {
  v: 1;
  id: string;
  /** Ed25519 public key used to verify the node's signatures. */
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  addresses: { internal: string; apiPort: number };
  /**
   * Last time the node's daemon said it is still there, refreshed on its own
   * timer. This is the liveness signal placement decides from.
   */
  heartbeatAt?: string;
  /** Graceful-shutdown marker. Draining nodes are ineligible despite heartbeat. */
  drainingAt?: string;
  /** Its place on the tunnel, when the installation runs one. */
  wireguard?: NodeWireguard;
  /** Selector labels, replaced from node boot configuration at registration. */
  labels?: Record<string, string>;
  /**
   * The binaries this node's daemon is running, written at registration from
   * what it actually started with and refreshed on every boot. The heartbeat
   * never touches it, so the field says what the running daemon started as and
   * not what a beat found later.
   *
   * Absent on a record written by a build that predates the field, which is why
   * a reader prints it as unreported rather than guessing a version.
   */
  versions?: NodeVersions;
  /**
   * What this node is serving right now, refreshed with the heartbeat: every
   * environment `project/env` it runs a process for, and the port that process
   * takes public traffic on at `addresses.internal`. This is what the fleet's
   * routing is rendered from. Absent means nothing — a node that has not said
   * what it serves is not routed to.
   */
  serving?: NodeServing;
}

/** Environments a node serves, by `project/env`, and where each one listens. */
export type NodeServing = Record<string, { port: number }>;

/** What a node is running: this build's own version, and the Celld it started. */
export interface NodeVersions {
  scafo: string;
  celld: string;
}

/** A project namespace. Key: `_scafo/projects/<slug>/project.json`. */
export interface ProjectRecord {
  v: 1;
  slug: string;
  /** Creation timestamp. Omitted legacy records are never backfilled. */
  createdAt?: string;
  /** `true` stops deploys, runtime, routing, and certificates without deleting
   * project records. Absence is unblocked. */
  blocked?: true;
  /** Caller-owned metadata, replaced wholesale and never interpreted by core. */
  labels?: Record<string, string>;
}

/** Self-asserted source metadata stated by the caller that uploaded a deployment. */
export interface DeploymentSource {
  provider: string;
  repo: string;
  ref: string;
  commit: string;
}

/** Immutable identity verified from a workload token at deploy intake. */
export interface OidcActor {
  issuer: string;
  subject: string;
}

/**
 * An immutable deployment-history record, one per thing Celld serves.
 * Key: `_scafo/projects/<project>/deployments/<version>.json`.
 */
export interface DeploymentRecord {
  v: 1;
  /** The Celld version this deployment is published as; it is also the key segment. */
  version: string;
  source?: DeploymentSource;
  /** Present only when a verified workload token uploaded this deployment. */
  oidc?: OidcActor;
  createdAt: string;
}

/**
 * Caller-supplied half of a {@link DeploymentRecord}; `createdAt` is stamped by the registry.
 */
export interface DeploymentInput {
  /** The version the runtime assigned; nothing else may name a deployment. */
  version: string;
  source?: DeploymentSource;
  /** Auth-owned workload identity; deploy intake, not request metadata, sets this. */
  oidc?: OidcActor;
}

/**
 * The varset a deployment carried, and the digest of its variables at that
 * moment. A later read of the varset says whether it still holds what was
 * deployed, which is the whole of what makes an edited varset visible.
 */
export interface CarriedVarset {
  name: string;
  hash: string;
}

/** Monotonic notice that celld's current deployment changed. */
export interface DeploymentRevision {
  /** Increased once for every deployment celld adopts. */
  revision: number;
  /** When this revision was recorded. */
  deployedAt: string;
  /** Varset this deployment carried; absent when it carried none. */
  varset?: CarriedVarset;
}

/**
 * A deployable environment of a project.
 * Key: `_scafo/projects/<project>/environments/<name>.json`.
 */
export interface EnvironmentRecord {
  v: 1;
  name: string;
  /** Bucket prefix the environment's fleet state lives under (`fleets/<project>/<name>`). */
  prefix: string;
  /** Deployment notice; `null` until the first successful deploy. Never names a version. */
  deployment: DeploymentRevision | null;
  /** Name of the project varset whose variables this environment's deploys carry. */
  varset?: string;
  domains: string[];
  ephemeral: boolean;
  /** Replica count; omitted resolves to all long-lived nodes or one ephemeral node. */
  replicas?: ReplicaCount;
  /** Eligible-node selector; `"all"` replicas means all matching live nodes. */
  nodeSelector?: NodeSelector;
  /** Retirement marker stops serving and becomes deletable after its grace period. */
  retiredAt?: string;
  createdAt: string;
}

/** Last coordinator placement decision. Absence means no process may start. */
export interface PlacementRecord {
  v: 1;
  /** Ids of the nodes that should run this environment, lexicographically sorted. */
  nodes: string[];
  decidedAt: string;
  /** Lease fence; stale coordinators cannot overwrite a newer decision. */
  fence: number;
}

/** An OIDC issuer allowed to deploy, restricted to specific subjects. */
export interface TrustIssuer {
  iss: string;
  aud: string;
  subjects: string[];
}

/** Deploy-time trust configuration. Key: `_scafo/projects/<project>/trust.json`. */
export interface TrustPolicy {
  v: 1;
  issuers: TrustIssuer[];
}

/** Ownership of a custom domain. Key: `_scafo/domains/<domain>.json`. */
export interface DomainClaim {
  v: 1;
  project: string;
  environment: string;
  claimedAt: string;
}

/**
 * Where one deploy has got to. `deployed` and `failed` are terminal: a deploy
 * that reached either has stopped moving and never moves again.
 */
export type DeployState = "accepted" | "uploading" | "deployed" | "failed";

/**
 * One deploy, from the moment a node accepted it to the moment it stopped
 * moving. Key: `_scafo/projects/<project>/deploys/<id>.json`.
 *
 * The state lives HERE rather than in the accepting node's memory, so that any
 * node of the installation answers a poll — behind an apex that fronts several
 * of them the poll lands wherever the ingress sends it — and so that a node
 * restarting mid-deploy leaves an operator with an answer rather than a
 * forgotten id.
 */
export interface DeployRecord {
  v: 1;
  /** `<project>.<16 hex>`; the project half is what authenticates a poll. */
  id: string;
  project: string;
  environment: string;
  state: DeployState;
  /** Node that accepted the deploy and is carrying it out. */
  node: string;
  acceptedAt: string;
  /** When the state last moved; the reaper reads it to spot an abandoned deploy. */
  updatedAt: string;
  /** Deployment the deploy produced, by version; absent until one has been recorded. */
  deployment?: string;
  /** Varset the deploy carried; absent when it carried none. */
  varset?: CarriedVarset;
  /** Why it failed, when it did. */
  detail?: string;
  /**
   * What the caller said it was deploying, and the workload identity that was
   * verified at intake. A deployment record carries both for a deploy that
   * reached one; these are the same trail for a deploy that never did.
   */
  source?: DeploymentSource;
  oidc?: OidcActor;
}

/**
 * Variables an environment's deploys carry, named per project and edited in
 * place. Key: `_scafo/projects/<project>/varsets/<name>.json`.
 */
export interface VarsetRecord {
  v: 1;
  name: string;
  vars: Record<string, string>;
  updatedAt: string;
}
