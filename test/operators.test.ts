/*
 * The set of operator keys a fleet trusts.
 *
 * An operator key is filed exactly where a node's is — an agent verifies a
 * bearer token against whatever the registry holds under the token's `kid` — so
 * what separates the two is the record itself: an operator names no address,
 * because nothing ever connects to one. That distinction is what the surface
 * here is about, and what keeps the two kinds of record from being administered
 * through each other.
 *
 * The one refusal worth reading twice is the LAST key: a fleet whose trusted set
 * is empty has nobody who can put a key back through a node, and the only way
 * left in is the bucket. Removing the last one is therefore refused rather than
 * carried out.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  isOperatorRecord,
  listOperators,
  OPERATOR_ADDRESS,
  revokeOperator,
  type TrustedOperator,
  trustOperator,
} from "../src/core/registry/operators.ts";
import { getNode, registerNode } from "../src/core/registry/nodes.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const MACHINE = "node-a";

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("what counts as an operator key", () => {
  it("reads a record naming no address as an operator, and a node's as a node", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    await registerNode(clock.ctx, machine());

    expect(isOperatorRecord(await getNode(clock.ctx, "op-aaaa1111"))).toBe(true);
    expect(isOperatorRecord(await getNode(clock.ctx, MACHINE))).toBe(false);
  });

  it("files the public half where a node's key is filed, which is what verifies a token", async () => {
    const key = operator("op-aaaa1111");
    await trustOperator(clock.ctx, key);

    const record = await getNode(clock.ctx, "op-aaaa1111");

    expect(record.publicKey).toEqual(key.publicKey);
    expect(record.addresses).toEqual({ internal: OPERATOR_ADDRESS, agentPort: 0 });
  });
});

describe("listing what a fleet trusts", () => {
  it("answers the operator keys alone, never the nodes filed beside them", async () => {
    await trustOperator(clock.ctx, operator("op-bbbb2222"));
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    await registerNode(clock.ctx, machine());

    const trusted = await listOperators(clock.ctx);

    /* In id order, so two callers reading the same registry read the same list. */
    expect(trusted.map((entry) => entry.id)).toEqual(["op-aaaa1111", "op-bbbb2222"]);
  });

  it("answers nothing at all for an installation that has registered none", async () => {
    await registerNode(clock.ctx, machine());

    await expect(listOperators(clock.ctx)).resolves.toEqual([]);
  });
});

describe("trusting a key", () => {
  it("is idempotent: the same key trusted twice is trusted once", async () => {
    const key = operator("op-aaaa1111");

    await trustOperator(clock.ctx, key);
    await trustOperator(clock.ctx, key);

    expect(await listOperators(clock.ctx)).toHaveLength(1);
  });

  it("REFUSES an id a node of this installation already holds", async () => {
    await registerNode(clock.ctx, machine());

    /* Accepting it would replace a node's identity with an operator's, and the
       node would be refused by every peer until it registered again. */
    const error = await rejectsWith(
      () => trustOperator(clock.ctx, operator(MACHINE)),
      "reference-held",
    );

    expect(error.detail).toContain(MACHINE);
    expect(isOperatorRecord(await getNode(clock.ctx, MACHINE))).toBe(false);
  });
});

describe("revoking a key", () => {
  it("removes it, leaving the others trusted", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    await trustOperator(clock.ctx, operator("op-bbbb2222"));

    await revokeOperator(clock.ctx, "op-aaaa1111");

    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toEqual(["op-bbbb2222"]);
  });

  it("REFUSES the last trusted key, and leaves it exactly where it was", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    /* A node beside it is no help: a machine key administers nothing here. */
    await registerNode(clock.ctx, machine());

    const error = await rejectsWith(
      () => revokeOperator(clock.ctx, "op-aaaa1111"),
      "reference-held",
    );

    expect(error.detail).toContain("op-aaaa1111");
    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toEqual(["op-aaaa1111"]);
  });

  it("refuses a node's id through this surface, whatever else is trusted", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    await trustOperator(clock.ctx, operator("op-bbbb2222"));
    await registerNode(clock.ctx, machine());

    const error = await rejectsWith(() => revokeOperator(clock.ctx, MACHINE), "invalid-input");

    expect(error.detail).toContain(MACHINE);
    await expect(getNode(clock.ctx, MACHINE)).resolves.toBeDefined();
  });

  it("answers an id nothing is filed under as a miss", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));

    await rejectsWith(() => revokeOperator(clock.ctx, "op-ffff9999"), "not-found");
  });
});

/* ------------------------------------------------------------------ helpers */

/** An operator key with a distinct public half, which is all the registry keeps. */
function operator(id: string): TrustedOperator {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: `x-for-${id}` } };
}

/** A machine node: it names an address, because something connects to it. */
function machine(): NodeRecord {
  return {
    v: 1,
    id: MACHINE,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-node-a" },
    addresses: { internal: "10.0.0.4", agentPort: 7400 },
  };
}
