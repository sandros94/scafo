/* Choosing which nodes serve an application, and how many. */

import { describe, expect, it } from "vitest";
import {
  assignNodes,
  assertReplicas,
  DEFAULT_REPLICAS,
  eligibleNodes,
  parseReplicas,
  rendezvousOrder,
  resolveReplicas,
} from "../src/core/placement/index.ts";
import type {
  ApplicationRecord,
  NodeRecord,
  NodeSelector,
  ReplicaCount,
} from "../src/core/types/registry.ts";
import { sha256Hex } from "../src/core/utils/hash.ts";
import { randomSlug, rejectsWith, seededRng } from "./_helpers.ts";

const APPLICATION = "shop";

/** Seeds the property run replays from; a failure is reproducible by its number. */
const SEEDS = [1, 7, 42, 1337, 90_210];

/** The label half the property run's fleet carries and half its applications select. */
const FAST = "fast";

/** One application to place, with the constraint it places under. */
interface Target {
  name: string;
  selector?: NodeSelector;
}

describe("rendezvousOrder", () => {
  it("ranks the same nodes the same way however they arrive", async () => {
    const nodes = ["node-a", "node-b", "node-c", "node-d"];

    const forward = await rendezvousOrder(APPLICATION, nodes);
    const backward = await rendezvousOrder(APPLICATION, [...nodes].reverse());
    const shuffled = await rendezvousOrder(APPLICATION, ["node-c", "node-a", "node-d", "node-b"]);

    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
    expect([...forward].sort()).toEqual([...nodes].sort());
  });

  it("ranks two applications independently", async () => {
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];

    const here = await rendezvousOrder("shop", nodes);
    const there = await rendezvousOrder("blog", nodes);

    expect(there).not.toEqual(here);
  });

  it("ranks an application whose name merely shares a prefix independently", async () => {
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];

    const shop = await rendezvousOrder("shop", nodes);
    const preview = await rendezvousOrder("shop-preview", nodes);

    expect(preview).not.toEqual(shop);
  });

  it("scores each node by the digest of the application name and the node id", async () => {
    /* The digest input is what makes the ranking reproducible outside this
       process: `<application>\n<node>`, and nothing else about either. */
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];
    const scored = await Promise.all(
      nodes.map(async (id) => ({ id, score: await sha256Hex(`${APPLICATION}\n${id}`) })),
    );
    const expected = scored
      .sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? 1 : -1))
      .map((entry) => entry.id);

    expect(await rendezvousOrder(APPLICATION, nodes)).toEqual(expected);
  });
});

describe("assignNodes", () => {
  const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];

  it('gives "all" every candidate there is', async () => {
    const chosen = await assignNodes({ application: APPLICATION, nodes, replicas: "all" });

    expect(chosen).toEqual([...nodes].sort());
  });

  it("gives a count fewer than the fleet exactly that many, in the ranked order", async () => {
    const ranked = await rendezvousOrder(APPLICATION, nodes);

    const chosen = await assignNodes({ application: APPLICATION, nodes, replicas: 2 });

    expect(chosen).toHaveLength(2);
    expect(chosen).toEqual(ranked.slice(0, 2).sort());
  });

  it("gives a count larger than the fleet everything the fleet has", async () => {
    const chosen = await assignNodes({ application: APPLICATION, nodes, replicas: 99 });

    expect(chosen).toEqual([...nodes].sort());
  });

  it("answers an empty fleet with an empty assignment rather than inventing a node", async () => {
    expect(await assignNodes({ application: APPLICATION, nodes: [], replicas: 1 })).toEqual([]);
  });

  it("sorts what it chose, so two decisions compare without caring who ranked first", async () => {
    const chosen = await assignNodes({ application: APPLICATION, nodes, replicas: 3 });

    expect(chosen).toEqual([...chosen].sort());
  });
});

