/* Which of a node's own per-application directories may be removed. */

/** What one node knows about the local state it is holding. */
export interface LocalStatePlanInput {
  /** Applications this node holds a local directory for. */
  held: readonly string[];
  /**
   * Every application the registry holds, whatever state it is in.
   *
   * WHATEVER STATE, because only DELETION ends an application: a retired,
   * blocked, unplaced or reassigned one is still in the registry, may be served
   * from this node again, and its follower disk may hold writes a peer has
   * already acknowledged and not yet put in the bucket.
   *
   * The caller passes this only from a registry read that SUCCEEDED. A read
   * that failed is never "every application was deleted".
   */
  registered: ReadonlySet<string>;
  /** Applications with a process running on this node right now. */
  running: ReadonlySet<string>;
}

/**
 * The applications whose local directory this node may remove: the ones the
 * registry no longer holds and nothing here is still running.
 *
 * A RUNNING PROCESS KEEPS ITS DIRECTORY whatever the registry says. The process
 * has the files open and is still answering peers out of them, and the pass that
 * stops it is the one after which they may go.
 *
 * Pure: the caller does the removing, and reports what it could not remove as a
 * failure of its pass so the next one tries again.
 */
export function planLocalStateRemoval(input: LocalStatePlanInput): string[] {
  return input.held.filter(
    (application) => !input.registered.has(application) && !input.running.has(application),
  );
}
