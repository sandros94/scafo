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

/** Self-asserted source metadata stated by the caller that uploaded a build. */
export interface BuildSource {
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
 * An immutable deployment-history record. Key: `_scafo/projects/<project>/builds/<id>.json`.
 */
export interface BuildRecord {
  v: 1;
  id: string;
  celldVersionId?: string;
  source?: BuildSource;
  /** Present only when a verified workload token uploaded this build. */
  oidc?: OidcActor;
  createdAt: string;
}

/**
 * Caller-supplied half of a {@link BuildRecord}; `createdAt` is stamped by the registry.
 */
export interface BuildInput {
  id: string;
  celldVersionId?: string;
  source?: BuildSource;
  /** Auth-owned workload identity; deploy intake, not request metadata, sets this. */
  oidc?: OidcActor;
}

/** Monotonic notice that celld's current deployment changed. */
export interface DeploymentRevision {
  /** Increased once for every successful celld publication. */
  revision: number;
  /** When this revision was recorded. */
  deployedAt: string;
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

/** A single variable within a varset. */
export interface VarsetEntry {
  value: string;
  /** Secrets are never returned in plaintext by read APIs. */
  secret: boolean;
}

/** Decrypted varset contents, as seen after opening a {@link VarsetEnvelope}. */
export type PlainVarset = Record<string, VarsetEntry>;

/**
 * Encrypted varset as stored. `iv` and `ct` are b64url.
 * Key: `_scafo/projects/<project>/varsets/<name>.json`.
 */
export interface VarsetEnvelope {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
}
