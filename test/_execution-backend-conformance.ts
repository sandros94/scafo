import { describe, expect, it } from "vitest";
import type {
  BuilderExecutionIntent,
  ExecutionBackend,
  ExecutionHandle,
  ExecutionLaunch,
  RuntimeExecutionIntent,
  TaskResult,
} from "../src/core/types/execution.ts";

/** A test-only egress action a fixture drives through its sandbox enforcement path. */
export interface ExecutionEgressAttempt {
  readonly role: "builder" | "runtime";
  readonly path: "direct" | "mediated";
  readonly destination: string;
}

/** Controlled endpoints a fixture owns for egress conformance. */
export interface ExecutionEgressDestinations {
  readonly publicWeb: Readonly<Record<"http" | "https" | "ws" | "wss", string>>;
  readonly protected: Readonly<Record<ProtectedDestinationClass, string>>;
}

/** Every address class a mediated runtime must treat as non-public. */
export type ProtectedDestinationClass =
  | "localhostName"
  | "ipv4Unspecified"
  | "ipv4Loopback"
  | "ipv4LinkLocal"
  | "ipv4Private"
  | "ipv4Cgnat"
  | "ipv4ReservedOrMetadata"
  | "ipv6Unspecified"
  | "ipv6Loopback"
  | "ipv6LinkLocal"
  | "ipv6Ula"
  | "hostnameRebinding";

/** A known overflow sequence and the retained tail capacity it must leave behind. */
export interface ExecutionLogOverflow {
  readonly retainedTailCapacity: number;
  readonly emittedLines: readonly string[];
}

/** Values a backend supplies to the reusable execution conformance suite. */
export interface ExecutionBackendFixture {
  backend: ExecutionBackend;
  builderIntent(generation: string): BuilderExecutionIntent;
  runtimeIntent(generation: string): RuntimeExecutionIntent;
  limitedRuntimeIntent(): RuntimeExecutionIntent;
  unsupportedLimitIntent(): RuntimeExecutionIntent;
  readonly scope: { readonly installationId: string; readonly nodeId: string };
  environment(handle: ExecutionHandle): Readonly<Record<string, string>> | null;
  readonly egressDestinations: ExecutionEgressDestinations;
  /**
   * Attempts egress through the launched sandbox. Real fixtures must drive their actual egress
   * enforcement path against these controlled destinations; a fake may simulate the cases.
   */
  attemptEgress(attempt: ExecutionEgressAttempt): Promise<void>;
  readonly logOverflow: ExecutionLogOverflow;
  /**
   * Drives sandbox output past {@link logOverflow.retainedTailCapacity}, waits for collection,
   * and returns the still-running sandbox. Real fixtures must use the actual retained-log path.
   */
  overflowLogs(): Promise<ExecutionHandle>;
  gatedBuilderTask(signal: AbortSignal): {
    readonly entered: Promise<void>;
    readonly result: Promise<TaskResult>;
  };
  launch: ExecutionLaunch;
}

