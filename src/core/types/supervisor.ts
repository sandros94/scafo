/*
 * The seam between the daemon and whatever actually runs processes on a node.
 * Core describes the contract; a driver (`scafo/drivers/supervisor/child`)
 * implements it, and the caller wires the two together.
 */

/** A process the daemon asked a supervisor to run. */
export interface ProcessSpec {
  /** Unique per supervised process; reusing an id while it runs is an error. */
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export type ProcessState = "running" | "exited";

export interface ProcessStatus {
  id: string;
  state: ProcessState;
  pid?: number;
  /** Set once the process has exited; `null` when a signal ended it. */
  exitCode?: number | null;
  startedAt: string;
}

export interface StopOptions {
  /** Time between `SIGTERM` and the `SIGKILL` that follows it. Defaults to 30_000. */
  graceMs?: number;
}

/**
 * Runs and stops processes on behalf of the daemon. Restart policy is not its job.
 *
 * WHAT A SUPERVISOR REMEMBERS, AND FOR HOW LONG: an id is known from the moment
 * it starts. A process the caller stopped is forgotten as soon as its teardown
 * succeeds — the caller asked for it to be gone, and a teardown that failed
 * keeps it so the stop can be retried. A process that ended on its own is kept
 * as `exited` until {@link Supervisor.forget}, because the exit code is read by
 * whoever asks next rather than by the exit itself. Nothing else is retained, so
 * what a supervisor holds is bounded by what is running plus the exits nobody
 * has read yet.
 */
export interface Supervisor {
  start(spec: ProcessSpec): Promise<ProcessStatus>;
  /**
   * Resolves once the process is gone and the id is forgotten with it; an
   * unknown id is a no-op. A teardown that failed rejects and keeps the id.
   */
  stop(id: string, opts?: StopOptions): Promise<void>;
  /** Last known status of `id`, including one that has exited and not been forgotten. */
  status(id: string): ProcessStatus | null;
  /** Every id the supervisor still holds, running or exited and unread. */
  list(): ProcessStatus[];
  /**
   * Drops an exited id once its exit has been read. A running process cannot be
   * forgotten — it is stopped — and an unknown id is a no-op.
   */
  forget(id: string): void;
  /** Fires on every exit the supervisor did not initiate; restart policy is the caller's. */
  onExit(cb: (status: ProcessStatus) => void): void;
}
