/*
 * Choosing which nodes serve an environment, and how many.
 *
 * The two properties the whole design rests on are asserted rather than
 * described: the same inputs always give the same answer, and a node leaving
 * only disturbs the environments that node was serving. Everything here is pure,
 * so no store, clock or agent is involved.
 */

import { describe, expect, it } from "vitest";
import {
  assignNodes,
  assertReplicas,
  defaultReplicas,
  eligibleNodes,
  parseReplicas,
  rendezvousOrder,
  resolveReplicas,
} from "../src/core/placement/index.ts";
import type {
  EnvironmentRecord,
  NodeRecord,
  NodeSelector,
  ReplicaCount,
} from "../src/core/types/registry.ts";
import { randomSlug, rejectsWith, seededRng } from "./_helpers.ts";

const PROJECT = "shop";

/** Seeds the property run replays from; a failure is reproducible by its number. */
const SEEDS = [1, 7, 42, 1337, 90_210];

/** The label half the property run's fleet carries and half its environments select. */
const FAST = "fast";

/** One environment to place, with the constraint it places under. */
interface Target {
  project: string;
  env: string;
  selector?: NodeSelector;
}

describe("rendezvousOrder", () => {
  it("ranks the same nodes the same way however they arrive", async () => {
    const nodes = ["node-a", "node-b", "node-c", "node-d"];

    const forward = await rendezvousOrder(PROJECT, "prod", nodes);
    const backward = await rendezvousOrder(PROJECT, "prod", [...nodes].reverse());
    const shuffled = await rendezvousOrder(PROJECT, "prod", [
      "node-c",
      "node-a",
      "node-d",
      "node-b",
    ]);

    expect(backward).toEqual(forward);
    expect(shuffled).toEqual(forward);
    /* Every candidate is ranked, none is dropped or duplicated. */
    expect([...forward].sort()).toEqual([...nodes].sort());
  });

  it("ranks two environments of one project independently", async () => {
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];

    const first = await rendezvousOrder(PROJECT, "prod", nodes);
    const second = await rendezvousOrder(PROJECT, "staging", nodes);

    /* Not a guarantee for any one pair, but these two differ — which is what
       keeps every environment of a project off the same single node. */
    expect(second).not.toEqual(first);
  });

  it("gives one project's environment and another's the same name different answers", async () => {
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];

    const here = await rendezvousOrder("shop", "prod", nodes);
    const there = await rendezvousOrder("blog", "prod", nodes);

    expect(there).not.toEqual(here);
  });
});

describe("assignNodes", () => {
  const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];

  it('gives "all" every candidate there is', async () => {
    const chosen = await assignNodes({ project: PROJECT, env: "prod", nodes, replicas: "all" });

    expect(chosen).toEqual([...nodes].sort());
  });

  it("gives a count fewer than the fleet exactly that many, in the ranked order", async () => {
    const ranked = await rendezvousOrder(PROJECT, "prod", nodes);

    const chosen = await assignNodes({ project: PROJECT, env: "prod", nodes, replicas: 2 });

    expect(chosen).toHaveLength(2);
    expect(chosen).toEqual(ranked.slice(0, 2).sort());
  });

  it("gives a count larger than the fleet everything the fleet has", async () => {
    const chosen = await assignNodes({ project: PROJECT, env: "prod", nodes, replicas: 99 });

    expect(chosen).toEqual([...nodes].sort());
  });

  it("answers an empty fleet with an empty assignment rather than inventing a node", async () => {
    /* The caller is what must never write this down as a decision; the function
       itself has nothing to choose from and says so. */
    expect(await assignNodes({ project: PROJECT, env: "prod", nodes: [], replicas: 1 })).toEqual(
      [],
    );
  });

  it("sorts what it chose, so two decisions compare without caring who ranked first", async () => {
    const chosen = await assignNodes({ project: PROJECT, env: "prod", nodes, replicas: 3 });

    expect(chosen).toEqual([...chosen].sort());
  });
});

