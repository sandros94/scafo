/*
 * Labels and the selectors that match them: the charset both ends share, the
 * `k=v,k2=v2` text a flag carries them in, and the AND-matching that decides
 * which nodes an environment may run on at all.
 *
 * Everything here is pure, so no store, clock or agent is involved. How the
 * eligible set then composes with the replica count is asserted in
 * `rendezvous.test.ts`, where the properties it has to keep are already written
 * down.
 */

import { describe, expect, it } from "vitest";
import {
  assertSelector,
  describeSelector,
  eligibleNodes,
  matchesSelector,
} from "../src/core/placement/index.ts";
import {
  assertLabel,
  assertLabels,
  formatLabels,
  isLabel,
  LABEL_MAX_LENGTH,
  parseLabels,
} from "../src/core/utils/labels.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import { rejectsWith } from "./_helpers.ts";

describe("what counts as a label", () => {
  it.each([
    "a",
    "1",
    "fast",
    "eu-west-1",
    "node.kind",
    "gpu_a100",
    "a1.b-2_c3",
    "x".repeat(LABEL_MAX_LENGTH),
  ])("accepts %p", (value) => {
    expect(isLabel(value)).toBe(true);
    expect(() => assertLabel(value)).not.toThrow();
  });

  it.each([
    "",
    "-lead",
    "trail-",
    ".dot",
    "dot.",
    "_under",
    "Upper",
    "with space",
    "sla/sh",
    "tier=fast",
    "café",
  ])("refuses %p rather than reading a meaning into it", async (value) => {
    expect(isLabel(value)).toBe(false);
    const error = await rejectsWith(() => Promise.resolve(assertLabel(value)), "invalid-input");
    expect(error.detail).toContain(`"${value}"`);
  });

  it("refuses one character past the limit, and nothing shorter", async () => {
    expect(isLabel("x".repeat(LABEL_MAX_LENGTH))).toBe(true);
    expect(isLabel("x".repeat(LABEL_MAX_LENGTH + 1))).toBe(false);

    const error = await rejectsWith(
      () => Promise.resolve(assertLabel("x".repeat(LABEL_MAX_LENGTH + 1))),
      "invalid-input",
    );
    expect(error.detail).toContain(`1-${LABEL_MAX_LENGTH}`);
  });

  it.each([undefined, null, 1, true, {}, []])("refuses %p, which is not text at all", async (v) => {
    await rejectsWith(() => Promise.resolve(assertLabel(v)), "invalid-input");
  });

  it("names which half of a pair was the problem", async () => {
    const key = await rejectsWith(
      () => Promise.resolve(assertLabel("Tier", "node label key")),
      "invalid-input",
    );
    expect(key.detail).toContain("node label key");
  });
});

describe("assertLabels", () => {
  it("accepts an object of labels, and an empty one", () => {
    expect(() => assertLabels({ tier: "fast", region: "eu-west-1" }, "labels")).not.toThrow();
    /* Whether "none at all" is meaningful is the caller's question: a node with
       no labels is ordinary, and a selector with none is refused where it is set. */
    expect(() => assertLabels({}, "labels")).not.toThrow();
  });

  it.each([null, "tier=fast", 3, [["tier", "fast"]]])(
    "refuses %p, which is not an object of pairs",
    async (value) => {
      const error = await rejectsWith(
        () => Promise.resolve(assertLabels(value, `"node.labels"`)),
        "invalid-input",
      );
      expect(error.detail).toContain("node.labels");
    },
  );

  it("refuses a bad key and a bad value alike, naming the field", async () => {
    const badKey = await rejectsWith(
      () => Promise.resolve(assertLabels({ Tier: "fast" }, `"node.labels"`)),
      "invalid-input",
    );
    expect(badKey.detail).toContain("label key");

    const badValue = await rejectsWith(
      () => Promise.resolve(assertLabels({ tier: "very fast" }, `"node.labels"`)),
      "invalid-input",
    );
    expect(badValue.detail).toContain(`"tier"`);
  });
});

describe("parseLabels", () => {
  it("reads the comma syntax a flag and an environment variable carry", () => {
    expect(parseLabels("tier=fast", "--node-labels")).toEqual({ tier: "fast" });
    expect(parseLabels("tier=fast,region=eu-west-1", "--node-labels")).toEqual({
      tier: "fast",
      region: "eu-west-1",
    });
  });

  it("forgives the whitespace and the trailing comma a shell leaves behind", () => {
    expect(parseLabels("  tier = fast , region=eu-west-1 , ", "--node-labels")).toEqual({
      tier: "fast",
      region: "eu-west-1",
    });
  });

  it.each(["tier", "=fast", "tier fast", "", "  ", ",", "tier=FAST", "Tier=fast"])(
    "refuses %p, naming the setting it came from",
    async (text) => {
      const error = await rejectsWith(
        () => Promise.resolve(parseLabels(text, "--node-labels")),
        "invalid-input",
      );
      expect(error.detail).toContain("--node-labels");
    },
  );

  it("keeps a value carrying an equals sign, splitting on the first one only", async () => {
    /* Not currently a legal value, so this is about the split rather than about
       what passes: the refusal must be about the VALUE, not about the shape. */
    const error = await rejectsWith(
      () => Promise.resolve(parseLabels("tier=a=b", "--node-labels")),
      "invalid-input",
    );
    expect(error.detail).toContain(`"a=b"`);
  });

  it("refuses a key stated twice rather than picking a winner", async () => {
    /* Both "the first wins" and "the last wins" are defensible, which is exactly
       why neither should be guessed at on the operator's behalf. */
    const error = await rejectsWith(
      () => Promise.resolve(parseLabels("tier=fast,tier=slow", "--node-labels")),
      "invalid-input",
    );

    expect(error.detail).toContain("twice");
    expect(error.detail).toContain("fast");
    expect(error.detail).toContain("slow");
  });

  it("round-trips through the text it prints", () => {
    const labels = { region: "eu-west-1", tier: "fast" };

    /* Sorted, so what an operator is shown is stable and can be pasted straight
       back into the flag it came from. */
    expect(formatLabels(labels)).toBe("region=eu-west-1,tier=fast");
    expect(parseLabels(formatLabels(labels), "--node-labels")).toEqual(labels);
  });
});

