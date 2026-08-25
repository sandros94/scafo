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
  assertGrantableScope,
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
  WILDCARD_PROJECT,
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

  it("reads an operator-tier key that names none as reaching NOTHING", async () => {
    /* The direction this wave turned round. Nothing GRANTS a record in this
       shape any more, so one that exists was written to the bucket by hand —
       and reading it as every project would be the silent widening the whole
       axis is against. It stays trusted and is worth nothing here. */
    await trustOperator(clock.ctx, operator("op-aaaa1111", "operator"));

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect("projects" in key).toBe(false);
    expect(canReachProject(key, "anything-at-all")).toBe(false);
  });

  it("reads an ADMIN that names none as reaching every project, because an admin is not a tenant", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachProject(key, "anything-at-all")).toBe(true);
  });

  it('reads ["*"] as every project, which is how one says so out loud', async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-aaaa1111", "operator"),
      projects: [WILDCARD_PROJECT],
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachProject(key, "acme")).toBe(true);
    expect(canReachProject(key, "one-nobody-has-created-yet")).toBe(true);
  });

  it("REFUSES a wildcard listed beside named projects, rather than picking a reading", async () => {
    await rejectsWith(
      () =>
        trustOperator(clock.ctx, {
          ...operator("op-aaaa1111", "operator"),
          projects: [WILDCARD_PROJECT, "acme"],
        }),
      "invalid-input",
    );
  });

  it("reads a hand-written mixed wildcard as the two literal names it holds", async () => {
    /* Refused above, so only a bucket-side write produces one — and the narrow
       reading is the safe direction: it reaches a project called "*", which is
       not a project, rather than reaching the fleet. */
    await registerNode(clock.ctx, {
      v: 1,
      id: "op-aaaa1111",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "x-for-op-aaaa1111" },
      addresses: { internal: OPERATOR_ADDRESS, apiPort: 0 },
      operator: { role: "operator", projects: [WILDCARD_PROJECT, "acme"] },
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachProject(key, "acme")).toBe(true);
    expect(canReachProject(key, "globex")).toBe(false);
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
  /* Read as sets, this is one subset test: an admin's reach is every project, a
     wildcard key's is every project, a scoped key's is its list, and a
     scope-LESS operator-tier key's is the empty set. */
  const admin: TrustedOperator = operator("op-aaaa1111", "admin");
  const scopeless: TrustedOperator = operator("op-cccc3333", "operator");
  const scoped: TrustedOperator = { ...operator("op-bbbb2222", "operator"), projects: ["acme"] };
  const wildcard: TrustedOperator = {
    ...operator("op-dddd4444", "operator"),
    projects: [WILDCARD_PROJECT],
  };

  it("lets an ADMIN hand out anything, including every project", () => {
    expect(canGrantScope(admin, ["acme", "globex"])).toBe(true);
    expect(canGrantScope(admin, [WILDCARD_PROJECT])).toBe(true);
  });

  it("lets a WILDCARD key hand out any project, because it reaches every one", () => {
    /* Whether it may hand out another WILDCARD is a separate question, and the
       route's rather than this one's: that grant is an admin's to make. */
    expect(canGrantScope(wildcard, ["globex"])).toBe(true);
  });

  it("lets a scope-LESS operator-tier key hand out NOTHING but the nothing it holds", () => {
    /* Which is what makes its own rotation work and nothing else: the carried
       -over `undefined` is its own scope, and every named project is a widening
       from the empty set. */
    expect(canGrantScope(scopeless, undefined)).toBe(true);
    expect(canGrantScope(scopeless, ["acme"])).toBe(false);
    expect(canGrantScope(scopeless, [WILDCARD_PROJECT])).toBe(false);
  });

  it("lets a scoped key hand out its own projects and no others", () => {
    expect(canGrantScope(scoped, ["acme"])).toBe(true);
    expect(canGrantScope(scoped, ["acme", "globex"])).toBe(false);
    expect(canGrantScope(scoped, ["globex"])).toBe(false);
  });

  it("REFUSES a scoped key handing out every project, which is the escalation to close", () => {
    expect(canGrantScope(scoped, [WILDCARD_PROJECT])).toBe(false);
  });
});

describe("which scope may be GRANTED at all, as against merely carried over", () => {
  it("refuses an operator-tier key that names no projects", () => {
    /* The default-deny, at the one surface both ways into a fleet meet. */
    expect(() => assertGrantableScope({ role: "operator" })).toThrow(/name its projects|projects/);
  });

  it("allows an ADMIN, which never carries a scope and reaches everything by tier", () => {
    expect(() => assertGrantableScope({ role: "admin" })).not.toThrow();
  });

  it("allows an operator-tier key that names projects, or the wildcard", () => {
    expect(() => assertGrantableScope({ role: "operator", projects: ["acme"] })).not.toThrow();
    expect(() =>
      assertGrantableScope({ role: "operator", projects: [WILDCARD_PROJECT] }),
    ).not.toThrow();
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