describe("the stability property", () => {
  it.each(SEEDS)(
    "moves only the environments a removed node was serving (seed %i)",
    async (seed) => {
      const rng = seededRng(seed);
      /*
       * Half the fleet carries `tier=fast` and half the environments select it,
       * so one run covers the unconstrained case and the constrained one at
       * once. The property has to hold WITHIN THE ELIGIBLE SET exactly as it
       * holds over the whole fleet — selecting is only a way of deciding what
       * the candidates are, and everything below is stated over candidates.
       */
      const fleet = Array.from({ length: 5 }, (_, i) =>
        node(`node-${String(i)}-${randomSlug(rng, 6)}`, { tier: i < 3 ? FAST : "slow" }),
      );
      const environments: Target[] = Array.from({ length: 40 }, (_, i) => ({
        project: randomSlug(rng, 8),
        env: randomSlug(rng, 8),
        ...(i % 2 === 0 ? { selector: { tier: FAST } } : {}),
      }));
      const replicas: ReplicaCount = 2;

      /* Candidates first, rendezvous second — the order the coordinator uses. */
      const place = async (candidates: NodeRecord[], target: Target): Promise<string[]> =>
        assignNodes({
          project: target.project,
          env: target.env,
          nodes: eligibleNodes(candidates, target.selector).map((record) => record.id),
          replicas,
        });

      const before = new Map<string, string[]>();
      for (const target of environments) {
        before.set(`${target.project}/${target.env}`, await place(fleet, target));
      }

      /* One node leaves — a crash, a drain, a machine taken out of the fleet.
         A `tier=fast` one, so the environments that select are disturbed too
         rather than sitting the run out. */
      const leaving = fleet[2].id;
      const remaining = fleet.filter((record) => record.id !== leaving);

      const seen: Array<{
        key: string;
        was: string[];
        now: string[];
        held: boolean;
        selector?: NodeSelector;
        eligible: number;
      }> = [];
      for (const target of environments) {
        const key = `${target.project}/${target.env}`;
        const was = before.get(key) as string[];
        seen.push({
          key,
          was,
          now: await place(remaining, target),
          held: was.includes(leaving),
          ...(target.selector === undefined ? {} : { selector: target.selector }),
          eligible: eligibleNodes(remaining, target.selector).length,
        });
      }

      /*
       * THE PROPERTY: an environment the leaving node never served does not move
       * a single replica. Anything else would restart applications that had
       * nothing to do with the node that went away.
       */
      const untouched = seen.filter((entry) => !entry.held);
      expect(untouched.map((entry) => ({ env: entry.key, nodes: entry.now }))).toEqual(
        untouched.map((entry) => ({ env: entry.key, nodes: entry.was })),
      );

      /* The ones it did serve keep every OTHER node they had, and replace just
         the one that is missing — out of what they are eligible for. */
      const disturbed = seen.filter((entry) => entry.held);
      expect(
        disturbed.map((entry) => ({
          env: entry.key,
          keptTheRest: entry.was
            .filter((id) => id !== leaving)
            .every((id) => entry.now.includes(id)),
          stillThere: entry.now.includes(leaving),
          count: entry.now.length,
        })),
      ).toEqual(
        disturbed.map((entry) => ({
          env: entry.key,
          keptTheRest: true,
          stillThere: false,
          count: Math.min(replicas, entry.eligible),
        })),
      );

      /* And the constraint held the whole way through, which is what makes the
         above a property OF the eligible set: a selecting environment never
         landed on a node without the label, before the change or after it. */
      const fast = new Set(
        fleet.filter((record) => record.labels?.tier === FAST).map((record) => record.id),
      );
      for (const entry of seen.filter((candidate) => candidate.selector !== undefined)) {
        expect(
          [...entry.was, ...entry.now].every((id) => fast.has(id)),
          entry.key,
        ).toBe(true);
      }

      /* The run is only evidence if the node actually held something, on both
         sides of the constraint. */
      expect(disturbed.filter((entry) => entry.selector === undefined).length).toBeGreaterThan(0);
      expect(disturbed.filter((entry) => entry.selector !== undefined).length).toBeGreaterThan(0);
    },
  );

  it("spreads environments over the fleet rather than piling them on one node", async () => {
    const rng = seededRng(20_260_818);
    const nodes = ["node-a", "node-b", "node-c", "node-d", "node-e"];
    const held = new Map(nodes.map((id) => [id, 0]));

    for (let i = 0; i < 250; i++) {
      const [chosen] = await assignNodes({
        project: PROJECT,
        env: randomSlug(rng, 10),
        nodes,
        replicas: 1,
      });
      held.set(chosen, (held.get(chosen) ?? 0) + 1);
    }

    /* A digest is not a scheduler, so this is a sanity bound and not a promise:
       every node takes a real share, and none of them takes nearly all of it. */
    for (const [id, count] of held) {
      expect(count, `${id} was given ${String(count)} of 250`).toBeGreaterThan(20);
      expect(count, `${id} was given ${String(count)} of 250`).toBeLessThan(110);
    }
  });
});

