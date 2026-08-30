import { describe, expect, it } from "vitest";
import { accountCredits } from "../src/core/capacity/index.ts";
import { planCreditPlacement } from "../src/core/placement/index.ts";
import { ScafoError } from "../src/core/error.ts";

describe("accountCredits", () => {
  it("conserves integer MiB credits and exposes a deficit without clamping it away", () => {
    expect(
      accountCredits({
        allocatableMb: 100,
        surgeMb: 20,
        runtime: [{ target: "shop/prod/a", mb: 70 }],
        transition: [{ target: "shop/prod/b", mb: 20 }],
        deploy: [{ target: "shop/prod/c", mb: 30 }],
      }),
    ).toMatchObject({
      runtimeMb: 70,
      transitionMb: 20,
      deployMb: 30,
      usedMb: 120,
      availableMb: 0,
      deficitMb: 20,
      protectedMb: 0,
      deployAvailableMb: 0,
      fits: false,
    });
  });

  it("keeps a runtime-sized surge unavailable to deploy work", () => {
    const account = accountCredits({
      allocatableMb: 100,
      surgeMb: 20,
      runtime: [{ target: "shop/prod/a", mb: 50 }],
    });

    expect(account.deployAvailableMb).toBe(30);
    expect(account.runtimeAvailableMb).toBe(50);
    expect(account.steadyAvailableMb).toBe(30);
  });

  it("lets transitions spend surge but never credits beyond the pool", () => {
    const account = accountCredits({
      allocatableMb: 100,
      surgeMb: 20,
      runtime: [{ target: "shop/prod/a", mb: 70 }],
      transition: [{ target: "shop/prod/b", mb: 20 }],
    });

    expect(account).toMatchObject({
      usedMb: 90,
      availableMb: 10,
      protectedMb: 0,
      fits: true,
    });
  });

  it("keeps the unspent transition surge unavailable to deploy work", () => {
    const account = accountCredits({
      allocatableMb: 100,
      surgeMb: 20,
      runtime: [{ target: "shop/prod/a", mb: 50 }],
      transition: [{ target: "shop/prod/b", mb: 10 }],
    });

    expect(account).toMatchObject({
      availableMb: 40,
      protectedMb: 10,
      deployAvailableMb: 30,
      runtimeAvailableMb: 40,
    });
  });

  it("refuses malformed, duplicate and overflowing reservations", () => {
    const invalid = [
      { allocatableMb: 100, surgeMb: 20, runtime: [{ target: "a", mb: 1.5 }] },
      { allocatableMb: 100, surgeMb: 20, runtime: [{ target: "a", mb: 0 }] },
      { allocatableMb: 100, surgeMb: 20, runtime: [{ target: "a", mb: -1 }] },
      {
        allocatableMb: Number.MAX_SAFE_INTEGER,
        surgeMb: 1,
        runtime: [
          { target: "a", mb: Number.MAX_SAFE_INTEGER },
          { target: "b", mb: 1 },
        ],
      },
      {
        allocatableMb: 100,
        surgeMb: 20,
        runtime: [{ target: "a", mb: 1 }],
        deploy: [{ target: "a", mb: 1 }],
      },
      { allocatableMb: 100, surgeMb: 101 },
    ];

    for (const input of invalid) {
      expect(() => accountCredits(input)).toThrow(ScafoError);
      expect(() => accountCredits(input)).toThrow(/Invalid|Duplicate|overflow/);
    }
  });
});

