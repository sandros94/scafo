/*
 * What an assignment pass decides from, and therefore what a coordinator may
 * skip a pass over.
 *
 * Every case below is one an operator can cause. The ones that MUST change the
 * value are the ones that change where an application runs; the ones that must
 * NOT are everything else, and a deploy is the loudest of those — every deploy
 * in the installation would otherwise re-run a pass that could only reach the
 * answer already written.
 */

import { describe, expect, it } from "vitest";
import { assignmentInputs } from "../src/core/placement/assignment-inputs.ts";
import type { ApplicationRecord, PlacementRecord } from "../src/core/types/registry.ts";

const AT = "2026-01-01T00:00:00.000Z";

function application(name: string, extra: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    v: 1,
    name,
    createdAt: AT,
    deployment: { revision: 1, deployedAt: AT },
    domains: [],
    ...extra,
  };
}

function placement(nodes: string[], fence = 1): PlacementRecord {
  return { v: 1, nodes, decidedAt: AT, fence };
}

/** One installation, as a pass reads it. */
function inputs(overrides: {
  applications?: ApplicationRecord[];
  placements?: Array<[string, PlacementRecord]>;
  live?: string[];
}): string {
  return assignmentInputs({
    applications: overrides.applications ?? [application("shop"), application("blog")],
    placements: new Map(overrides.placements ?? [["shop", placement(["node-a"])]]),
    live: overrides.live ?? ["node-a", "node-b"],
  });
}

describe("what a pass would decide the same thing about", () => {
  it("is the same value for the same installation, read twice", () => {
    expect(inputs({})).toBe(inputs({}));
  });

  it("does not depend on the order a listing came back in", () => {
    expect(inputs({ applications: [application("blog"), application("shop")] })).toBe(inputs({}));
    expect(inputs({ live: ["node-b", "node-a"] })).toBe(inputs({}));
  });

  it("is UNMOVED by a deploy, which decides nothing about placement", () => {
    const deployed = [
      application("shop", { deployment: { revision: 7, deployedAt: AT } }),
      application("blog"),
    ];
    expect(inputs({ applications: deployed })).toBe(inputs({}));
  });

  it("is unmoved by a domain claim or a label an admin set", () => {
    const decorated = [
      application("shop", { domains: ["shop.example.test"], labels: { tier: "gold" } }),
      application("blog"),
    ];
    expect(inputs({ applications: decorated })).toBe(inputs({}));
  });
});

describe("what a pass has to look at again", () => {
  it("moves when an application appears or goes", () => {
    expect(inputs({ applications: [application("shop")] })).not.toBe(inputs({}));
    expect(
      inputs({ applications: [application("shop"), application("blog"), application("wiki")] }),
    ).not.toBe(inputs({}));
  });

  it("moves when the replica count or the selector changes", () => {
    expect(
      inputs({ applications: [application("shop", { replicas: 2 }), application("blog")] }),
    ).not.toBe(inputs({}));
    expect(
      inputs({
        applications: [
          application("shop", { nodeSelector: { tier: "fast" } }),
          application("blog"),
        ],
      }),
    ).not.toBe(inputs({}));
  });

  it("moves when an application is blocked or retired", () => {
    expect(
      inputs({ applications: [application("shop", { blocked: true }), application("blog")] }),
    ).not.toBe(inputs({}));
    expect(
      inputs({ applications: [application("shop", { retiredAt: AT }), application("blog")] }),
    ).not.toBe(inputs({}));
  });

  it("moves when a placement is rewritten by anything, this pass included", () => {
    expect(inputs({ placements: [["shop", placement(["node-b"])]] })).not.toBe(inputs({}));
    expect(inputs({ placements: [["shop", placement(["node-a"], 2)]] })).not.toBe(inputs({}));
    expect(inputs({ placements: [] })).not.toBe(inputs({}));
  });

  it("moves when a placement is left behind by an application that is gone", () => {
    /* Exactly what a pass DELETES, and the applications never name it. */
    expect(
      inputs({
        placements: [
          ["shop", placement(["node-a"])],
          ["ghost", placement(["node-a"])],
        ],
      }),
    ).not.toBe(inputs({}));
  });

  it("moves when a node joins the fleet or stops being live", () => {
    expect(inputs({ live: ["node-a"] })).not.toBe(inputs({}));
    expect(inputs({ live: ["node-a", "node-b", "node-c"] })).not.toBe(inputs({}));
  });
});
