/*
 * The seam between the agent and whatever actually runs processes on a node.
 * Core describes the contract; a driver (`scafo/drivers/supervisor/child`)
 * implements it, and the caller wires the two together.
 */

/** A process the agent asked a supervisor to run. */
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

/** Runs and stops processes on behalf of the agent. Restart policy is not its job. */
export interface Supervisor {
  start(spec: ProcessSpec): Promise<ProcessStatus>;
  /** Resolves once the process is gone; an unknown id is a no-op. */
  stop(id: string, opts?: StopOptions): Promise<void>;
  /** Last known status of `id`, including one that has already exited. */
  status(id: string): ProcessStatus | null;
  list(): ProcessStatus[];
  /** Fires on every exit the supervisor did not initiate; restart policy is the caller's. */
  onExit(cb: (status: ProcessStatus) => void): void;
}