describe("the stability property", () => {
  it.each(SEEDS)(
    "moves only the applications a removed node was serving (seed %i)",
    async (seed) => {
      const rng = seededRng(seed);
      const fleet = Array.from({ length: 5 }, (_, i) =>
        node(`node-${String(i)}-${randomSlug(rng, 6)}`, { tier: i < 3 ? FAST : "slow" }),
      );
      const applications: Target[] = Array.from({ length: 40 }, (_, i) => ({
        name: `${randomSlug(rng, 8)}-${String(i)}`,
        ...(i % 2 === 0 ? { selector: { tier: FAST } } : {}),
      }));
      const replicas: ReplicaCount = 2;

      const place = async (candidates: NodeRecord[], target: Target): Promise<string[]> =>
        assignNodes({
          application: target.name,
          nodes: eligibleNodes(candidates, target.selector).map((record) => record.id),
          replicas,
        });

      const before = new Map<string, string[]>();
      for (const target of applications) {
        before.set(target.name, await place(fleet, target));
      }

      const leaving = fleet[2].id;
      const remaining = fleet.filter((record) => record.id !== leaving);

      const seen: Array<{
        name: string;
        was: string[];
        now: string[];
        held: boolean;
        selector?: NodeSelector;
        eligible: number;
      }> = [];
      for (const target of applications) {
        const was = before.get(target.name) as string[];
        seen.push({
          name: target.name,
          was,
          now: await place(remaining, target),
          held: was.includes(leaving),
          ...(target.selector === undefined ? {} : { selector: target.selector }),
          eligible: eligibleNodes(remaining, target.selector).length,
        });
      }

      const untouched = seen.filter((entry) => !entry.held);
      expect(untouched.map((entry) => ({ application: entry.name, nodes: entry.now }))).toEqual(
        untouched.map((entry) => ({ application: entry.name, nodes: entry.was })),
      );

      const disturbed = seen.filter((entry) => entry.held);
      expect(
        disturbed.map((entry) => ({
          application: entry.name,
          keptTheRest: entry.was
            .filter((id) => id !== leaving)
            .every((id) => entry.now.includes(id)),
          stillThere: entry.now.includes(leaving),
          count: entry.now.length,
        })),
      ).toEqual(
        disturbed.map((entry) => ({
          application: entry.name,
          keptTheRest: true,
          stillThere: false,
          count: Math.min(replicas, entry.eligible),
        })),
      );

      const fast = new Set(
        fleet.filter((record) => record.labels?.tier === FAST).map((record) => record.id),
      );
      for (const entry of seen.filter((candidate) => candidate.selector !== undefined)) {
        expect(
          [...entry.was, ...entry.now].every((id) => fast.has(id)),
          entry.name,
        ).toBe(true);
      }

      expect(disturbed.filter((entry) => entry.selector === undefined).length).toBeGreaterThan(0);
      expect(disturbed.filter((entry) => entry.selector !== undefined).length).toBeGreaterThan(0);
    },
  );

  it("spreads applications over the fleet rather than piling them on one node", async () => {
    const rng = seededRng(20_260_818);
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];
    const held = new Map(nodes.map((id) => [id, 0]));

    for (let i = 0; i < 250; i++) {
      const [chosen] = await assignNodes({
        application: `${randomSlug(rng, 10)}-${String(i)}`,
        nodes,
        replicas: 1,
      });
      held.set(chosen, (held.get(chosen) ?? 0) + 1);
    }

    for (const [id, count] of held) {
      expect(count, `${id} was given ${String(count)} of 250`).toBeGreaterThan(20);
      expect(count, `${id} was given ${String(count)} of 250`).toBeLessThan(110);
    }
  });
});

