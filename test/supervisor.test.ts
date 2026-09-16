/*
 * The child-process supervisor against real OS processes: what a status says while a process runs
 * and once it is gone, which exits reach an `onExit` listener, and when a supervised id becomes
 * free again.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessSpec, ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { createChildSupervisor } from "../src/drivers/supervisor/child.ts";
import { rejectsWith } from "./_helpers.ts";

/** Stays up until it is killed; SIGTERM is left at its default, which ends it. */
const KEEPALIVE = "setInterval(() => {}, 1000)";

/** Ignores SIGTERM, so only the SIGKILL after the grace period ends it. */
const IGNORES_SIGTERM = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';

/** Ends itself shortly after start, with a code no signal death could produce. */
const SELF_EXIT = "setTimeout(() => process.exit(3), 100)";

/** Ceiling for anything that waits on process churn. */
const PROCESS_TIMEOUT_MS = 10_000;

let supervisor: Supervisor;

beforeEach(() => {
  supervisor = createChildSupervisor();
});

afterEach(async () => {
  /* A failed assertion must not leak a child process into the rest of the run;
     an id whose teardown already failed for good has nothing left to try. */
  await Promise.all(
    supervisor
      .list()
      .filter((status) => status.state === "running")
      .map((status) => supervisor.stop(status.id, { graceMs: 200 }).catch(() => {})),
  );
});

