/*
 * The execution boundary is deliberately tested against a fake backend before
 * one can be wired into a node. The same conformance suite can be handed to a
 * real backend without teaching it about daemon internals.
 */

import { describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import {
  assertExecutionBackendCapabilities,
  resolveWorkloadLimits,
  type ExecutionCapabilities,
} from "../src/core/types/execution.ts";
import {
  assertBoundedLogTail,
  assertEgressEnforcement,
  assertGatedTaskCancellation,
  assertWholeSandboxTeardown,
  executionBackendConformance,
} from "./_execution-backend-conformance.ts";
import { fakeExecutionBackendFixture } from "./_fake-execution-backend.ts";

describe("execution backend contract", () => {
  it("refuses a backend that cannot enforce every secure sandbox feature", () => {
    const error = errorOf(() =>
      assertExecutionBackendCapabilities({
        ...capabilities(),
        features: { ...capabilities().features, groupTeardown: false },
      }),
    );
    expect(error.code).toBe("capability-missing");
    expect(error.detail).toContain("whole-sandbox group teardown");

    const builderEgress = errorOf(() =>
      assertExecutionBackendCapabilities({
        ...capabilities(),
        features: { ...capabilities().features, builderEgressDeny: false },
      }),
    );
    expect(builderEgress.detail).toContain("builder egress denial");
  });

  it("keeps an absent workload policy unbounded", () => {
    expect(resolveWorkloadLimits(undefined)).toBeUndefined();
  });

  it("normalizes an empty policy to no backend quota", () => {
    expect(resolveWorkloadLimits({})).toBeUndefined();
  });

  it("preserves a selected positive partial limit without filling omitted fields", () => {
    expect(resolveWorkloadLimits({ memoryBytes: 512 }, capabilities())).toEqual({
      memoryBytes: 512,
    });
  });

  it("refuses zero, null, sentinels, and non-object workload limits", () => {
    for (const limits of [{ pids: 0 }, { pids: null }, { pids: "unlimited" }] as unknown[]) {
      const error = errorOf(() => resolveWorkloadLimits(limits as { pids?: number }));
      expect(error.code, JSON.stringify(limits)).toBe("invalid-input");
      expect(error.detail, JSON.stringify(limits)).toContain("pids");
    }

    for (const limits of [null, "unlimited", [], { networkBytes: 1 }] as unknown[]) {
      expect(
        errorOf(() => resolveWorkloadLimits(limits)),
        JSON.stringify(limits),
      ).toMatchObject({
        code: "invalid-input",
      });
    }
  });

  it("refuses only a selected limit the backend cannot enforce", () => {
    const noOpenFiles: ExecutionCapabilities = {
      ...capabilities(),
      workloadLimits: capabilities().workloadLimits.filter((limit) => limit !== "openFiles"),
    };
    expect(resolveWorkloadLimits({ memoryBytes: 512 }, noOpenFiles)).toEqual({ memoryBytes: 512 });
    expect(errorOf(() => resolveWorkloadLimits({ openFiles: 4 }, noOpenFiles))).toMatchObject({
      code: "capability-missing",
      detail: expect.stringContaining("openFiles"),
    });
  });
});

executionBackendConformance("the deterministic fake backend", () => fakeExecutionBackendFixture());

describe("execution backend conformance sentinels", () => {
  it("catches a backend that leaves a sandbox running after stop", async () => {
    await expect(
      assertWholeSandboxTeardown(fakeExecutionBackendFixture({ leaveRunningOnStop: true })),
    ).rejects.toThrow("expected");
  });

  it("catches a backend that advertises builder egress denial but allows it", async () => {
    await expect(
      assertEgressEnforcement(fakeExecutionBackendFixture({ allowBuilderEgress: true })),
    ).rejects.toThrow("promise resolved");
  });

  it("catches a backend that advertises runtime direct egress denial but allows it", async () => {
    await expect(
      assertEgressEnforcement(fakeExecutionBackendFixture({ allowRuntimeDirectEgress: true })),
    ).rejects.toThrow("promise resolved");
  });

  it("catches a backend that advertises protected mediation denial but allows it", async () => {
    await expect(
      assertEgressEnforcement(fakeExecutionBackendFixture({ allowProtectedMediatedEgress: true })),
    ).rejects.toThrow("promise resolved");
  });

  it("catches a backend that retains an unbounded log tail", async () => {
    await expect(
      assertBoundedLogTail(fakeExecutionBackendFixture({ leaveLogTailUnbounded: true })),
    ).rejects.toThrow("expected");
  });

  it("catches a task abort that resolves while leaving its sandbox running", async () => {
    await expect(
      assertGatedTaskCancellation(fakeExecutionBackendFixture({ leaveRunningOnTaskAbort: true })),
    ).rejects.toThrow("promise resolved");
  });
});

function capabilities(): ExecutionCapabilities {
  return {
    isolationModes: ["sandbox"],
    workloadLimits: [
      "cpuMillicores",
      "memoryBytes",
      "pids",
      "openFiles",
      "scratchBytes",
      "scratchInodes",
    ],
    features: {
      cancellation: true,
      groupTeardown: true,
      generationFence: true,
      namedListeners: true,
      boundedLogs: true,
      readOnlyInputs: true,
      privateScratch: true,
      filesystemIsolation: true,
      networkIsolation: true,
      protectedNetworkDeny: true,
      builderEgressDeny: true,
      egressMediation: true,
      scopedCapabilities: true,
      lifecycleLease: true,
    },
  };
}

function errorOf(fn: () => void): ScafoError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScafoError) return error;
    throw error;
  }
  throw new Error("Expected ScafoError");
}
