/* Supervisor backed by `node:child_process`: one OS process per supervised id. */

import { type ChildProcess, spawn } from "node:child_process";
import { ScafoError } from "../../core/error.ts";
import type {
  ProcessSpec,
  ProcessStatus,
  StopOptions,
  Supervisor,
} from "../../core/types/supervisor.ts";

/** Time a stopped process is given between `SIGTERM` and `SIGKILL`. */
export const DEFAULT_GRACE_MS: number = 30_000;

/**
 * Runs supervised processes as children of the daemon. Statuses of exited
 * processes are kept until their id is started again, so a caller that polls
 * still learns how a process ended.
 *
 * Nothing here restarts anything: an exit the supervisor did not ask for is
 * reported through {@link Supervisor.onExit} and the policy is the caller's.
 */
export function createChildSupervisor(): Supervisor {
  const supervised = new Map<string, Supervised>();
  const listeners: ((status: ProcessStatus) => void)[] = [];

  return {
    async start(spec: ProcessSpec): Promise<ProcessStatus> {
      const current = supervised.get(spec.id);
      if (current !== undefined && current.status.state === "running") {
        throw new ScafoError("invalid-input", "Process id is already running", {
          detail: `"${spec.id}" must be stopped before it can be started under that id again`,
        });
      }

      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        /* The child stays in the daemon's process group, so a killed daemon
           takes its processes with it instead of orphaning them. */
        detached: false,
        /* TODO: capture stdout/stderr per process instead of inheriting the
           daemon's streams — output cannot be attributed to a process today. */
        stdio: "inherit",
      });

      const exit = Promise.withResolvers<void>();
      const entry: Supervised = {
        status: { id: spec.id, state: "running", startedAt: new Date().toISOString() },
        child,
        selfInflicted: false,
        exited: exit.promise,
      };
      supervised.set(spec.id, entry);

      child.on("exit", (code) => {
        entry.status = { ...entry.status, state: "exited", exitCode: code };
        entry.child = null;
        exit.resolve();
        if (entry.selfInflicted) return;
        for (const listener of listeners) listener({ ...entry.status });
      });

      return new Promise<ProcessStatus>((resolve, reject) => {
        let spawned = false;

        child.once("spawn", () => {
          spawned = true;
          entry.status = { ...entry.status, pid: child.pid };
          resolve({ ...entry.status });
        });

        child.on("error", (cause) => {
          /* Errors after a successful spawn are reported by the exit that follows. */
          if (spawned) return;
          /* The process never ran: drop it so its id is free for another attempt,
             and mark it so the exit that may follow reaches no listener. */
          entry.selfInflicted = true;
          supervised.delete(spec.id);
          exit.resolve();
          reject(
            new ScafoError("invalid-input", "Process could not be spawned", {
              detail: `"${spec.id}" could not run "${spec.command}"`,
              cause,
            }),
          );
        });
      });
    },

    async stop(id: string, opts?: StopOptions): Promise<void> {
      const entry = supervised.get(id);
      if (entry === undefined || entry.child === null) return;

      entry.selfInflicted = true;
      const child = entry.child;
      child.kill("SIGTERM");
      const grace = setTimeout(() => child.kill("SIGKILL"), opts?.graceMs ?? DEFAULT_GRACE_MS);
      try {
        await entry.exited;
      } finally {
        clearTimeout(grace);
      }
    },

    status(id: string): ProcessStatus | null {
      const entry = supervised.get(id);
      return entry === undefined ? null : { ...entry.status };
    },

    list(): ProcessStatus[] {
      return [...supervised.values()].map((entry) => ({ ...entry.status }));
    },

    onExit(cb: (status: ProcessStatus) => void): void {
      listeners.push(cb);
    },
  };
}

interface Supervised {
  status: ProcessStatus;
  /** The running process, or null once it has exited. */
  child: ChildProcess | null;
  /** True when the supervisor ended the process, so its exit stays unreported. */
  selfInflicted: boolean;
  /** Resolves once the process has exited. */
  exited: Promise<void>;
}