describe("starting a process", () => {
  it("reports it as running under one status every reader agrees on", async () => {
    const started = await supervisor.start(child("alive", KEEPALIVE));

    expect(started).toMatchObject({ id: "alive", state: "running" });
    expect(started.pid).toBeGreaterThan(0);
    expect(Date.parse(started.startedAt)).not.toBeNaN();
    expect(supervisor.status("alive")).toEqual(started);
    expect(supervisor.list()).toEqual([started]);
    expect(supervisor.status("never-started")).toBeNull();
  });

  it("refuses an id that is already running, and keeps the running process", async () => {
    const started = await supervisor.start(child("twice", KEEPALIVE));

    const error = await rejectsWith(
      () => supervisor.start(child("twice", KEEPALIVE)),
      "invalid-input",
    );

    expect(error.detail).toContain("twice");
    expect(supervisor.list()).toEqual([started]);
  });

  it("frees the id again once the process it named has exited", async () => {
    await supervisor.start(child("recycled", SELF_EXIT));
    expect(await untilExited("recycled")).toMatchObject({ state: "exited", exitCode: 3 });

    const restarted = await supervisor.start(child("recycled", KEEPALIVE));

    expect(restarted.state).toBe("running");
    expect(supervisor.list()).toEqual([restarted]);
  });

  it("resolves the command against the environment of the spec alone", async () => {
    /* The spec's `env` replaces the environment rather than extending it, so a
       command named without a path needs a PATH the spec itself carries. */
    await rejectsWith(
      () => supervisor.start({ id: "bare", command: "node", args: ["-e", ""], env: {} }),
      "invalid-input",
    );

    const started = await supervisor.start({
      id: "bare",
      command: "node",
      args: ["-e", KEEPALIVE],
      env: { PATH: process.env.PATH ?? "" },
    });

    expect(started.state).toBe("running");
  });

  it("rejects a command that cannot be spawned, leaving its id free to retry", async () => {
    const error = await rejectsWith(
      () =>
        supervisor.start({
          id: "retried",
          command: "scafo-test-no-such-binary",
          args: [],
          env: {},
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("scafo-test-no-such-binary");
    /* Nothing ran, so nothing is remembered: no status, and no id to release. */
    expect(supervisor.status("retried")).toBeNull();
    expect(supervisor.list()).toEqual([]);

    const started = await supervisor.start(child("retried", KEEPALIVE));

    expect(started.state).toBe("running");
  });
});

describe("stopping a process", () => {
  it(
    "resolves once a process that honours SIGTERM is gone",
    { timeout: PROCESS_TIMEOUT_MS },
    async () => {
      await supervisor.start(child("cooperative", KEEPALIVE));

      await supervisor.stop("cooperative");

      /* The caller asked for it to be gone, so there is nothing left to report. */
      expect(supervisor.status("cooperative")).toBeNull();
      expect(supervisor.list()).toEqual([]);
    },
  );

  it(
    "escalates to SIGKILL when the grace period runs out",
    { timeout: PROCESS_TIMEOUT_MS },
    async () => {
      await supervisor.start(child("stubborn", IGNORES_SIGTERM));
      const startedAtMs = Date.now();

      await supervisor.stop("stubborn", { graceMs: 200 });

      expect(Date.now() - startedAtMs).toBeLessThan(5000);
      expect(supervisor.status("stubborn")).toBeNull();
    },
  );

  it("does not return until every descendant in the process group is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "scafo-supervisor-group-"));
    const descendantFile = join(root, "descendant.pid");
    let descendantPid: number | undefined;

    try {
      const source = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "writeFileSync(process.env.SCAFO_DESCENDANT_PID, String(descendant.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const spec = child("family", source);
      spec.env = { SCAFO_DESCENDANT_PID: descendantFile };

      const parent = await supervisor.start(spec);
      descendantPid = await pidFrom(descendantFile);

      await supervisor.stop("family", { graceMs: 100 });

      expect(() => process.kill(parent.pid as number, 0)).toThrow(/kill ESRCH/);
      expect(() => process.kill(descendantPid as number, 0)).toThrow(/kill ESRCH/);
    } finally {
      killIfAlive(descendantPid);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never signals a group again once the kernel may have reclaimed its pid", async () => {
    const started = await supervisor.start(child("dangling", SELF_EXIT));
    const groupId = -(started.pid as number);
    const signalled: (string | number)[] = [];
    const restore = interceptGroupSignals(groupId, (signal) => {
      signalled.push(signal);
      /* The group is already empty, and naming it fails for a reason that says
         nothing about whether it was ever ours. */
      throw errno(signal === 0 ? "ESRCH" : "EACCES");
    });

    try {
      await expect.poll(() => signalled.length, { timeout: PROCESS_TIMEOUT_MS }).toBeGreaterThan(0);
      const attempted = signalled.length;

      /* The leader was reaped before that teardown ran, so it was the last one
         allowed to name the pid: a later stop replays its failure instead. */
      await rejectsWith(() => supervisor.stop("dangling"), "capability-missing");

      expect(signalled).toHaveLength(attempted);
    } finally {
      restore();
    }
  });

  it("retries a failed teardown while its leader still holds the pid", async () => {
    const started = await supervisor.start(child("held", KEEPALIVE));
    const restore = interceptGroupSignals(-(started.pid as number), () => {
      throw errno("EACCES");
    });

    try {
      await rejectsWith(() => supervisor.stop("held", { graceMs: 100 }), "capability-missing");
      /* Nothing was confirmed gone, so the process is still what it was. */
      expect(supervisor.status("held")).toMatchObject({ state: "running" });
    } finally {
      restore();
    }

    await supervisor.stop("held", { graceMs: 100 });

    expect(supervisor.status("held")).toBeNull();
  });

  it("is a no-op for an unknown id, and forgets one that has already exited", async () => {
    await expect(supervisor.stop("never-started")).resolves.toBeUndefined();

    await supervisor.start(child("brief", SELF_EXIT));
    expect(await untilExited("brief")).toMatchObject({ state: "exited", exitCode: 3 });

    await expect(supervisor.stop("brief")).resolves.toBeUndefined();
    expect(supervisor.status("brief")).toBeNull();
  });
});

describe("forgetting a process", () => {
  it("keeps an unexpected exit until it has been read, and drops it after", async () => {
    await supervisor.start(child("gone", SELF_EXIT));
    const exited = await untilExited("gone");

    /* The exit code is read by whoever asks next, not by the exit itself. */
    expect(exited).toMatchObject({ state: "exited", exitCode: 3 });
    expect(supervisor.list()).toEqual([exited]);

    supervisor.forget("gone");

    expect(supervisor.status("gone")).toBeNull();
    expect(supervisor.list()).toEqual([]);
  });

  it("leaves a running process alone, and says nothing about an unknown id", async () => {
    const started = await supervisor.start(child("busy", KEEPALIVE));

    supervisor.forget("busy");
    supervisor.forget("never-started");

    expect(supervisor.status("busy")).toEqual(started);
    expect(supervisor.list()).toEqual([started]);
  });
});

describe("exit notifications", () => {
  it("reports an exit the supervisor did not ask for, with the code it ended on", async () => {
    const exits: ProcessStatus[] = [];
    supervisor.onExit((status) => exits.push(status));

    await supervisor.start(child("crashes", SELF_EXIT));
    await untilExited("crashes");

    expect(exits).toEqual([
      expect.objectContaining({ id: "crashes", state: "exited", exitCode: 3 }),
    ]);
  });

  it(
    "stays silent about an exit the supervisor initiated",
    { timeout: PROCESS_TIMEOUT_MS },
    async () => {
      let calls = 0;
      supervisor.onExit(() => {
        calls++;
      });

      await supervisor.start(child("retired", KEEPALIVE));
      await supervisor.stop("retired");

      expect(supervisor.status("retired")).toBeNull();
      expect(calls).toBe(0);
    },
  );
});

/** A supervised process running `source` under the node binary of this test run. */
function child(id: string, source: string): ProcessSpec {
  return { id, command: process.execPath, args: ["-e", source], env: {} };
}

async function pidFrom(path: string): Promise<number> {
  await expect
    .poll(async () => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return "";
      }
    })
    .not.toBe("");
  return Number(await readFile(path, "utf8"));
}

/**
 * Hands every signal aimed at `groupId` to `handler`, passing everything else
 * to the kernel. Returns the undo, which the caller owes even on failure.
 */
function interceptGroupSignals(
  groupId: number,
  handler: (signal: string | number) => void,
): () => void {
  const real = process.kill.bind(process);
  const spy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== groupId) return real(target, signal);
    handler(signal ?? "SIGTERM");
    return true;
  });
  return () => {
    spy.mockRestore();
  };
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`kill ${code}`);
  error.code = code;
  return error;
}

function killIfAlive(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* Already gone, which is the expected path. */
  }
}

/** Waits for `id` to reach its final status, or fails the test that is waiting. */
async function untilExited(
  id: string,
  timeoutMs: number = PROCESS_TIMEOUT_MS,
): Promise<ProcessStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = supervisor.status(id);
    if (status !== null && status.state === "exited") return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`process "${id}" was still running after ${String(timeoutMs)}ms`);
}
