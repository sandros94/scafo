/*
 * The set of operator keys a fleet trusts.
 *
 * An operator key is filed exactly where a node's is — a daemon verifies a
 * bearer token against whatever the registry holds under the token's `kid` — so
 * what separates the two is the record itself: an operator names no address,
 * because nothing ever connects to one. That distinction is what the surface
 * here is about, and what keeps the two kinds of record from being administered
 * through each other.
 *
 * The one refusal worth reading twice is the LAST key: a fleet whose trusted set
 * is empty has nobody who can put a key back through a node, and the only way
 * left in is the bucket. Removing the last one is therefore refused rather than
 * carried out — and the last ADMIN is refused for the same reason one tier up,
 * because a fleet whose keys are all operator-tier can never add another admin.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapRole,
  canGrantRole,
  canGrantScope,
  canReachProject,
  canRevoke,
  getOperator,
  isOperatorRecord,
  listOperators,
  OPERATOR_ADDRESS,
  type OperatorRole,
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
    expect(record.addresses).toEqual({ internal: OPERATOR_ADDRESS, apiPort: 0 });
  });
});

describe("what tier a key is", () => {
  it("reads a record written before roles existed as an ADMIN, never as an operator", async () => {
    /* COMPAT: every key trusted by an installation older than this wave is
       full-power today, so a role-less record cannot quietly become a demotion.
       Demoting one is an explicit act; reading one is never an upgrade. */
    await registerNode(clock.ctx, {
      v: 1,
      id: "op-aaaa1111",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-op-aaaa1111" },
      addresses: { internal: OPERATOR_ADDRESS, apiPort: 0 },
    });

    await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toMatchObject({ role: "admin" });
    expect((await listOperators(clock.ctx)).map((entry) => entry.role)).toEqual(["admin"]);
  });

  it("files the tier and the lineage on the record, and reads both back", async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-bbbb2222", "operator"),
      supersedes: "op-aaaa1111",
    });

    const read = await getOperator(clock.ctx, "op-bbbb2222");

    expect(read).toMatchObject({ role: "operator", supersedes: "op-aaaa1111" });
  });

  it("answers nothing for an id that is a machine of this installation", async () => {
    await registerNode(clock.ctx, machine());

    await expect(getOperator(clock.ctx, MACHINE)).resolves.toBeNull();
    await expect(getOperator(clock.ctx, "op-ffff9999")).resolves.toBeNull();
  });
});

describe("the tier a bucket-side registration lands with", () => {
  it("is admin for the very first key, because a fleet must never have zero admins", async () => {
    await expect(bootstrapRole(clock.ctx)).resolves.toBe("admin");
  });

  it("REFUSES an explicit operator-tier first key, and says why", async () => {
    const error = await rejectsWith(() => bootstrapRole(clock.ctx, "operator"), "invalid-input");

    /* A fleet whose only key is operator-tier can never add an admin through a
       node again: the way back in would be the bucket, which is the credential
       the whole exercise exists to avoid carrying. */
    expect(error.detail).toContain("admin");
  });

  it("is operator once the fleet already has an admin, which is least privilege", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));

    await expect(bootstrapRole(clock.ctx)).resolves.toBe("operator");
  });

  it("is admin when a bootstrapped fleet is explicitly asked for one", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));

    await expect(bootstrapRole(clock.ctx, "admin")).resolves.toBe("admin");
  });

  it("counts only ADMINS, so a fleet of operator-tier keys still bootstraps one", async () => {
    /* Only reachable by writing to the bucket directly, and the answer has to be
       the one that puts the fleet back in a state it can be administered from. */
    await trustOperator(clock.ctx, operator("op-bbbb2222", "operator"));

    await expect(bootstrapRole(clock.ctx)).resolves.toBe("admin");
  });
});

describe("what a tier may do", () => {
  const grants: Array<[OperatorRole, OperatorRole, boolean]> = [
    ["admin", "admin", true],
    ["admin", "operator", true],
    ["operator", "operator", true],
    ["operator", "admin", false],
  ];

  it.each(grants)("lets a %s grant a %s: %s", (caller, wanted, allowed) => {
    /* No higher than one's own, which is the whole rule. */
    expect(canGrantRole(caller, wanted)).toBe(allowed);
  });

  it("lets an admin revoke anyone", () => {
    expect(canRevoke(operator("op-aaaa1111", "admin"), "op-bbbb2222")).toBe(true);
  });

  it("lets an operator revoke ONLY the key its own record supersedes", () => {
    const rotated = { ...operator("op-bbbb2222", "operator"), supersedes: "op-cccc3333" };

    expect(canRevoke(rotated, "op-cccc3333")).toBe(true);
    expect(canRevoke(rotated, "op-aaaa1111")).toBe(false);
    expect(canRevoke(operator("op-bbbb2222", "operator"), "op-cccc3333")).toBe(false);
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

  it("answers the record it removed, tier included, which is what an audit line carries", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));
    await trustOperator(clock.ctx, operator("op-bbbb2222", "operator"));

    const removed = await revokeOperator(clock.ctx, "op-bbbb2222");

    expect(removed).toMatchObject({ id: "op-bbbb2222", role: "operator" });
  });

  it("REFUSES the last ADMIN, however many operator-tier keys remain", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));
    await trustOperator(clock.ctx, operator("op-bbbb2222", "operator"));
    await trustOperator(clock.ctx, operator("op-cccc3333", "operator"));

    /* The last-key guard is not enough one tier up: a fleet left with nothing
       but operator-tier keys can never grant an admin through a node again,
       because no caller would be allowed to. */
    const error = await rejectsWith(
      () => revokeOperator(clock.ctx, "op-aaaa1111"),
      "reference-held",
    );

    expect(error.detail).toContain("admin");
    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toContain("op-aaaa1111");
  });

  it("removes an admin while another admin is left, which is the ordinary case", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));
    await trustOperator(clock.ctx, operator("op-bbbb2222", "admin"));

    await revokeOperator(clock.ctx, "op-aaaa1111");

    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toEqual(["op-bbbb2222"]);
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

