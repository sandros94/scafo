/* Runtime reconcile contract. */

import { describe, expect, it } from "vitest";
import { planReconcile, type ReconcileAction } from "../src/core/placement/reconcile.ts";
import type { ApplicationRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";

const RUNNING_PORT = 43_000;
const CREATED_AT = "2026-01-01T00:00:00.000Z";

describe("an application with nothing running", () => {
  it("starts one application-owned process, naming it and no ports", () => {
    /* The ports belong to the application and are read where they are kept,
       which is beside its local state and not in a plan. */
    expect(planReconcile({ desired: [desired("shop", 1)], actual: [] })).toEqual([
      { type: "start", application: "shop" },
    ]);
  });

  it("starts nothing for an application that has never been deployed", () => {
    const never: ApplicationRecord = { ...desired("shop", 1), deployment: null };

    expect(planReconcile({ desired: [never], actual: [] })).toEqual([]);
  });
});

describe("runtime-owned deployment lifecycle", () => {
  it("does nothing when only the deployment revision changes", () => {
    expect(
      planReconcile({
        desired: [desired("shop", 2)],
        actual: [runtimeProcess("shop")],
      }),
    ).toEqual([]);
  });

  it("retries a pending teardown before anything else", () => {
    const running = { ...runtimeProcess("shop"), teardownPending: true as const };
    expect(
      planReconcile({
        desired: [desired("shop", 2)],
        actual: [running],
      }),
    ).toEqual([
      {
        type: "stop",
        application: "shop",
        reason: "runtime teardown is pending",
      },
    ]);
  });
});

describe("placement removal", () => {
  it("stops an application no longer assigned to this node", () => {
    expect(
      planReconcile({
        desired: [],
        actual: [runtimeProcess("shop")],
      }),
    ).toEqual([
      {
        type: "stop",
        application: "shop",
        reason: "application is no longer served by this node",
      },
    ]);
  });

  it("plans starts before unrelated stops", () => {
    const plan = planReconcile({
      desired: [desired("shop", 1)],
      actual: [runtimeProcess("archive")],
    });
    expect(plan.map((action) => action.type)).toEqual(["start", "stop"]);
  });

  it("orders applications and leftover stops independently of input order", () => {
    const plan = planReconcile({
      desired: [desired("zulu-new", 1), desired("alpha-new", 1)],
      actual: [runtimeProcess("zulu"), runtimeProcess("alpha")],
    });
    expect(plan.map(subject)).toEqual(["alpha-new", "zulu-new", "alpha", "zulu"]);
  });

  it("leaves an application whose name merely shares a prefix running", () => {
    const plan = planReconcile({
      desired: [desired("shop", 1), desired("shop-preview", 1), desired("shop2", 1)],
      actual: [runtimeProcess("shop"), runtimeProcess("shop-preview"), runtimeProcess("shop2")],
    });

    expect(plan).toEqual([]);
  });
});

function desired(name: string, revision: number): ApplicationRecord {
  return {
    v: 1,
    name,
    deployment: { revision, deployedAt: CREATED_AT },
    domains: [],
    createdAt: CREATED_AT,
  };
}

function runtimeProcess(application: string): RuntimeProcess {
  return { application, port: RUNNING_PORT, internalPort: RUNNING_PORT + 1 };
}

function subject(action: ReconcileAction): string {
  return action.application;
}
