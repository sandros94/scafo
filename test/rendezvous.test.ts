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
  parseReplicas,
  rendezvousOrder,
  resolveReplicas,
} from "../src/core/placement/index.ts";
import type { EnvironmentRecord, ReplicaCount } from "../src/core/types/registry.ts";
import { randomSlug, rejectsWith, seededRng } from "./_helpers.ts";

const PROJECT = "shop";

/** Seeds the property run replays from; a failure is reproducible by its number. */
const SEEDS = [1, 7, 42, 1337, 90_210];

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
    expect(chosen).toEqual([...ranked.slice(0, 2)].sort());
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
      const nodes = Array.from({ length: 5 }, (_, i) => `node-${String(i)}-${randomSlug(rng, 6)}`);
      const environments = Array.from({ length: 40 }, () => ({
        project: randomSlug(rng, 8),
        env: randomSlug(rng, 8),
      }));
      const replicas: ReplicaCount = 2;

      const before = new Map<string, string[]>();
      for (const target of environments) {
        before.set(
          `${target.project}/${target.env}`,
          await assignNodes({ ...target, nodes, replicas }),
        );
      }

      /* One node leaves — a crash, a drain, a machine taken out of the fleet. */
      const leaving = nodes[2];
      const remaining = nodes.filter((id) => id !== leaving);

      const seen: Array<{ key: string; was: string[]; now: string[]; held: boolean }> = [];
      for (const target of environments) {
        const key = `${target.project}/${target.env}`;
        const was = before.get(key) as string[];
        seen.push({
          key,
          was,
          now: await assignNodes({ ...target, nodes: remaining, replicas }),
          held: was.includes(leaving),
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
         the one that is missing. */
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
          count: Math.min(replicas, remaining.length),
        })),
      );

      /* The run is only evidence if the node actually held something. */
      expect(disturbed.length).toBeGreaterThan(0);
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
