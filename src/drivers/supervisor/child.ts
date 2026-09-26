/* Supervisor backed by `node:child_process`: one OS process per supervised id. */

import { type ChildProcess, spawn } from "node:child_process";
import { ScafoError } from "../../core/error.ts";
import type {
  ProcessSpec,
  ProcessStatus,
  StopOptions,
  Supervisor,
} from "../../core/types/supervisor.ts";
import { assertProcessGroups, processGroupId, stopProcessGroup } from "../_process-group.ts";

/** Time a stopped process is given between `SIGTERM` and `SIGKILL`. */
export const DEFAULT_GRACE_MS: number = 30_000;

/**
 * How many of a process's last stderr lines are kept, and how long each one may
 * be.
 *
 * SMALL ON PURPOSE. This is evidence for an operator asking why a process keeps
 * dying, not a log: five lines is what a runtime prints as it fails, and a cap
 * per line keeps one process that writes a megabyte-long line from sitting in
 * this daemon's memory and in every node record that quotes it.
 */
export const STDERR_TAIL_LINES: number = 5;
export const STDERR_LINE_MAX: number = 300;

/** Runs daemon child processes. What it remembers, and until when, is the
    {@link Supervisor} contract; restart policy remains with the caller. */
export function createChildSupervisor(): Supervisor {
  assertProcessGroups();
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
        /* Own a group so stop reaches runtime workers too. */
        detached: true,
        /*
         * STDERR IS PIPED AND FORWARDED, everything else is the daemon's own
         * stream. Piping it is what makes a process's last words attributable
         * to it — inherited, they land in the daemon's log among every other
         * process on the machine, and the one line that says why a process
         * keeps dying is gone by the time anybody asks. Forwarding them on
         * keeps the daemon's log exactly as complete as it was.
         *   TODO: stdout is still inherited and still unattributed.
         */
        stdio: ["inherit", "inherit", "pipe"],
      });

      const leaderExit = Promise.withResolvers<number | null>();
      leaderExit.promise.catch(() => {});
      const entry: Supervised = {
        status: { id: spec.id, state: "running", startedAt: new Date().toISOString() },
        child,
        selfInflicted: false,
        leaderExit: leaderExit.promise,
        tail: [],
      };
      supervised.set(spec.id, entry);
      readStderr(entry, child);

      child.on("exit", (code, signal) => {
        entry.child = null;
        if (signal !== null) entry.status = { ...entry.status, exitSignal: signal };
        leaderExit.resolve(code);
        if (!entry.selfInflicted) {
          /* The kernel has already reaped the leader, so this teardown — begun in
             the same turn as the exit — is the last one that may name its pid. */
          (entry.cleanup ??= finish(entry, true)).catch(() => {});
        }
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
          /* Free an unstarted id and suppress any following exit notification. */
          entry.selfInflicted = true;
          supervised.delete(spec.id);
          leaderExit.resolve(null);
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
      if (entry === undefined) return;
      /* Replays the one teardown this group got, including its failure. */
      if (entry.cleanup !== undefined) {
        await entry.cleanup;
        release(id, entry);
        return;
      }

      entry.selfInflicted = true;
      const cleanup = finish(entry, false, opts?.graceMs ?? DEFAULT_GRACE_MS);
      entry.cleanup = cleanup;
      try {
        await cleanup;
      } catch (error) {
        /* Only a leader the kernel has not reaped still holds its pid, and with
           it the group id: retry teardown only while that is true, because a
           freed pid names whichever group the kernel hands it to next. Otherwise
           keep the failure, so no later stop signals a group that is not ours. */
        if (entry.child !== null && entry.cleanup === cleanup) entry.cleanup = undefined;
        throw error;
      }
      release(id, entry);
    },

    status(id: string): ProcessStatus | null {
      const entry = supervised.get(id);
      return entry === undefined ? null : snapshot(entry);
    },

    list(): ProcessStatus[] {
      return [...supervised.values()].map((entry) => snapshot(entry));
    },

    forget(id: string): void {
      const entry = supervised.get(id);
      if (entry === undefined || entry.status.state === "running") return;
      supervised.delete(id);
    },

    onExit(cb: (status: ProcessStatus) => void): void {
      listeners.push(cb);
    },
  };

  /* Drops the id a stop has just emptied, unless something has started under it
     again since: the entry that was torn down is the one being released. */
  function release(id: string, entry: Supervised): void {
    if (supervised.get(id) === entry) supervised.delete(id);
  }

  async function finish(entry: Supervised, unexpected: boolean, graceMs?: number): Promise<void> {
    const groupId = processGroupId(entry.status.pid, entry.status.id);
    await stopProcessGroup(groupId, graceMs === undefined ? undefined : { graceMs });
    const code = await entry.leaderExit;
    entry.status = { ...entry.status, state: "exited", exitCode: code };
    if (unexpected) {
      /* The tail goes out WITH the exit, because it is the only moment anything
         is listening: whoever restarts this process is the same caller that
         reads why it stopped, and an id that is forgotten afterwards takes its
         lines with it. */
      for (const listener of listeners) listener(snapshot(entry));
    }
  }
}

