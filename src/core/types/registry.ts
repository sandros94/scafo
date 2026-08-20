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

/**
 * Non-fatal advisory returned alongside a successful operation. Warnings never
 * abort a call; `code` is the stable contract, `detail` is human-facing.
 */
export interface ScafoWarning {
  code: string;
  detail: string;
}

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

/** A registered node running the agent. Key: `_scafo/nodes/<id>.json`. */
export interface NodeRecord {
  v: 1;
  id: string;
  /** Ed25519 public key used to verify the node's signatures. */
  publicKey: { kty: "OKP"; crv: "Ed25519"; x: string };
  addresses: { internal: string; agentPort: number };
  /** Filled in by the node itself once it has probed its own hardware. */
  capacity?: { cores: number; memMb: number; cgroup: boolean; probedAt: string };
  /**
   * Last time the node's agent said it is still there, refreshed on its own
   * timer. This is the liveness signal placement decides from; a record without
   * it was written by a node that never refreshed one, and liveness then falls
   * back to `capacity.probedAt`.
   */
  heartbeatAt?: string;
  /**
   * When the node's agent said it is on its way out, written by the node itself
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
    idleTtlS?: number;
  };
}

/** Provenance of a build, as attested by the CI issuer that produced it. */
export interface BuildSource {
  provider: string;
  repo: string;
  ref: string;
  commit: string;
  /** OIDC `sub` claim of the workload that uploaded the build. */
  oidcSub?: string;
}

/**
 * An immutable build artifact. Key: `_scafo/projects/<project>/builds/<id>.json`.
 */
export interface BuildRecord {
  v: 1;
  id: string;
  /** Key of the uploaded artifact bundle. */
  artifact: string;
  celldVersionId?: string;
  /** Whether the build reads its configuration at runtime rather than at build time. */
  runtimeConfigurable: boolean;
  /** Varset the artifact was built against; drives the runtime-configurable warning. */
  builtWithVarset?: string;
  source?: BuildSource;
  createdAt: string;
}

/**
 * Caller-supplied half of a {@link BuildRecord}: `artifact` defaults to the
 * conventional artifact key and `createdAt` is stamped by the registry.
 */
export interface BuildInput {
  id: string;
  artifact?: string;
  celldVersionId?: string;
  runtimeConfigurable: boolean;
  builtWithVarset?: string;
  source?: BuildSource;
}

/** Which build an environment currently points at, plus the previous one for rollback. */
export interface AliasState {
  build: string;
  previous?: string;
  flippedAt: string;
}

/** One leg of a weighted traffic split. */
export interface SplitEntry {
  build: string;
  weight: number;
}

/**
 * A deployable environment of a project.
 * Key: `_scafo/projects/<project>/environments/<name>.json`.
 */
export interface EnvironmentRecord {
  v: 1;
  name: string;
  /** Host-label prefix this environment answers on. */
  prefix: string;
  /** Current build pointer (last flip); `null` until the first flip. */
  alias: AliasState | null;
  /** Weighted routing override; `null` when the alias alone serves traffic. */
  split: SplitEntry[] | null;
  varset?: string;
  domains: string[];
  placement: PlacementStrategy;
  /** Ephemeral environments are reaped once idle for `idleTtlS`. */
  ephemeral: boolean;
  idleTtlS?: number;
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
 * coordinator has decided yet, and every node then serves the environment. See
 * the node-side reader for why that fallback is the safe one.
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
