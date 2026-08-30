/* The pure environment-owned runtime reconcile contract. */

import { describe, expect, it } from "vitest";
import { formatProcessId, parseProcessId } from "../src/core/placement/ids.ts";
import {
  type DesiredEnvironment,
  planReconcile,
  type PortView,
  type ReconcileAction,
} from "../src/core/placement/reconcile.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

const PORT_START = 42_000;
const RUNNING_PORT = 43_000;
const CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("an environment with nothing running", () => {
  it("starts one environment-owned process", () => {
    const ports = countingPorts();
    expect(planReconcile({ desired: [desired("shop", "prod", 1)], actual: [], ports })).toEqual([
      {
        type: "start",
        project: "shop",
        env: "prod",
        revision: 1,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
    ]);
    expect(ports.calls).toBe(1);
    expect(formatProcessId({ project: "shop", env: "prod" })).toBe("shop--prod");
    expect(parseProcessId("shop--prod")).toEqual({ project: "shop", env: "prod" });
    expect(parseProcessId("shop--prod--aaaaaaaa")).toBeNull();
  });
});

describe("a deployment revision", () => {
  it("adopts a newer revision in place", () => {
    const running = runtimeProcess("shop", "prod", 1, true);
    expect(
      planReconcile({
        desired: [desired("shop", "prod", 2)],
        actual: [running],
        ports: countingPorts(),
      }),
    ).toEqual([{ type: "adopt", processId: running.processId, revision: 2 }]);
  });

  it("gates an unready process already at the current revision", () => {
    const running = runtimeProcess("shop", "prod", 2, false);
    expect(
      planReconcile({
        desired: [desired("shop", "prod", 2)],
        actual: [running],
        ports: countingPorts(),
      }),
    ).toEqual([{ type: "await-ready", processId: running.processId }]);
  });

  it("retries a pending teardown before adopting a newer revision", () => {
    const running = { ...runtimeProcess("shop", "prod", 1, false), teardownPending: true as const };
    expect(
      planReconcile({
        desired: [desired("shop", "prod", 2)],
        actual: [running],
        ports: countingPorts(),
      }),
    ).toEqual([
      {
        type: "stop",
        processId: running.processId,
        reason: "runtime teardown is pending",
      },
    ]);
  });

  it("adopts a newer revision even when the preceding generation is unready", () => {
    const running = runtimeProcess("shop", "prod", 1, false);
    expect(
      planReconcile({
        desired: [desired("shop", "prod", 2)],
        actual: [running],
        ports: countingPorts(),
      }),
    ).toEqual([{ type: "adopt", processId: running.processId, revision: 2 }]);
  });

  it("does nothing when the environment process is current and ready", () => {
    expect(
      planReconcile({
        desired: [desired("shop", "prod", 2)],
        actual: [runtimeProcess("shop", "prod", 2, true)],
        ports: countingPorts(),
      }),
    ).toEqual([]);
  });
});

describe("placement removal", () => {
  it("stops an environment no longer assigned to this node", () => {
    const running = runtimeProcess("shop", "prod", 1, true);
    expect(planReconcile({ desired: [], actual: [running], ports: countingPorts() })).toEqual([
      {
        type: "stop",
        processId: running.processId,
        reason: "environment is no longer served by this node",
      },
    ]);
  });

  it("plans starts before stops across environments", () => {
    const removed = runtimeProcess("archive", "old", 1, true);
    const plan = planReconcile({
      desired: [desired("shop", "prod", 1)],
      actual: [removed],
      ports: countingPorts(),
    });
    expect(plan.map((action) => action.type)).toEqual(["start", "stop"]);
  });

  it("orders environments and leftover stops independently of input order", () => {
    const z = runtimeProcess("zulu", "prod", 1, true);
    const a = runtimeProcess("alpha", "prod", 1, true);
    const plan = planReconcile({
      desired: [desired("zulu", "new", 1), desired("alpha", "new", 1)],
      actual: [z, a],
      ports: countingPorts(),
    });
    expect(plan.map(subject)).toEqual(["alpha/new", "zulu/new", a.processId, z.processId]);
  });
});

interface CountingPorts extends PortView {
  calls: number;
}

function countingPorts(): CountingPorts {
  let next = PORT_START;
  const ports: CountingPorts = {
    calls: 0,
    nextPorts() {
      ports.calls++;
      const pair = { public: next, internal: next + 1 };
      next += 2;
      return pair;
    },
  };
  return ports;
}

function desired(project: string, env: string, revision: number): DesiredEnvironment {
  return {
    project,
    env: {
      v: 1,
      name: env,
      prefix: `fleets/${project}/${env}`,
      deployment: { revision, deployedAt: CREATED_AT },
      domains: [],
      placement: "auto",
      ephemeral: false,
      createdAt: CREATED_AT,
    },
  };
}

function runtimeProcess(
  project: string,
  env: string,
  revision: number,
  ready: boolean,
): RuntimeProcess {
  return {
    processId: formatProcessId({ project, env }),
    project,
    env,
    attemptedRevision: revision,
    appliedRevision: revision,
    port: RUNNING_PORT,
    internalPort: RUNNING_PORT + 1,
    ready,
  };
}

function subject(action: ReconcileAction): string {
  return action.type === "start" ? `${action.project}/${action.env}` : action.processId;
}
