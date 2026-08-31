/**
 * Shapes of the JSON documents that make up the registry. Every record carries
 * `v: 1`; readers must reject unknown versions. Keys are given relative to the
 * bucket root (or to the store prefix, when one is configured).
 */

/**
 * How environments are packed onto nodes: `isolate` gives an environment its own
 * node, `dense` co-locates it with others, `auto` lets the coordinator decide.
 */
export type PlacementStrategy = "isolate" | "dense" | "auto";

/**
 * How many nodes serve one environment: a whole number of at least 1, or `"all"`
 * for every node that is live at the moment the decision is made.
 */
export type ReplicaCount = number | "all";

/**
 * Labels a node must carry for an environment to be allowed to run on it.
 *
 * AND semantics and exact values: a node is eligible when its own labels contain
 * EVERY entry of the selector with that entry's value. There are no operators
 * and no globs in v1 — a selector should mean one thing to whoever writes it and
 * to whoever debugs it a year later — and richer expressions are a compatible
 * later extension, because every selector expressible today keeps meaning
 * exactly this.
 */
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
 * Where a node sits on the WireGuard tunnel its installation runs on, as it
 * publishes it for its peers to build their own configuration from.
 *
 * Present only on a node whose transport is `wireguard`, and written by that
 * node itself: the keys are the operator's, generated with the operator's own
 * `wg`, and scafo never holds the private half in the registry.
 */
export interface NodeWireguard {
  /** X25519 public key, base64 as `wg pubkey` prints it. */
  publicKey: string;
  /** `host:port` peers send this node's tunnel traffic to. */
  endpoint: string;
  /** The node's own address on the tunnel, with its prefix length: `10.83.0.1/24`. */
  address: string;
}

/**
 * What an operator key is allowed to do to the set of keys the fleet trusts.
 *
 * TWO TIERS AND NO MORE, shaped the way an RBAC role is: `admin` administers
 * every key of the fleet, `operator` administers none but the one it replaced.
 * Everything else a token authorizes — deploying, retiring, reading — is the
 * same for both, because the split exists to stop a lockout and nothing else.
 */
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

/**
 * One key a fleet trusts. Key: `_scafo/operators/<id>.json`.
 *
 * A NAMESPACE OF ITS OWN, and nothing here says where anybody is: an operator
 * publishes no address, because nothing ever connects to one. That is the whole
 * difference from a {@link NodeRecord}, and it used to be spelled the other way
 * round — an operator was a node record carrying a sentinel address, which made
 * the absence of a machine into the presence of a fake one. See `operatorKey` in
 * `registry/paths.ts` for what the split buys.
 *
 * The id space is SHARED with the machines even though the keyspaces are not: an
 * id belongs to one identity or the other, never both, enforced from both sides.
 */
export interface OperatorRecord {
  v: 1;
  id: string;
  /** Ed25519 public key every token signed by this operator is verified against. */
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  /**
   * What this key may do to the fleet's trusted set.
   *
   * OPTIONAL BECAUSE A READ MUST NEVER BE A SILENT DEMOTION. A record carrying
   * none reads as an `admin` (`LEGACY_OPERATOR_ROLE`, `registry/operators.ts`),
   * which is what every key trusted before roles existed is worth. Nothing
   * writes one without a role any more, so a record carrying none today was
   * written straight to the bucket by hand.
   */
  role?: OperatorRole;
  /**
   * Key this one was registered to replace, recorded by the expand half of a
   * rotation. It is what authorizes the contract half: a key may revoke the one
   * it supersedes, whatever tier either of them is.
   */
  supersedes?: string;
  /**
   * Projects this key may name on a node's API, by slug — or `["*"]` for every
   * project of the fleet, which is a grant an ADMIN made rather than a default.
   *
   * REQUIRED ON AN OPERATOR-TIER KEY. Every path that grants one refuses to
   * write a record without it, so absent here means the record was written to
   * the bucket by hand — and it is read as NO project rather than as every one,
   * because reading it the other way is the silent widening scoping exists to
   * prevent. Such a key stays trusted and simply reaches nothing until an admin
   * repairs it.
   *
   * ABSENT IS EVERY PROJECT ON AN ADMIN, and never anything else: an admin
   * administers every key the fleet trusts, so it can grant itself a key for
   * anything at any time and a scope on one could enforce nothing.
   * `registry/operators.ts` refuses both combinations at write time.
   */
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
  /**
   * When the node's daemon said it is on its way out, written by the node itself
   * as the first step of a graceful shutdown.
   *
   * A node carrying it is NOT live for placement however fresh its heartbeat is,
   * so the coordinator hands its environments elsewhere on the next assignment
   * pass instead of waiting out the liveness window a crash costs. Registration
   * clears it, because a node that has started again serves again.
   */
  drainingAt?: string;
  /** Its place on the tunnel, when the installation runs one. */
  wireguard?: NodeWireguard;
  capabilities?: Record<string, unknown>;
  /**
   * What an operator said this node IS — its region, its hardware, its provider
   * — and what an environment's {@link NodeSelector} is matched against.
   *
   * BOOT CONFIGURATION, not runtime state: the node writes these from its own
   * configuration on every registration, and registration replaces the record
   * wholesale, so a label removed from the configuration is gone from the record
   * on the next start. Nothing else ever writes them.
   */
  labels?: Record<string, string>;
}