/** The status as a caller sees it: what the process said, beside what it did. */
function snapshot(entry: Supervised): ProcessStatus {
  return {
    ...entry.status,
    ...(entry.tail.length === 0 ? {} : { lastError: [...entry.tail] }),
  };
}

/**
 * Keeps the last lines of one process's stderr, and puts every one of them on
 * the daemon's own stderr as it arrives.
 *
 * LINE BY LINE AND BOUNDED, so a process that writes without newlines cannot
 * grow this buffer: what has not ended in a newline is held as one partial
 * line, capped like any other, and flushed when the stream closes.
 */
function readStderr(entry: Supervised, child: ChildProcess): void {
  const stream = child.stderr;
  if (stream === null) return;

  stream.setEncoding("utf8");
  let partial = "";
  stream.on("data", (chunk: string) => {
    /* Forwarded verbatim, escapes included: the daemon's log is what it was
       before this was captured at all. */
    globalThis.process?.stderr?.write(chunk);
    const lines = (partial + chunk).split("\n");
    partial = clamp(lines.pop() ?? "");
    for (const line of lines) keepLine(entry, line);
  });
  stream.on("end", () => {
    keepLine(entry, partial);
    partial = "";
  });
  /* A stream that failed says nothing more; the process's exit is reported by
     the exit itself, and a throw here would take the daemon down with it. */
  stream.on("error", () => {});
}

/** Keeps one line, if it says anything, dropping the oldest to make room. */
function keepLine(entry: Supervised, line: string): void {
  const kept = clamp(line);
  if (kept === "") return;

  entry.tail.push(kept);
  while (entry.tail.length > STDERR_TAIL_LINES) entry.tail.shift();
}

/**
 * One stderr line as it is kept: terminal escapes taken off, trailing carriage
 * return and whitespace with them, and cut to length.
 *
 * THE ESCAPES GO BECAUSE THIS TEXT IS REPUBLISHED — into a node record, an API
 * document and a terminal that never saw the process — and a colour sequence
 * meant for the daemon's own terminal is noise in all three.
 */
/* ESC is spelled by its code so the pattern itself carries no control character. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[\\d;?]*[@-~]`, "g");

function clamp(line: string): string {
  const plain = line.replaceAll(ANSI_SEQUENCE, "").trim();
  return plain.length > STDERR_LINE_MAX ? `${plain.slice(0, STDERR_LINE_MAX)}…` : plain;
}

interface Supervised {
  status: ProcessStatus;
  /** The running process, or null once it has exited and its pid is reclaimable. */
  child: ChildProcess | null;
  /** True when the supervisor ended the process, so its exit stays unreported. */
  selfInflicted: boolean;
  /** Resolves once the direct group leader exits. */
  leaderExit: Promise<number | null>;
  /** Resolves only once every process in the owned group is gone. Set once the
      group has been signalled, and kept even when teardown failed. */
  cleanup?: Promise<void>;
  /** The last lines this process wrote to stderr, oldest first. */
  tail: string[];
}