describe("a selector and a replica count together", () => {
  const fleet = [
    node("node-a", { tier: FAST }),
    node("node-b", { tier: "slow" }),
    node("node-c", { tier: FAST }),
    node("node-d", { tier: "slow" }),
    node("node-e", { tier: "slow" }),
  ];
  const selector: NodeSelector = { tier: FAST };

  it('gives "all" every MATCHING node, and not every node', async () => {
    const chosen = await assignNodes({
      application: APPLICATION,
      nodes: eligibleNodes(fleet, selector).map((record) => record.id),
      replicas: "all",
    });

    expect(chosen).toEqual(["node-a", "node-c"]);
  });

  it("gives a count that many OF the matching nodes", async () => {
    const chosen = await assignNodes({
      application: APPLICATION,
      nodes: eligibleNodes(fleet, selector).map((record) => record.id),
      replicas: 1,
    });

    expect(chosen).toHaveLength(1);
    expect(["node-a", "node-c"]).toContain(chosen[0]);
  });

  it("narrows BEFORE it ranks, so the best ineligible node costs nothing", async () => {
    const ranked = await rendezvousOrder(
      APPLICATION,
      fleet.map((record) => record.id),
    );
    const excluded = ranked[0];
    const labelled = fleet.map((record) =>
      node(record.id, { tier: record.id === excluded ? "slow" : FAST }),
    );

    const candidates = eligibleNodes(labelled, selector).map((record) => record.id);
    const chosen = await assignNodes({
      application: APPLICATION,
      nodes: candidates,
      replicas: 1,
    });

    expect(candidates).not.toContain(excluded);
    expect(chosen).toEqual([(await rendezvousOrder(APPLICATION, candidates))[0]]);
    expect(chosen).toHaveLength(1);
  });

  it("answers nothing at all when no node matches, rather than falling back", async () => {
    const candidates = eligibleNodes(fleet, { gpu: "a100" }).map((record) => record.id);

    expect(candidates).toEqual([]);
    expect(
      await assignNodes({ application: APPLICATION, nodes: candidates, replicas: "all" }),
    ).toEqual([]);
  });
});

describe("how many replicas an application asks for", () => {
  it("serves an application that never said on every node that may serve it", () => {
    expect(DEFAULT_REPLICAS).toBe("all");
    expect(resolveReplicas(application({}))).toBe("all");
  });

  it("takes what the record says over the default", () => {
    expect(resolveReplicas(application({ replicas: 2 }))).toBe(2);
    expect(resolveReplicas(application({ replicas: "all" }))).toBe("all");
  });
});

describe("assertReplicas", () => {
  it("accepts a whole number of at least one, and all", () => {
    for (const value of [1, 2, 500, "all"]) {
      expect(() => assertReplicas(value)).not.toThrow();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, "1", "every", "", null, undefined, {}])(
    "refuses %p rather than reading a meaning into it",
    async (value) => {
      const error = await rejectsWith(
        () => Promise.resolve(assertReplicas(value)),
        "invalid-input",
      );

      expect(error.detail).toContain("at least 1");
    },
  );

  it("refuses zero rather than reading it as run nowhere", async () => {
    const error = await rejectsWith(() => Promise.resolve(assertReplicas(0)), "invalid-input");

    expect(error.detail).toContain("0 must be");
  });
});

describe("parseReplicas", () => {
  it("reads the two forms a flag comes in", () => {
    expect(parseReplicas("all")).toBe("all");
    expect(parseReplicas("3")).toBe(3);
    expect(parseReplicas("  2  ")).toBe(2);
  });

  it.each(["", "one", "2 nodes", "1.5", "0", "-1", "ALL"])(
    "refuses %p, naming what was typed",
    async (text) => {
      const error = await rejectsWith(() => Promise.resolve(parseReplicas(text)), "invalid-input");

      expect(error.detail).toContain(`"${text.trim()}"`);
    },
  );
});

/** A node record carrying the labels a selector is matched against. */
function node(id: string, labels: Record<string, string>): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `key-${id}` },
    addresses: { internal: "10.0.0.1", apiPort: 7400 },
    labels,
  };
}

function application(opts: { replicas?: ReplicaCount }): ApplicationRecord {
  return {
    v: 1,
    name: APPLICATION,
    deployment: null,
    domains: [],
    ...(opts.replicas === undefined ? {} : { replicas: opts.replicas }),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