describe("matching a selector against a node's labels", () => {
  const labels = { tier: "fast", region: "eu-west-1" };

  it("matches when every entry is present with that exact value", () => {
    expect(matchesSelector(labels, { tier: "fast" })).toBe(true);
    expect(matchesSelector(labels, { tier: "fast", region: "eu-west-1" })).toBe(true);
  });

  it("does NOT match when an entry is absent", () => {
    expect(matchesSelector(labels, { gpu: "a100" })).toBe(false);
    /* AND, not OR: one satisfied entry beside one absent one is a miss. */
    expect(matchesSelector(labels, { tier: "fast", gpu: "a100" })).toBe(false);
  });

  it("does NOT match when the value differs", () => {
    expect(matchesSelector(labels, { tier: "slow" })).toBe(false);
    /* Exact, so nothing is read as a prefix, a glob or a case-insensitive match. */
    expect(matchesSelector(labels, { tier: "FAST" })).toBe(false);
    expect(matchesSelector(labels, { region: "eu-west" })).toBe(false);
  });

  it("ignores the labels the selector never mentions", () => {
    /* A selector states requirements, not the whole truth about a node. */
    expect(matchesSelector({ ...labels, extra: "whatever" }, { tier: "fast" })).toBe(true);
  });

  it("treats an ABSENT selector as unconstrained", () => {
    expect(matchesSelector(labels, undefined)).toBe(true);
    expect(matchesSelector(undefined, undefined)).toBe(true);
  });

  it("treats an EMPTY selector as unconstrained too", () => {
    /* Every entry matching, over zero entries. Storing one is refused where a
       selector is SET, so this is the reading rather than a state to arrive in. */
    expect(matchesSelector(labels, {})).toBe(true);
    expect(matchesSelector(undefined, {})).toBe(true);
  });

  it("matches nothing but those two against a node carrying no labels", () => {
    expect(matchesSelector(undefined, { tier: "fast" })).toBe(false);
    expect(matchesSelector({}, { tier: "fast" })).toBe(false);
  });
});

describe("eligibleNodes", () => {
  const fleet = [
    node("node-a", { tier: "fast", region: "eu-west-1" }),
    node("node-b", { tier: "fast", region: "us-east-1" }),
    node("node-c", { tier: "slow", region: "eu-west-1" }),
    node("node-d"),
  ];

  it("keeps the nodes that satisfy the selector, in the order they arrived", () => {
    expect(ids(eligibleNodes(fleet, { tier: "fast" }))).toEqual(["node-a", "node-b"]);
    expect(ids(eligibleNodes(fleet, { region: "eu-west-1" }))).toEqual(["node-a", "node-c"]);
    expect(ids(eligibleNodes(fleet, { tier: "fast", region: "eu-west-1" }))).toEqual(["node-a"]);
  });

  it("keeps every node when there is no selector at all", () => {
    expect(ids(eligibleNodes(fleet))).toEqual(["node-a", "node-b", "node-c", "node-d"]);
  });

  it("answers an EMPTY set when nothing satisfies it, rather than falling back", () => {
    /* A real outcome — an operator selecting labels no live node carries — and
       the caller's job never to write it down as a placement. */
    expect(eligibleNodes(fleet, { gpu: "a100" })).toEqual([]);
  });

  it("copies rather than aliasing the fleet it was handed", () => {
    const all = eligibleNodes(fleet);
    all.pop();

    expect(fleet).toHaveLength(4);
  });
});

describe("assertSelector", () => {
  it("accepts a selector of labels", () => {
    expect(() => assertSelector({ tier: "fast", region: "eu-west-1" })).not.toThrow();
  });

  it("refuses an EMPTY selector, naming the way to lift a constraint", async () => {
    /* Storing `{}` and storing nothing would be two spellings of one state, and
       an operator lifting a constraint must be able to see that they have. */
    const error = await rejectsWith(() => Promise.resolve(assertSelector({})), "invalid-input");

    expect(error.detail).toContain("clear the selector");
  });

  it.each([null, undefined, "tier=fast", 3, [], { Tier: "fast" }, { tier: "very fast" }])(
    "refuses %p",
    async (value) => {
      await rejectsWith(() => Promise.resolve(assertSelector(value)), "invalid-input");
    },
  );

  it("describes a selector the way an operator would type it back", () => {
    expect(describeSelector({ tier: "fast", region: "eu-west-1" })).toBe(
      "region=eu-west-1,tier=fast",
    );
  });
});

/* ------------------------------------------------------------------ helpers */

function node(id: string, labels?: Record<string, string>): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `key-${id}` },
    addresses: { internal: "10.0.0.1", agentPort: 7400 },
    ...(labels === undefined ? {} : { labels }),
  };
}

function ids(nodes: NodeRecord[]): string[] {
  return nodes.map((record) => record.id);
}
