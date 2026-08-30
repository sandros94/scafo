/* The pure single-current-build reconcile contract and its rollout overlap. */

import { describe, expect, it } from "vitest";
import { formatProcessId } from "../src/core/placement/ids.ts";
import {
  type DesiredEnvironment,
  planReconcile,
  type PortView,
  type ReconcileAction,
} from "../src/core/placement/reconcile.ts";
import type { BuildRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

const PORT_START = 42_000;
const RUNNING_PORT = 43_000;
const BUILD_ONE = "1111aaaa";
const BUILD_TWO = "2222bbbb";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const FLIPPED_AT = "2026-01-02T00:00:00.000Z";

describe("a current build with nothing running", () => {
  it("rolls it out as one pointer-and-process action", () => {
    const ports = countingPorts();

    expect(
      planReconcile({ desired: [desired("shop", "prod", BUILD_ONE)], actual: [], ports }),
    ).toEqual([
      {
        type: "rollout",
        project: "shop",
        env: "prod",
        build: BUILD_ONE,
        ports: { public: PORT_START, internal: PORT_START + 1 },
      },
    ]);
    expect(ports.calls).toBe(1);
  });

  it("uses the build-keyed transitional process id", () => {
    const action = planReconcile({
      desired: [desired("shop", "prod", BUILD_ONE)],
      actual: [],
      ports: countingPorts(),
    })[0] as Extract<ReconcileAction, { type: "rollout" }>;

    expect(formatProcessId(action)).toBe(`shop--prod--${BUILD_ONE}`);
  });
});

describe("an internal replacement overlap", () => {
  it("gates the new process without stopping the old ready process", () => {
    const old = runtimeProcess("shop", "prod", BUILD_ONE, { ready: true });
    const replacement = runtimeProcess("shop", "prod", BUILD_TWO, { ready: false });

    expect(
      planReconcile({
        desired: [desired("shop", "prod", BUILD_TWO)],
        actual: [old, replacement],
        ports: countingPorts(),
      }),
    ).toEqual([{ type: "await-ready", processId: replacement.processId }]);
  });

  it("retires the old process only after the current one is ready", () => {
    const old = runtimeProcess("shop", "prod", BUILD_ONE, { ready: true });
    const replacement = runtimeProcess("shop", "prod", BUILD_TWO, { ready: true });

    expect(
      planReconcile({
        desired: [desired("shop", "prod", BUILD_TWO)],
        actual: [replacement, old],
        ports: countingPorts(),
      }),
    ).toEqual([
      {
        type: "stop",
        processId: old.processId,
        reason: `superseded by build "${BUILD_TWO}"`,
      },
    ]);
  });

  it("keeps the old process while a missing current process is rolled out", () => {
    const old = runtimeProcess("shop", "prod", BUILD_ONE, { ready: true });

    const plan = planReconcile({
      desired: [desired("shop", "prod", BUILD_TWO)],
      actual: [old],
      ports: countingPorts(),
    });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ type: "rollout", build: BUILD_TWO });
  });

  it("gates duplicate unready attempts in deterministic id order", () => {
    const first = runtimeProcess("shop", "prod", BUILD_TWO, { ready: false });
    const retry = runtimeProcess("shop", "prod", BUILD_TWO, { ready: false, retry: 1 });

    expect(
      planReconcile({
        desired: [desired("shop", "prod", BUILD_TWO)],
        actual: [retry, first],
        ports: countingPorts(),
      }),
    ).toEqual([
      { type: "await-ready", processId: first.processId },
      { type: "await-ready", processId: retry.processId },
    ]);
  });
});

describe("placement removal", () => {
  it("stops every process for an environment no longer assigned to this node", () => {
    const running = runtimeProcess("shop", "prod", BUILD_ONE, { ready: true });

    expect(planReconcile({ desired: [], actual: [running], ports: countingPorts() })).toEqual([
      {
        type: "stop",
        processId: running.processId,
        reason: "environment is no longer served by this node",
      },
    ]);
  });

  it("plans moves before stops across environments", () => {
    const removed = runtimeProcess("archive", "old", BUILD_ONE, { ready: true });

    const plan = planReconcile({
      desired: [desired("shop", "prod", BUILD_TWO)],
      actual: [removed],
      ports: countingPorts(),
    });

    expect(plan.map((action) => action.type)).toEqual(["rollout", "stop"]);
  });

  it("orders environments and leftover stops independently of input order", () => {
    const z = runtimeProcess("zulu", "prod", BUILD_ONE, { ready: true });
    const a = runtimeProcess("alpha", "prod", BUILD_ONE, { ready: true });

    const plan = planReconcile({
      desired: [desired("zulu", "new", BUILD_TWO), desired("alpha", "new", BUILD_TWO)],
      actual: [z, a],
      ports: countingPorts(),
    });

    expect(plan.map(subject)).toEqual(["alpha/new", "zulu/new", a.processId, z.processId]);
  });
});

describe("a settled environment", () => {
  it("does nothing when its one current process is ready", () => {
    const running = runtimeProcess("shop", "prod", BUILD_ONE, { ready: true });

    expect(
      planReconcile({
        desired: [desired("shop", "prod", BUILD_ONE)],
        actual: [running],
        ports: countingPorts(),
      }),
    ).toEqual([]);
  });

  it("carries the varset id without changing planning identity", () => {
    const wanted = desired("shop", "prod", BUILD_ONE, "vars-1234");
    expect(wanted.varsetId).toBe("vars-1234");
    expect(
      planReconcile({ desired: [wanted], actual: [], ports: countingPorts() })[0],
    ).toMatchObject({ project: "shop", env: "prod", build: BUILD_ONE });
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

function desired(
  project: string,
  env: string,
  build: string,
  varsetId?: string,
): DesiredEnvironment {
  return {
    project,
    env: {
      v: 1,
      name: env,
      prefix: `fleets/${project}/${env}`,
      alias: { build, flippedAt: FLIPPED_AT },
      domains: [],
      placement: "auto",
      ephemeral: false,
      createdAt: CREATED_AT,
    },
    builds: [{ build: buildRecord(build), role: "current" }],
    ...(varsetId === undefined ? {} : { varsetId }),
  };
}

function buildRecord(id: string): BuildRecord {
  return {
    v: 1,
    id,
    celldVersionId: `version-${id}`,
    runtimeConfigurable: true,
    createdAt: CREATED_AT,
  };
}

function runtimeProcess(
  project: string,
  env: string,
  build: string,
  opts: { ready: boolean; retry?: number },
): RuntimeProcess {
  return {
    processId: formatProcessId({ project, env, build, retry: opts.retry }),
    project,
    env,
    build,
    port: RUNNING_PORT,
    internalPort: RUNNING_PORT + 1,
    ready: opts.ready,
  };
}

function subject(action: ReconcileAction): string {
  return action.type === "rollout" ? `${action.project}/${action.env}` : action.processId;
}
