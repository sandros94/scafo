/* The set of operator keys a fleet trusts. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  assertGrantableScope,
  bootstrapRole,
  canGrantRole,
  canGrantScope,
  canReachApplication,
  canRevoke,
  getOperator,
  listOperators,
  type OperatorRole,
  revokeOperator,
  type TrustedOperator,
  trustOperator,
  WILDCARD_APPLICATION,
} from "../src/core/registry/operators.ts";
import { putJson, readJson } from "../src/core/registry/cas.ts";
import { getNode, registerNode } from "../src/core/registry/nodes.ts";
import { nodeKey, operatorKey } from "../src/core/registry/paths.ts";
import type { NodeRecord, OperatorRecord } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectionOf, rejectsWith } from "./_helpers.ts";

const MACHINE = "node-a";

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("what counts as an operator key", () => {
  it("is what is filed under operators/, and a machine is what is filed under nodes/", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    await registerNode(clock.ctx, machine());

    expect(await readJson(clock.ctx, operatorKey("op-aaaa1111"))).not.toBeNull();
    expect(await readJson(clock.ctx, nodeKey("op-aaaa1111"))).toBeNull();
    expect(await readJson(clock.ctx, nodeKey(MACHINE))).not.toBeNull();
    expect(await readJson(clock.ctx, operatorKey(MACHINE))).toBeNull();
  });

  it("files the public half, which is what verifies a token signed with it", async () => {
    const key = operator("op-aaaa1111");
    await trustOperator(clock.ctx, key);

    const record = await readJson<OperatorRecord>(clock.ctx, operatorKey("op-aaaa1111"));

    expect(record?.value.publicKey).toEqual(key.publicKey);
    expect(record?.value).not.toHaveProperty("addresses");
  });
});

describe("what tier a key is", () => {
  it("reads a record written before roles existed as an ADMIN, never as an operator", async () => {
    await fileByHand("op-aaaa1111", {});

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

  it("REFUSES an id a machine of this installation already holds", async () => {
    await registerNode(clock.ctx, machine());

    const error = await rejectsWith(
      () => trustOperator(clock.ctx, operator(MACHINE)),
      "reference-held",
    );

    expect(error.detail).toContain(MACHINE);
    expect(error.detail).not.toContain("10.0.0.4");
    await expect(getOperator(clock.ctx, MACHINE)).resolves.toBeNull();
    await expect(getNode(clock.ctx, MACHINE)).resolves.toMatchObject({ id: MACHINE });
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

  it("cannot reach a machine's id through this surface, and says nothing about it", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));
    await trustOperator(clock.ctx, operator("op-bbbb2222"));
    await registerNode(clock.ctx, machine());

    const error = await rejectsWith(() => revokeOperator(clock.ctx, MACHINE), "not-found");
    expect(error.detail).not.toContain("10.0.0.4");

    const missing = await rejectsWith(() => revokeOperator(clock.ctx, "op-ffff9999"), "not-found");
    expect(error.detail?.replace(MACHINE, "X")).toBe(missing.detail?.replace("op-ffff9999", "X"));

    await expect(getNode(clock.ctx, MACHINE)).resolves.toBeDefined();
  });

  it("answers an id nothing is filed under as a miss", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111"));

    expect((await rejectionOf(() => revokeOperator(clock.ctx, "op-ffff9999"))).code).toBe(
      "not-found",
    );
  });
});

describe("the applications a key is scoped to", () => {
  it("keeps the list it was given, and reads it back", async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-aaaa1111", "operator"),
      applications: ["acme"],
    });

    await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toMatchObject({
      applications: ["acme"],
    });
  });

  it("reads an operator-tier key that names none as reaching NOTHING", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "operator"));

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect("applications" in key).toBe(false);
    expect(canReachApplication(key, "anything-at-all")).toBe(false);
  });

  it("reads an ADMIN that names none as reaching every application, because an admin is not a tenant", async () => {
    await trustOperator(clock.ctx, operator("op-aaaa1111", "admin"));

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "anything-at-all")).toBe(true);
  });

  it('reads ["*"] as every application, which is how one says so out loud', async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-aaaa1111", "operator"),
      applications: [WILDCARD_APPLICATION],
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "acme")).toBe(true);
    expect(canReachApplication(key, "one-nobody-has-created-yet")).toBe(true);
  });

  it("REFUSES a wildcard listed beside named applications, rather than picking a reading", async () => {
    const error = await rejectionOf(() =>
      trustOperator(clock.ctx, {
        ...operator("op-aaaa1111", "operator"),
        applications: [WILDCARD_APPLICATION, "acme"],
      }),
    );

    expect(error.code).toBe("invalid-input");
  });

  it("reads a hand-written mixed wildcard as the two literal names it holds", async () => {
    await fileByHand("op-aaaa1111", {
      role: "operator",
      applications: [WILDCARD_APPLICATION, "acme"],
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "acme")).toBe(true);
    expect(canReachApplication(key, "globex")).toBe(false);
  });

  it("reads a record written before scopes existed as reaching every application", async () => {
    await fileByHand("op-aaaa1111", {});

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(key.role).toBe("admin");
    expect(canReachApplication(key, "anything-at-all")).toBe(true);
  });

  it("REFUSES to scope an admin, because scoping one is a contradiction", async () => {
    const error = await rejectsWith(
      () =>
        trustOperator(clock.ctx, { ...operator("op-aaaa1111", "admin"), applications: ["acme"] }),
      "invalid-input",
    );

    expect(error.detail).toContain("admin");
    await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toBeNull();
  });

  it("refuses a scope naming no application, which would be a key that can do nothing", async () => {
    const error = await rejectionOf(() =>
      trustOperator(clock.ctx, { ...operator("op-aaaa1111", "operator"), applications: [] }),
    );

    expect(error.code).toBe("invalid-input");
  });

  it("refuses a scope naming something that is not a application slug", async () => {
    const error = await rejectionOf(() =>
      trustOperator(clock.ctx, {
        ...operator("op-aaaa1111", "operator"),
        applications: ["Not A Slug"],
      }),
    );

    expect(error.code).toBe("invalid-slug");
  });

  it("reads a hand-written record that claims BOTH as scoped, which is the safe direction", async () => {
    await fileByHand("op-aaaa1111", { role: "admin", applications: ["acme"] });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "acme")).toBe(true);
    expect(canReachApplication(key, "globex")).toBe(false);
  });
});

describe("a scope entry that is a PREFIX GLOB", () => {
  it("reaches the names that carry the prefix, and stops at the prefix itself", async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-aaaa1111", "operator"),
      applications: ["shop-*"],
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "shop-preview")).toBe(true);
    expect(canReachApplication(key, "shop-preview-2")).toBe(true);
    /* The hyphen is part of the prefix, so the bare name is a different
       application and so is one that merely starts with the same letters. */
    expect(canReachApplication(key, "shop")).toBe(false);
    expect(canReachApplication(key, "shopping")).toBe(false);
  });

  it("stands beside exact names in one scope", async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-aaaa1111", "operator"),
      applications: ["acme", "shop-*"],
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "acme")).toBe(true);
    expect(canReachApplication(key, "shop-preview")).toBe(true);
    expect(canReachApplication(key, "globex")).toBe(false);
  });

  for (const entry of ["*shop", "sh*op", "shop-**", "sh*op-*"]) {
    it(`refuses "${entry}", which is neither a name nor one trailing star`, async () => {
      const error = await rejectsWith(
        () =>
          trustOperator(clock.ctx, {
            ...operator("op-aaaa1111", "operator"),
            applications: [entry],
          }),
        "invalid-input",
      );

      expect(error.detail).toContain("trailing");
      await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toBeNull();
    });
  }

  it("refuses an empty entry, which names no application and globs no prefix", async () => {
    const error = await rejectsWith(
      () =>
        trustOperator(clock.ctx, { ...operator("op-aaaa1111", "operator"), applications: [""] }),
      "invalid-slug",
    );

    expect(error.code).toBe("invalid-slug");
    await expect(getOperator(clock.ctx, "op-aaaa1111")).resolves.toBeNull();
  });

  it('accepts the lone "*", which is the one entry that is a star and nothing else', async () => {
    await trustOperator(clock.ctx, {
      ...operator("op-aaaa1111", "operator"),
      applications: [WILDCARD_APPLICATION],
    });

    const key = (await getOperator(clock.ctx, "op-aaaa1111")) as TrustedOperator;

    expect(canReachApplication(key, "anything-at-all")).toBe(true);
  });
});

