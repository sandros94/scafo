/*
 * The seam between the daemon's deploy intake and whatever turns an uploaded
 * artifact into a version the runtime can serve. Core describes the contract; a
 * driver (`scafo/drivers/deploy/celld`) implements it, and the daemon wires the
 * two together.
 *
 * Everything impure about a deploy — unpacking the archive, running a builder,
 * writing to the bucket — lives behind this one call, which is what lets the
 * intake routes and their state machine be tested without any of it.
 */

/** Bucket an artifact is published into, and the credentials that reach it. */
export interface DeployTarget {
  endpoint: string;
  region: string;
  bucket: string;
  /**
   * Key prefix within the bucket the environment's fleet lives under, with the
   * installation's own key prefix already applied.
   */
  prefix: string;
  accessKey: string;
  secretKey: string;
}

/** Default compressed and expanded artifact limit: one gibibyte. */
export const DEFAULT_ARTIFACT_BYTES: number = 1_073_741_824;

/** Default number of entries one archive may contain. */
export const DEFAULT_ARCHIVE_ENTRIES: number = 20_000;

/**
 * One uploaded artifact, and where publishing it should land.
 *
 * The artifact is published exactly as it arrived: its runtime config is the
 * application's own, and nothing on this side of the seam rewrites it.
 */
export interface DeployRunInput {
  project: string;
  environment: string;
  /** The uploaded archive, exactly as it arrived and staged outside memory. */
  artifact: StagedArtifact;
  target: DeployTarget;
}

/**
 * A replayable, bounded artifact held outside the daemon's memory.
 *
 * The receiver owns disposal until it hands the artifact to deploy processing;
 * deploy processing owns it from then on and disposes it after every outcome.
 */
export interface StagedArtifact {
  /** Exact immutable number of staged bytes. */
  readonly byteLength: number;
  /** Opens a fresh byte stream from the beginning of the artifact. */
  open(): ReadableStream<Uint8Array>;
  /** Removes the artifact's backing storage. Idempotent. */
  dispose(): Promise<void>;
}

/** Controls one receive into staged storage. */
export interface ArtifactStageOptions {
  /** Maximum bytes accepted, checked before each write. */
  maxBytes: number;
  /** Cancels the receive and removes anything already staged. */
  signal: AbortSignal;
}

/** Runtime-specific storage behind the runtime-neutral deploy intake. */
export interface ArtifactStager {
  stage(source: ReadableStream<Uint8Array>, opts: ArtifactStageOptions): Promise<StagedArtifact>;
}

/** What publishing an artifact produced. */
export interface DeployRunResult {
  /** Version id the runtime assigned; the deployment record is filed under it. */
  celldVersionId: string;
}

/** Execution controls for one publish. */
export interface DeployRunOptions {
  /** Cancels the publish and resolves only once its child process is gone. */
  signal: AbortSignal;
}

/** Publishes an uploaded artifact into a fleet as a servable version. */
export interface DeployRunner {
  /**
   * Resolves with the version the artifact was published as. Throws when the
   * artifact is not a readable archive, or when publishing itself failed. A
   * runtime may already have published before it reports failure, so a runner
   * that detected a version must preserve that partial outcome in its error for
   * the caller to report honestly.
   */
  run(input: DeployRunInput, opts: DeployRunOptions): Promise<DeployRunResult>;
}
