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

/** One uploaded artifact, and where publishing it should land. */
export interface DeployRunInput {
  project: string;
  environment: string;
  /** Name the runtime files this application under within the fleet. */
  script: string;
  /** The uploaded archive, exactly as it arrived. */
  artifact: Uint8Array;
  target: DeployTarget;
}

/** What publishing an artifact produced. */
export interface DeployRunResult {
  /** Version id the runtime assigned; the build record records it. */
  celldVersionId: string;
}

/** Publishes an uploaded artifact into a fleet as a servable version. */
export interface DeployRunner {
  /**
   * Resolves with the version the artifact was published as. Throws when the
   * artifact is not a readable archive, or when publishing itself failed; the
   * caller reports either as a failed deploy and keeps serving what it had.
   */
  run(input: DeployRunInput): Promise<DeployRunResult>;
}