describe("which scope a caller may hand out", () => {
  const admin: TrustedOperator = operator("op-aaaa1111", "admin");
  const scopeless: TrustedOperator = operator("op-cccc3333", "operator");
  const scoped: TrustedOperator = {
    ...operator("op-bbbb2222", "operator"),
    applications: ["acme"],
  };
  const wildcard: TrustedOperator = {
    ...operator("op-dddd4444", "operator"),
    applications: [WILDCARD_APPLICATION],
  };

  it("lets an ADMIN hand out anything, including every application", () => {
    expect(canGrantScope(admin, ["acme", "globex"])).toBe(true);
    expect(canGrantScope(admin, [WILDCARD_APPLICATION])).toBe(true);
  });

  it("lets a WILDCARD key hand out any application, because it reaches every one", () => {
    expect(canGrantScope(wildcard, ["globex"])).toBe(true);
  });

  it("lets a scope-LESS operator-tier key hand out NOTHING but the nothing it holds", () => {
    expect(canGrantScope(scopeless, undefined)).toBe(true);
    expect(canGrantScope(scopeless, ["acme"])).toBe(false);
    expect(canGrantScope(scopeless, [WILDCARD_APPLICATION])).toBe(false);
  });

  it("lets a scoped key hand out its own applications and no others", () => {
    expect(canGrantScope(scoped, ["acme"])).toBe(true);
    expect(canGrantScope(scoped, ["acme", "globex"])).toBe(false);
    expect(canGrantScope(scoped, ["globex"])).toBe(false);
  });

  it("REFUSES a scoped key handing out every application, which is the escalation to close", () => {
    expect(canGrantScope(scoped, [WILDCARD_APPLICATION])).toBe(false);
  });

  describe("a caller whose own scope is a prefix glob", () => {
    const globbed: TrustedOperator = {
      ...operator("op-eeee5555", "operator"),
      applications: ["shop-*"],
    };

    it("hands out a name that carries its prefix", () => {
      expect(canGrantScope(globbed, ["shop-preview"])).toBe(true);
      expect(canGrantScope(globbed, ["shop-preview", "shop-staging"])).toBe(true);
    });

    it("hands out a NARROWER glob, whose prefix starts with its own", () => {
      expect(canGrantScope(globbed, ["shop-pre*"])).toBe(true);
      expect(canGrantScope(globbed, ["shop-*"])).toBe(true);
    });

    it("hands out neither the bare prefix nor a wider glob", () => {
      expect(canGrantScope(globbed, ["shop"])).toBe(false);
      expect(canGrantScope(globbed, ["shop*"])).toBe(false);
      expect(canGrantScope(globbed, ["shopping"])).toBe(false);
    });

    it("hands out every application to nobody, which only a key that reaches all may do", () => {
      expect(canGrantScope(globbed, [WILDCARD_APPLICATION])).toBe(false);
      expect(canGrantScope(admin, [WILDCARD_APPLICATION])).toBe(true);
      expect(canGrantScope(wildcard, [WILDCARD_APPLICATION])).toBe(true);
    });

    it("refuses a list where one entry alone is out of reach", () => {
      expect(canGrantScope(globbed, ["shop-preview", "globex"])).toBe(false);
    });
  });
});