describe("a selector and a replica count together", () => {
  /* Two of five carry the label, so "every matching node" and "every node" are
     never the same answer by accident. */
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
      project: PROJECT,
      env: "prod",
      nodes: eligibleNodes(fleet, selector).map((record) => record.id),
      replicas: "all",
    });

    expect(chosen).toEqual(["node-a", "node-c"]);
  });

  it("gives a count that many OF the matching nodes", async () => {
    const chosen = await assignNodes({
      project: PROJECT,
      env: "prod",
      nodes: eligibleNodes(fleet, selector).map((record) => record.id),
      replicas: 1,
    });

    expect(chosen).toHaveLength(1);
    expect(["node-a", "node-c"]).toContain(chosen[0]);
  });

  it("narrows BEFORE it ranks, so the best ineligible node costs nothing", async () => {
    /*
     * The composition order, asserted on the case that tells the two apart.
     * Here the node rendezvous ranks FIRST over the whole fleet is the only one
     * the selector excludes: narrowing first gives the best node that is
     * allowed, while ranking first and filtering after would give nothing at
     * all — an environment refused a placement by a node it never wanted.
     */
    const ranked = await rendezvousOrder(
      PROJECT,
      "prod",
      fleet.map((record) => record.id),
    );
    const excluded = ranked[0];
    const labelled = fleet.map((record) =>
      node(record.id, { tier: record.id === excluded ? "slow" : FAST }),
    );

    const candidates = eligibleNodes(labelled, selector).map((record) => record.id);
    const chosen = await assignNodes({
      project: PROJECT,
      env: "prod",
      nodes: candidates,
      replicas: 1,
    });

    expect(candidates).not.toContain(excluded);
    expect(chosen).toEqual([(await rendezvousOrder(PROJECT, "prod", candidates))[0]]);
    expect(chosen).toHaveLength(1);
  });

  it("answers nothing at all when no node matches, rather than falling back", async () => {
    /* The empty answer the coordinator must never write down: see
       `coordinator-assign.test.ts` for what it does with it instead. */
    const candidates = eligibleNodes(fleet, { gpu: "a100" }).map((record) => record.id);

    expect(candidates).toEqual([]);
    expect(
      await assignNodes({ project: PROJECT, env: "prod", nodes: candidates, replicas: "all" }),
    ).toEqual([]);
  });
});

describe("how many replicas an environment asks for", () => {
  it("serves a long-lived environment everywhere, exactly as it was served before", async () => {
    expect(defaultReplicas(false)).toBe("all");
    expect(resolveReplicas(environment({ ephemeral: false }))).toBe("all");
  });

  it("serves an ephemeral one on a single node", async () => {
    expect(defaultReplicas(true)).toBe(1);
    expect(resolveReplicas(environment({ ephemeral: true }))).toBe(1);
  });

  it("takes what the record says over what its kind would imply", async () => {
    expect(resolveReplicas(environment({ ephemeral: false, replicas: 2 }))).toBe(2);
    expect(resolveReplicas(environment({ ephemeral: true, replicas: "all" }))).toBe("all");
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
    /* An environment nothing runs is expressed by deleting it. Zero is far more
       likely a typo, and one that would take an application off every node. */
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
    addresses: { internal: "10.0.0.1", agentPort: 7400 },
    labels,
  };
}

function environment(opts: { ephemeral: boolean; replicas?: ReplicaCount }): EnvironmentRecord {
  return {
    v: 1,
    name: "prod",
    prefix: `fleets/${PROJECT}/prod`,
    alias: null,
    split: null,
    domains: [],
    placement: "auto",
    ephemeral: opts.ephemeral,
    ...(opts.replicas === undefined ? {} : { replicas: opts.replicas }),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