describe("planCreditPlacement", () => {
  it("charges each candidate node's runtime denomination for current, transition and steady work", async () => {
    const planned = await planCreditPlacement({
      nodes: [
        { id: "a", profile: { allocatableMb: 200, runtimeMb: 30 } },
        { id: "b", profile: { allocatableMb: 250, runtimeMb: 70 }, labels: { tier: "fast" } },
      ],
      workloads: [
        { project: "shop", env: "prod", replicas: 1, processes: 1, current: ["a"] },
        { project: "blog", env: "prod", replicas: 1, processes: 1, current: ["b"] },
        {
          project: "docs",
          env: "prod",
          replicas: 1,
          processes: 1,
          selector: { tier: "fast" },
          current: ["a"],
        },
      ],
    });

    expect(planned.accounts).toMatchObject([
      { id: "a", transient: { runtimeMb: 60 }, steady: { runtimeMb: 30 } },
      { id: "b", transient: { runtimeMb: 70, transitionMb: 70 }, steady: { runtimeMb: 140 } },
    ]);
  });

  it("counts every live selector match while only valid profiles receive capacity work", async () => {
    const planned = await planCreditPlacement({
      nodes: [
        { id: "valid", profile: { allocatableMb: 100, runtimeMb: 20 } },
        { id: "legacy", profile: null },
      ],
      workloads: [
        { project: "shop", env: "all", replicas: "all", processes: 1, current: ["valid"] },
        { project: "shop", env: "kept", replicas: 1, processes: 1, current: ["legacy"] },
      ],
    });

    expect(planned.placements).toMatchObject([
      {
        target: "shop/all",
        nodes: ["valid"],
        pending: { requiredReplicas: "all", eligibleNodes: 2, capacityNodes: 1 },
      },
      {
        target: "shop/kept",
        nodes: ["legacy"],
        pending: {
          reason: "profile-unavailable",
          requiredReplicas: 1,
          eligibleNodes: 2,
          capacityNodes: 1,
        },
      },
    ]);
    expect(planned.accounts.map((account) => account.id)).toEqual(["valid"]);

    await expect(
      planCreditPlacement({
        nodes: [{ id: "legacy", profile: null }],
        workloads: [{ project: "shop", env: "fresh", replicas: 1, processes: 1, current: [] }],
      }),
    ).resolves.toMatchObject({
      placements: [
        {
          target: "shop/fresh",
          nodes: [],
          pending: { requiredReplicas: 1, eligibleNodes: 1, capacityNodes: 0 },
        },
      ],
    });
  });

  it("fails over a current id that is no longer live", async () => {
    const planned = await planCreditPlacement({
      nodes: [{ id: "valid", profile: { allocatableMb: 100, runtimeMb: 20 } }],
      workloads: [{ project: "shop", env: "prod", replicas: 1, processes: 1, current: ["dead"] }],
    });

    expect(planned.placements).toEqual([{ target: "shop/prod", nodes: ["valid"] }]);
  });

  it("charges every desired process on a selected node", async () => {
    const planned = await planCreditPlacement({
      nodes: [{ id: "x", profile: { allocatableMb: 100, runtimeMb: 30 } }],
      workloads: [
        { project: "app", env: "a", replicas: 1, processes: 2, current: ["x"] },
        { project: "app", env: "b", replicas: 1, processes: 1, current: [] },
      ],
    });

    expect(planned.placements).toMatchObject([
      { target: "app/a", nodes: ["x"] },
      { target: "app/b", nodes: [], pending: { reason: "insufficient-capacity" } },
    ]);
    expect(planned.accounts).toMatchObject([{ id: "x", steady: { runtimeMb: 60 } }]);
  });

  it("filters capacity before rendezvous and keeps numeric placement exact", async () => {
    const planned = await planCreditPlacement({
      nodes: [
        node("a", 160, { tier: "pinned" }, 70),
        node("b", 100, undefined, 40),
        node("c", 100, undefined, 40),
      ],
      workloads: [
        workload("shop/prod", { current: ["a"], selector: { tier: "pinned" } }),
        workload("blog/prod", { replicas: 2 }),
      ],
    });

    expect(planned.placements.find((placement) => placement.target === "shop/prod")?.nodes).toEqual(
      ["a"],
    );
    expect(planned.placements.find((placement) => placement.target === "blog/prod")?.nodes).toEqual(
      ["b", "c"],
    );
  });

  it("makes numeric and all proposals atomic, retaining prior node bytes on failure", async () => {
    const current = ["b", "a"];
    const planned = await planCreditPlacement({
      nodes: [node("a", 100, undefined, 40), node("b", 100, undefined, 40)],
      workloads: [
        workload("shop/prod", { replicas: 2, current }),
        workload("blog/prod", { replicas: "all" }),
      ],
    });

    expect(planned.placements.find((placement) => placement.target === "shop/prod")?.nodes).toEqual(
      current,
    );
    expect(planned.placements.find((placement) => placement.target === "blog/prod")).toMatchObject({
      nodes: [],
      pending: { reason: "insufficient-capacity" },
    });
  });

  it("preserves an over-capacity legacy placement while another node admits work", async () => {
    const current = ["a"];
    const planned = await planCreditPlacement({
      nodes: [node("a", 100, { tier: "pinned" }, 60), node("b", 160, undefined, 20)],
      workloads: [
        workload("shop/prod", { current, selector: { tier: "pinned" } }),
        workload("blog/prod"),
      ],
    });

    expect(planned.overcommitted).toBe(true);
    expect(planned.placements.find((placement) => placement.target === "shop/prod")).toMatchObject({
      nodes: current,
      pending: { reason: "over-capacity" },
    });
    expect(planned.placements.find((placement) => placement.target === "blog/prod")?.nodes).toEqual(
      ["b"],
    );
  });

  it("handles stale placements and insufficient failover without partial rewrite", async () => {
    const stale = ["gone"];
    const planned = await planCreditPlacement({
      nodes: [node("a", 100, undefined, 60), node("b", 120, { tier: "fast" }, 60)],
      workloads: [
        workload("shop/prod", { replicas: 2, current: stale }),
        workload("blog/prod", { selector: { tier: "fast" }, replicas: "all" }),
      ],
    });

    expect(planned.placements.find((placement) => placement.target === "shop/prod")).toMatchObject({
      nodes: stale,
      pending: { reason: "insufficient-capacity" },
    });
    expect(planned.placements.find((placement) => placement.target === "blog/prod")?.nodes).toEqual(
      ["b"],
    );
  });

  it("keeps all replicas on their last placement when no node is eligible", async () => {
    const current = ["a"];
    const planned = await planCreditPlacement({
      nodes: [node("a", 100)],
      workloads: [
        workload("shop/prod", { replicas: "all", current, selector: { tier: "missing" } }),
      ],
    });

    expect(planned.placements).toEqual([
      expect.objectContaining({
        target: "shop/prod",
        nodes: current,
        pending: expect.objectContaining({ reason: "insufficient-candidates" }),
      }),
    ]);
  });

  it("moves work off an overcommitted node when another node can take it", async () => {
    const planned = await planCreditPlacement({
      nodes: [node("a", 100, undefined, 60), node("b", 150, { tier: "relief" }, 30)],
      workloads: [workload("shop/prod", { current: ["a"], selector: { tier: "relief" } })],
    });

    expect(planned.overcommitted).toBe(true);
    expect(planned.placements).toEqual([{ target: "shop/prod", nodes: ["b"] }]);
    expect(planned.accounts.find((account) => account.id === "a")?.steady.steadyFits).toBe(true);
  });

  it("reports an over-capacity placement that cannot move without erasing it", async () => {
    const planned = await planCreditPlacement({
      nodes: [node("a", 100, undefined, 60)],
      workloads: [workload("shop/prod", { current: ["a"] })],
    });

    expect(planned.placements).toEqual([
      expect.objectContaining({
        target: "shop/prod",
        nodes: ["a"],
        pending: expect.objectContaining({ reason: "over-capacity" }),
      }),
    ]);
  });

  it("expands all placement on a join and converges a drained node out of current placement", async () => {
    const joined = await planCreditPlacement({
      nodes: [node("a", 100), node("b", 100)],
      workloads: [workload("shop/prod", { replicas: "all" })],
    });
    const drained = await planCreditPlacement({
      nodes: [node("b", 100)],
      workloads: [workload("shop/prod", { replicas: "all", current: ["a", "b"] })],
    });

    expect(joined.placements[0]?.nodes).toEqual(["a", "b"]);
    expect(drained.placements[0]?.nodes).toEqual(["b"]);
  });

  it("allows one protected-surge rollout but refuses a larger transition", async () => {
    const planned = await planCreditPlacement({
      nodes: [node("a", 100, undefined, 20), node("b", 70, { tier: "fast" }, 20)],
      workloads: [
        workload("base/stable", { current: ["b"], selector: { tier: "fast" } }),
        workload("shop/prod", { current: ["a"], selector: { tier: "fast" } }),
        workload("shop/staging", { current: ["a"], selector: { tier: "fast" } }),
      ],
    });

    expect(
      planned.placements.find((placement) => placement.target === "shop/prod")?.pending,
    ).toBeUndefined();
    expect(
      planned.placements.find((placement) => placement.target === "shop/staging"),
    ).toMatchObject({ pending: { reason: "insufficient-capacity" } });
  });

  it("plans cross-project contention once and is independent of input order", async () => {
    const input = {
      nodes: [node("a", 80, undefined, 40), node("b", 80, undefined, 40)],
      workloads: [
        workload("blog/prod", { replicas: "all" }),
        workload("shop/prod", { replicas: "all" }),
      ],
    };
    const first = await planCreditPlacement(input);
    const second = await planCreditPlacement({
      nodes: [...input.nodes].reverse(),
      workloads: [...input.workloads].reverse(),
    });

    expect(second).toEqual(first);
    expect(first.placements).toEqual([
      { target: "blog/prod", nodes: ["a", "b"] },
      expect.objectContaining({
        target: "shop/prod",
        nodes: [],
        pending: expect.objectContaining({ reason: "insufficient-capacity" }),
      }),
    ]);
  });

  it("keeps numeric and all current placements byte-identical when capacity cannot fit", async () => {
    const numeric = ["b", "a"];
    const all = ["a", "b"];
    const planned = await planCreditPlacement({
      nodes: [node("a", 70, undefined, 40), node("b", 70, undefined, 40)],
      workloads: [
        workload("shop/prod", { replicas: 2, current: numeric }),
        workload("blog/prod", { replicas: "all", current: all }),
      ],
    });

    expect(planned.placements).toEqual([
      expect.objectContaining({ target: "blog/prod", nodes: all, pending: expect.any(Object) }),
      expect.objectContaining({ target: "shop/prod", nodes: numeric, pending: expect.any(Object) }),
    ]);
  });

  it.each([1, 7, 42, 1337, 90_210, 771_717, 4_294_967])(
    "simulates deterministic credit invariants independently (seed %i)",
    async (seed) => {
      const { nodes, workloads } = generatedFleet(seed);
      const first = await planCreditPlacement({ nodes, workloads });
      const second = await planCreditPlacement({
        nodes: [...nodes].reverse(),
        workloads: [...workloads].reverse(),
      });

      expect(second).toEqual(first);
      assertSimulation(first, nodes, workloads);
    },
  );

  it("refuses duplicate planner identities before selection", async () => {
    await expect(
      planCreditPlacement({
        nodes: [node("a", 100), node("a", 100)],
        workloads: [workload("shop/prod")],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      planCreditPlacement({
        nodes: [node("a", 100)],
        workloads: [workload("shop/prod"), workload("shop/prod")],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      planCreditPlacement({
        nodes: [node("a", 100)],
        workloads: [workload("blog/prod", { current: ["a", "a"] })],
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("normalizes malformed identity types into the planner error contract", async () => {
    await expect(
      planCreditPlacement({
        nodes: [node("a", 100), { ...node("b", 100), id: Symbol("b") }],
        workloads: [workload("shop/prod")],
      } as never),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      planCreditPlacement({
        nodes: [node("a", 100)],
        workloads: [workload("shop/prod"), { ...workload("blog/prod"), project: Symbol("blog") }],
      } as never),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("refuses identities outside the registry slug and node-id contracts", async () => {
    for (const input of [
      { nodes: [node("BAD", 100)], workloads: [workload("shop/prod")] },
      {
        nodes: [node("a", 100)],
        workloads: [{ ...workload("shop/prod"), project: "bad/project" }],
      },
      {
        nodes: [node("a", 100)],
        workloads: [workload("shop/prod", { current: ["BAD"] })],
      },
    ]) {
      await expect(planCreditPlacement(input)).rejects.toMatchObject({ code: "invalid-input" });
    }
  });
});

function node(id: string, allocatableMb: number, labels?: Record<string, string>, runtimeMb = 20) {
  return {
    id,
    profile: { allocatableMb, runtimeMb },
    ...(labels === undefined ? {} : { labels }),
  };
}

function workload(
  target: string,
  opts?: {
    processes?: number;
    replicas?: number | "all";
    current?: string[];
    selector?: Record<string, string>;
  },
) {
  const [project, env] = target.split("/");
  return {
    project: project as string,
    env: env as string,
    replicas: opts?.replicas ?? 1,
    processes: opts?.processes ?? 1,
    current: opts?.current ?? [],
    ...(opts?.selector === undefined ? {} : { selector: opts.selector }),
  };
}

function generatedFleet(seed: number) {
  const next = generator(seed);
  const nodes = Array.from({ length: 3 + Math.floor(next() * 3) }, (_, index) =>
    node(
      `node-${index}`,
      120 + Math.floor(next() * 81),
      index % 2 === 0 ? { tier: "fast" } : undefined,
      10 + Math.floor(next() * 5) * 10,
    ),
  );
  const workloads = Array.from({ length: 18 }, (_, index) => {
    const eligible = nodes.filter((entry) => index % 3 !== 0 || entry.labels?.tier === "fast");
    const current =
      index % 4 === 0 && eligible.length > 0
        ? [eligible[Math.floor(next() * eligible.length)]?.id as string]
        : [];
    return workload(`project-${index}/env`, {
      processes: Math.floor(next() * 4),
      replicas: index % 5 === 0 ? "all" : 1 + Math.floor(next() * Math.min(2, eligible.length)),
      current,
      ...(index % 3 === 0 ? { selector: { tier: "fast" } } : {}),
    });
  });
  return { nodes, workloads };
}

function assertSimulation(
  plan: Awaited<ReturnType<typeof planCreditPlacement>>,
  nodes: ReturnType<typeof node>[],
  workloads: ReturnType<typeof workload>[],
): void {
  const transient = new Map(nodes.map((entry) => [entry.id, 0]));
  const steady = new Map(nodes.map((entry) => [entry.id, 0]));
  const workloadByTarget = new Map(
    workloads.map((entry) => [`${entry.project}/${entry.env}`, entry]),
  );

  for (const placement of plan.placements) {
    expect(new Set(placement.nodes).size).toBe(placement.nodes.length);
  }
  for (const placement of plan.placements.filter((entry) => entry.pending !== undefined)) {
    const demand = workloadByTarget.get(placement.target);
    if (demand === undefined) throw new Error(`missing workload ${placement.target}`);
    expect(placement.nodes).toEqual(demand.current);
    for (const id of placement.nodes) {
      const node = nodes.find((entry) => entry.id === id);
      if (node?.profile !== undefined && node.profile !== null)
        steady.set(id, (steady.get(id) as number) + node.profile.runtimeMb * demand.processes);
    }
  }
  for (const placement of plan.placements.filter((entry) => entry.pending === undefined)) {
    const demand = workloadByTarget.get(placement.target);
    if (demand === undefined) throw new Error(`missing workload ${placement.target}`);
    const eligible = nodes.filter(
      (entry) =>
        demand.selector === undefined ||
        Object.entries(demand.selector).every(([key, value]) => entry.labels?.[key] === value),
    );
    expect(placement.nodes.every((id) => eligible.some((entry) => entry.id === id))).toBe(true);
    expect(placement.nodes).toHaveLength(
      demand.replicas === "all" ? eligible.length : demand.replicas,
    );
    for (const id of placement.nodes) {
      const node = nodes.find((entry) => entry.id === id);
      if (node === undefined) throw new Error(`missing node ${id}`);
      steady.set(id, (steady.get(id) as number) + node.profile.runtimeMb * demand.processes);
      if (!demand.current.includes(id)) {
        transient.set(
          id,
          (transient.get(id) as number) + node.profile.runtimeMb * demand.processes,
        );
      }
    }
  }
  for (const workload of workloads) {
    for (const id of workload.current) {
      const node = nodes.find((entry) => entry.id === id);
      if (node?.profile !== undefined && node.profile !== null)
        transient.set(
          id,
          (transient.get(id) as number) + node.profile.runtimeMb * workload.processes,
        );
    }
  }
  for (const account of plan.accounts) {
    const source = nodes.find((entry) => entry.id === account.id);
    if (source === undefined) throw new Error(`missing node ${account.id}`);
    expect(account.transient.runtimeMb + account.transient.transitionMb).toBe(
      transient.get(account.id),
    );
    expect(account.steady.runtimeMb).toBe(steady.get(account.id));
    expect(account.transient.usedMb).toBe(
      account.transient.runtimeMb + account.transient.transitionMb + account.transient.deployMb,
    );
    expect(account.transient.deployMb).toBe(0);
    const protectedMb = Math.max(0, source.profile.runtimeMb - account.transient.transitionMb);
    expect(account.transient.protectedMb).toBe(protectedMb);
    expect(account.transient.deployAvailableMb).toBe(
      Math.max(
        0,
        source.profile.allocatableMb - (transient.get(account.id) as number) - protectedMb,
      ),
    );
    expect(account.transient.deficitMb).toBe(
      Math.max(0, (transient.get(account.id) as number) - source.profile.allocatableMb),
    );
    expect(account.steady.steadyDeficitMb).toBe(
      Math.max(
        0,
        (steady.get(account.id) as number) +
          source.profile.runtimeMb -
          source.profile.allocatableMb,
      ),
    );
  }
}

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}