/** A project namespace. Key: `_scafo/projects/<slug>/project.json`. */
export interface ProjectRecord {
  v: 1;
  slug: string;
  placement: PlacementStrategy;
  /** Defaults applied to ephemeral preview environments created under this project. */
  previewDefaults?: {
    varset?: string;
    placement?: PlacementStrategy;
  };
  /**
   * When the project came into being, stamped by the create that made it.
   *
   * NEVER BACKFILLED. Absent means the record predates the field — the project
   * is older than this, and nothing in the registry knows how much older. A
   * stamp written on the first read that noticed it missing would say the
   * project began the day somebody happened to look, which is a worse answer
   * than no answer for the one thing this field is for: telling a downstream
   * platform how long it has been billing for something.
   */
  createdAt?: string;
  /**
   * Set by an ADMIN of the fleet to take the whole project out of service.
   *
   * A FULL STOP AND A REVERSIBLE ONE. A blocked project is served nowhere — no
   * node runs a process for it, no route names it, no certificate is issued for
   * its domains — its hosts are not woken, and deploys into it are refused. The
   * environment, build, deployment, domain and placement records are all left exactly
   * as they stand, which is what makes the way back one call: the next reconcile
   * pass wants everything it wanted before.
   *
   * ABSENT IS NOT BLOCKED, and it has to be: a project comes into being on its
   * first deploy, and starting to serve must never depend on a field having been
   * written. `true` is the only value that means anything; `false` is not
   * written, because a flag with three states is one somebody reads wrong.
   *
   * WHY it was blocked is not core's business. The case this exists for is a
   * downstream platform's unpaid invoice, and core's contract is to MEASURE and
   * to ACTUATE — the policy that decides when to pull the lever lives with
   * whoever sends the invoice.
   */
  blocked?: true;
  /**
   * What somebody said this project IS, for their own purposes.
   *
   * FREE-FORM, AND CORE NEVER INTERPRETS THEM. Nothing in scafo reads a key or a
   * value here, branches on one, or refuses a pair it does not recognise — they
   * exist so a platform BUILT ON scafo can tag a project with its own billing
   * account, its client's name or its plan, and read it back through the API it
   * already talks to. The moment core started reading one, the map would stop
   * being the caller's and become a configuration surface with undocumented
   * keys.
   *
   * Written wholesale by whoever sets them: a call states the entire map, so a
   * label dropped downstream is gone here rather than surviving forever. That is
   * the same rule a node's own labels follow, and for the same reason — the
   * writer is the authority on what the set now is.
   */
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
  placement: PlacementStrategy;
  ephemeral: boolean;
  /**
   * How many nodes serve this environment. Absent means the default its kind
   * implies — `"all"` when it is long-lived, `1` when it is ephemeral — which is
   * what a reader resolves rather than assumes.
   */
  replicas?: ReplicaCount;
  /**
   * Which nodes may serve this environment at all. Absent leaves it
   * unconstrained, which is every live node.
   *
   * It narrows the CANDIDATES the coordinator picks replicas from, so it and
   * {@link EnvironmentRecord.replicas} compose rather than compete: `"all"` with
   * a selector means every MATCHING node.
   */
  nodeSelector?: NodeSelector;
  /**
   * When the environment was retired: the first of the two steps that
   * decommission a long-lived environment.
   *
   * A retired environment stops being served — no node runs a process for it, no
   * route names it, no certificate is issued for its domains — and becomes
   * deletable once it has carried this for longer than the grace period. It is
   * reversible until then: clearing it puts the environment straight back into
   * service.
   */
  retiredAt?: string;
  createdAt: string;
}

/**
 * Which nodes serve one environment, as the coordinator last decided it.
 * Key: `_scafo/placement/<project>/<env>.json`.
 *
 * The ABSENCE of this record is meaningful and is not an error: it says no
 * coordinator has decided yet. A daemon starts nothing until one exists.
 */
export interface PlacementRecord {
  v: 1;
  /** Ids of the nodes that should run this environment, lexicographically sorted. */
  nodes: string[];
  decidedAt: string;
  /**
   * Fence of the coordinator lease the decision was made under. A coordinator
   * never overwrites a decision made at a HIGHER fence than its own: that
   * decision belongs to the node that superseded it.
   */
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