/** Runs the portable lifecycle checks every secure backend must satisfy. */
export function executionBackendConformance(
  name: string,
  create: () => ExecutionBackendFixture,
): void {
  // oxlint-disable-next-line vitest/valid-title -- The caller names the backend under test.
  describe(name, () => {
    it("keeps builder egress denied separately from mediated runtime egress", async () => {
      const fixture = create();
      expect((await fixture.backend.probe()).features).toMatchObject({
        builderEgressDeny: true,
        egressMediation: true,
      });
      expect(fixture.builderIntent("builder-egress").egress).toEqual({ mode: "none" });
      expect(fixture.runtimeIntent("runtime-egress").egress).toEqual({ mode: "mediated-web" });
      await assertEgressEnforcement(fixture);
    });

    // oxlint-disable-next-line vitest/expect-expect -- The helper verifies overflow, retention, and teardown.
    it("retains only a bounded newest log tail after overflow", async () => {
      await assertBoundedLogTail(create());
    });

    it("runs a task in a sandbox that closes as one unit", async () => {
      const fixture = create();
      const result = await fixture.backend.runTask(
        fixture.builderIntent("task-generation"),
        fixture.launch,
        { signal: new AbortController().signal },
      );

      expect(result.status.state).toBe("closed");
      expect(result.status.closedReason).toBe("completed");
      expect(await fixture.backend.inspect(result.status.handle)).toEqual(result.status);
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    it("rejects a pre-aborted task only after whole-sandbox teardown", async () => {
      const fixture = create();
      const controller = new AbortController();
      const reason = new Error("task cancelled");
      controller.abort(reason);

      await expect(
        fixture.backend.runTask(fixture.builderIntent("cancelled-task"), fixture.launch, {
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    it("rejects a task aborted during launch only after whole-sandbox teardown", async () => {
      const fixture = create();
      const controller = new AbortController();
      const reason = new Error("task launch cancelled");

      await expect(
        fixture.backend.runTask(
          fixture.builderIntent("cancelled-task-launch"),
          (bindings) => {
            controller.abort(reason);
            return fixture.launch(bindings);
          },
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    // oxlint-disable-next-line vitest/expect-expect -- The helper asserts exact rejection and teardown.
    it("rejects a task aborted after execution enters only after whole-sandbox teardown", async () => {
      await assertGatedTaskCancellation(create());
    });

    it("rejects a pre-aborted service only after whole-sandbox teardown", async () => {
      const fixture = create();
      const controller = new AbortController();
      const reason = new Error("service pre-aborted");
      controller.abort(reason);

      await expect(
        fixture.backend.startService(fixture.runtimeIntent("pre-aborted-service"), fixture.launch, {
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    it("rejects a service aborted during launch only after whole-sandbox teardown", async () => {
      const fixture = create();
      const controller = new AbortController();
      const reason = new Error("service cancelled");

      await expect(
        fixture.backend.startService(
          fixture.runtimeIntent("cancelled-service"),
          (bindings) => {
            controller.abort(reason);
            return fixture.launch(bindings);
          },
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    it("tears down a service aborted after its handle was returned", async () => {
      const fixture = create();
      const controller = new AbortController();
      const handle = await fixture.backend.startService(
        fixture.runtimeIntent("later-abort"),
        fixture.launch,
        { signal: controller.signal },
      );
      controller.abort(new Error("later cancellation"));
      await Promise.resolve();

      expect(await fixture.backend.inspect(handle)).toMatchObject({
        state: "closed",
        closedReason: "cancelled",
      });
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    it("fences stale handles, publishes named endpoints, and bounds logs", async () => {
      const fixture = create();
      const old = await fixture.backend.startService(
        fixture.runtimeIntent("old-generation"),
        fixture.launch,
        { signal: new AbortController().signal },
      );
      const current = await fixture.backend.startService(
        fixture.runtimeIntent("new-generation"),
        fixture.launch,
        { signal: new AbortController().signal },
      );

      expect(await fixture.backend.inspect(old)).toBeNull();
      await fixture.backend.stop(old, { mode: "abort", graceMs: 0 });
      const status = await fixture.backend.inspect(current);
      expect(status).toMatchObject({
        state: "running",
        identity: { generation: "new-generation" },
      });
      expect(status?.endpoints).toEqual([{ name: "http", address: "http://dial.test/service" }]);
      expect(status?.logTail).toEqual(["ready"]);
      expect(await fixture.backend.list(fixture.scope)).toEqual([current]);

      await fixture.backend.stop(current, { mode: "drain", graceMs: 1 });
      expect(await fixture.backend.inspect(current)).toMatchObject({
        state: "closed",
        closedReason: "stopped",
      });
      expect(await fixture.backend.list(fixture.scope)).toEqual([]);
    });

    it("injects reserved environment values after adapter values", async () => {
      const fixture = create();
      const handle = await fixture.backend.startService(
        fixture.runtimeIntent("reserved-env"),
        (bindings) => {
          const spec = fixture.launch(bindings);
          return { ...spec, env: { ...spec.env, SCAFO_GENERATION: "application-value" } };
        },
        { signal: new AbortController().signal },
      );

      expect(fixture.environment(handle)?.SCAFO_GENERATION).toBe("reserved-env");
      await fixture.backend.stop(handle, { mode: "abort", graceMs: 0 });
    });

    it("accepts a positive partial limit and refuses an unsupported selected limit", async () => {
      const fixture = create();
      const limited = await fixture.backend.startService(
        fixture.limitedRuntimeIntent(),
        fixture.launch,
        {
          signal: new AbortController().signal,
        },
      );
      expect(await fixture.backend.inspect(limited)).toMatchObject({ state: "running" });
      await fixture.backend.stop(limited, { mode: "abort", graceMs: 0 });

      await expect(
        fixture.backend.startService(fixture.unsupportedLimitIntent(), fixture.launch, {
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "capability-missing" });
    });
  });
}

/** Runs only the teardown probe, used as a sentinel against plausible broken backends. */
export async function assertWholeSandboxTeardown(fixture: ExecutionBackendFixture): Promise<void> {
  const handle = await fixture.backend.startService(
    fixture.runtimeIntent("teardown-generation"),
    fixture.launch,
    { signal: new AbortController().signal },
  );
  await fixture.backend.stop(handle, { mode: "abort", graceMs: 0 });
  expect(await fixture.backend.inspect(handle)).toMatchObject({ state: "closed" });
  expect(await fixture.backend.list(fixture.scope)).toEqual([]);
}

/** Proves egress behavior, not merely an advertised capability bit. */
export async function assertEgressEnforcement(fixture: ExecutionBackendFixture): Promise<void> {
  const publicDestinations = Object.values(fixture.egressDestinations.publicWeb);
  const protectedDestinations = Object.values(fixture.egressDestinations.protected);
  for (const path of ["direct", "mediated"] as const) {
    for (const destination of [...publicDestinations, ...protectedDestinations]) {
      await expect(
        fixture.attemptEgress({ role: "builder", path, destination }),
      ).rejects.toMatchObject({ code: "capability-missing" });
    }
  }

  for (const destination of publicDestinations) {
    await expect(
      fixture.attemptEgress({ role: "runtime", path: "direct", destination }),
    ).rejects.toMatchObject({ code: "capability-missing" });
    await expect(
      fixture.attemptEgress({ role: "runtime", path: "mediated", destination }),
    ).resolves.toBeUndefined();
  }

  for (const destination of protectedDestinations) {
    await expect(
      fixture.attemptEgress({ role: "runtime", path: "mediated", destination }),
    ).rejects.toMatchObject({ code: "capability-missing" });
  }
}

/** Proves retained logs are capped and evict their oldest lines before teardown. */
export async function assertBoundedLogTail(fixture: ExecutionBackendFixture): Promise<void> {
  const { emittedLines, retainedTailCapacity } = fixture.logOverflow;
  expect(emittedLines.length).toBeGreaterThan(retainedTailCapacity);
  const handle = await fixture.overflowLogs();
  const status = await fixture.backend.inspect(handle);
  expect(status).toMatchObject({ state: "running" });
  expect(status?.logTail).toEqual(emittedLines.slice(-retainedTailCapacity));
  expect(status?.logTail).toHaveLength(retainedTailCapacity);
  expect(await fixture.backend.list(fixture.scope)).toEqual([handle]);

  await fixture.backend.stop(handle, { mode: "abort", graceMs: 0 });
  expect(await fixture.backend.list(fixture.scope)).toEqual([]);
}

/** Proves a started task rejects its abort reason only after sandbox teardown. */
export async function assertGatedTaskCancellation(fixture: ExecutionBackendFixture): Promise<void> {
  const controller = new AbortController();
  const reason = new Error("gated task cancellation");
  const task = fixture.gatedBuilderTask(controller.signal);
  await task.entered;
  controller.abort(reason);

  await expect(task.result).rejects.toBe(reason);
  expect(await fixture.backend.list(fixture.scope)).toEqual([]);
}