describe("the projects a key is scoped to", () => {
  it("keeps the list it was given, and reads it back", async () => {
    await trustOperator(clock.ctx, { ...operator("op-aaaa1111", "operator"), projects: ["acme"] });

    await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toMatchObject({
      projects: ["acme"],
    });
  });

  it("reads a key that names none as reaching EVERY project", async () => {
    /* Absent is the compat shape and the ordinary one: a solo installation and
       every fleet older than this wave carries it, and both must go on working
       exactly as they did. */
    await trustOperator(clock.ctx, operator("op-aaaa1111", "operator"));

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect("projects" in key).toBe(false);
    expect(canReachProject(key, "anything-at-all")).toBe(true);
  });

  it("reads a record written before scopes existed as reaching every project", async () => {
    await registerNode(clock.ctx, {
      v: 1,
      id: "op-aaaa1111",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-op-aaaa1111" },
      addresses: { internal: OPERATOR_ADDRESS, apiPort: 0 },
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(key.role).toBe("admin");
    expect(canReachProject(key, "anything-at-all")).toBe(true);
  });

  it("REFUSES to scope an admin, because scoping one is a contradiction", async () => {
    const error = await rejectsWith(
      () => trustOperator(clock.ctx, { ...operator("op-aaaa1111", "admin"), projects: ["acme"] }),
      "invalid-input",
    );

    /* An admin administers every key the fleet trusts — including the keys of
       every other project — so a scope on one says nothing it could enforce. */
    expect(error.detail).toContain("admin");
    await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toBeNull();
  });

  it("refuses a scope naming no project, which would be a key that can do nothing", async () => {
    await rejectsWith(
      () => trustOperator(clock.ctx, { ...operator("op-aaaa1111", "operator"), projects: [] }),
      "invalid-input",
    );
  });

  it("refuses a scope naming something that is not a project slug", async () => {
    await rejectsWith(
      () =>
        trustOperator(clock.ctx, {
          ...operator("op-aaaa1111", "operator"),
          projects: ["Not A Slug"],
        }),
      "invalid-slug",
    );
  });

  it("reads a hand-written record that claims BOTH as scoped, which is the safe direction", async () => {
    /* Only reachable by writing to the bucket by hand, since the surface above
       refuses it — and narrowing is the direction to be wrong in. */
    await registerNode(clock.ctx, {
      v: 1,
      id: "op-aaaa1111",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-op-aaaa1111" },
      addresses: { internal: OPERATOR_ADDRESS, apiPort: 0 },
      operator: { role: "admin", projects: ["acme"] },
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachProject(key, "acme")).toBe(true);
    expect(canReachProject(key, "globex")).toBe(false);
  });
});

describe("which scope a caller may hand out", () => {
  const unscoped: TrustedOperator = operator("op-aaaa1111", "operator");
  const scoped: TrustedOperator = { ...operator("op-bbbb2222", "operator"), projects: ["acme"] };

  it("lets a key that names no projects hand out anything, which is today's behaviour", () => {
    expect(canGrantScope(unscoped, undefined)).toBe(true);
    expect(canGrantScope(unscoped, ["acme", "globex"])).toBe(true);
  });

  it("refuses a scoped key handing out EVERY project", () => {
    expect(canGrantScope(scoped, undefined)).toBe(false);
  });

  it("lets a scoped key hand out its own projects and no others", () => {
    expect(canGrantScope(scoped, ["acme"])).toBe(true);
    expect(canGrantScope(scoped, ["acme", "globex"])).toBe(false);
    expect(canGrantScope(scoped, ["globex"])).toBe(false);
  });
});

/* ------------------------------------------------------------------ helpers */

/** An operator key with a distinct public half, which is all the registry keeps. */
function operator(id: string, role: OperatorRole = "admin"): TrustedOperator {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: `x-for-${id}` }, role };
}

/** A machine node: it names an address, because something connects to it. */
function machine(): NodeRecord {
  return {
    v: 1,
    id: MACHINE,
    publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-node-a" },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  };
}