describe("which scope may be GRANTED at all, as against merely carried over", () => {
  it("refuses an operator-tier key that names no applications", () => {
    expect(() => assertGrantableScope({ role: "operator" })).toThrow(
      /name its applications|applications/,
    );
  });

  it("allows an ADMIN, which never carries a scope and reaches everything by tier", () => {
    expect(() => assertGrantableScope({ role: "admin" })).not.toThrow();
  });

  it("allows an operator-tier key that names applications, or the wildcard", () => {
    expect(() => assertGrantableScope({ role: "operator", applications: ["acme"] })).not.toThrow();
    expect(() =>
      assertGrantableScope({ role: "operator", applications: [WILDCARD_APPLICATION] }),
    ).not.toThrow();
  });
});

/** An operator key with a distinct public half, which is all the registry keeps. */
function operator(id: string, role: OperatorRole = "admin"): TrustedOperator {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: `x-for-${id}` }, role };
}

/**
 * An operator record written STRAIGHT TO the BUCKET, bypassing every rule
 * `trustOperator` enforces.
 *
 * That is the only way the shapes below exist at all — a record with no role, a
 * scoped admin, a wildcard mixed with slugs — and it is what the read side has
 * to be safe against: whoever holds the bucket's credentials holds the fleet and
 * can write anything, so the reads are asserted against what they might find
 * rather than only against what this code produces.
 */
async function fileByHand(id: string, extra: Partial<OperatorRecord>): Promise<void> {
  await putJson<OperatorRecord>(clock.ctx, operatorKey(id), {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: `x-for-${id}` },
    ...extra,
  });
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
