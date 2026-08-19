/*
 * The child-process supervisor against real OS processes: what a status says
 * while a process runs and once it is gone, which exits reach an `onExit`
 * listener, and when a supervised id becomes free again.
 *
 * Fixture processes are inline scripts run by the same node binary this suite
 * runs under, so nothing has to be installed for them to work.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  /* A failed assertion must not leak a child process into the rest of the run. */
  await Promise.all(
    supervisor
      .list()
      .filter((status) => status.state === "running")
      .map((status) => supervisor.stop(status.id, { graceMs: 200 })),
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
          command: "scalo-test-no-such-binary",
          args: [],
          env: {},
        }),
      "invalid-input",
    );

    expect(error.detail).toContain("scalo-test-no-such-binary");
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

      /* A signal death carries no exit code, which is what `null` records. */
      expect(supervisor.status("cooperative")).toMatchObject({ state: "exited", exitCode: null });
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
      expect(supervisor.status("stubborn")).toMatchObject({ state: "exited", exitCode: null });
    },
  );

  it("is a no-op for an unknown id and for one that has already exited", async () => {
    await expect(supervisor.stop("never-started")).resolves.toBeUndefined();

    await supervisor.start(child("brief", SELF_EXIT));
    await untilExited("brief");

    await expect(supervisor.stop("brief")).resolves.toBeUndefined();
    expect(supervisor.status("brief")).toMatchObject({ state: "exited", exitCode: 3 });
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

      expect(supervisor.status("retired")).toMatchObject({ state: "exited" });
      expect(calls).toBe(0);
    },
  );
});

/** A supervised process running `source` under the node binary of this test run. */
function child(id: string, source: string): ProcessSpec {
  return { id, command: process.execPath, args: ["-e", source], env: {} };
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
