/* Varsets are named records, edited in place, that an environment's deploys carry. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  createDeployment,
  createEnvironment,
  createProject,
  deleteVarset,
  environmentsUsingVarset,
  getEnvironment,
  getVarset,
  listVarsets,
  putVarset,
  setEnvironmentVarset,
  varsetHash,
  varsetUses,
} from "../src/core/registry/index.ts";
import { varsetKey } from "../src/core/registry/paths.ts";
import { sha256Hex } from "../src/core/utils/hash.ts";
import { stableStringify } from "../src/core/utils/json.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectionOf, rejectsWith } from "./_helpers.ts";

const PROJECT = "shop";
const VARS = { DATABASE_URL: "postgres://db.test/app", FEATURE_FLAGS: "beta" };

let store: MemoryCasStore;
let clock: ManualClock;

beforeEach(async () => {
  store = new MemoryCasStore();
  clock = ctxWith(store);
  await createProject(clock.ctx, { slug: PROJECT });
});

describe("varsetHash", () => {
  it("digests the variables, in whichever order they were written", async () => {
    const forward = await varsetHash({ A: "1", B: "2" });
    const backward = await varsetHash({ B: "2", A: "1" });

    expect(forward).toBe(backward);
    await expect(sha256Hex(stableStringify({ A: "1", B: "2" }))).resolves.toBe(forward);
  });

  it("moves the moment a value moves, which is what makes a change visible", async () => {
    const before = await varsetHash(VARS);
    const after = await varsetHash({ ...VARS, FEATURE_FLAGS: "stable" });

    expect(after).not.toBe(before);
  });
});

describe("what a varset may hold", () => {
  it.each(["1UP", "A-B", "A B", "", "__proto__", "constructor", "prototype"])(
    "refuses %j as a variable name, naming it",
    async (name) => {
      const error = await rejectsWith(
        () => putVarset(clock.ctx, PROJECT, { name: "shared", vars: { [name]: "x" } }),
        "invalid-varset",
      );
      expect(error.detail).toContain(name === "" ? '""' : name);
    },
  );

  it("refuses a value that is not text, rather than stringifying it", async () => {
    const error = await rejectsWith(
      () =>
        putVarset(clock.ctx, PROJECT, {
          name: "shared",
          vars: { PORT: 8080 } as unknown as Record<string, string>,
        }),
      "invalid-varset",
    );
    expect(error.detail).toContain("PORT");
  });

  it("takes a varset that holds nothing at all", async () => {
    const stored = await putVarset(clock.ctx, PROJECT, { name: "empty", vars: {} });

    expect(stored.vars).toEqual({});
    await expect(getVarset(clock.ctx, PROJECT, "empty")).resolves.toMatchObject({ vars: {} });
  });
});

describe("writing and reading one", () => {
  it("stores it under its name and replaces it in place", async () => {
    const first = await putVarset(clock.ctx, PROJECT, { name: "shared", vars: VARS });
    expect(first).toEqual({
      v: 1,
      name: "shared",
      vars: VARS,
      updatedAt: new Date(clock.nowMs()).toISOString(),
    });
    await expect(store.get(varsetKey(PROJECT, "shared"))).resolves.not.toBeNull();
    expect(varsetKey(PROJECT, "shared")).toBe("_scafo/projects/shop/varsets/shared.json");

    clock.tick(60_000);
    const second = await putVarset(clock.ctx, PROJECT, {
      name: "shared",
      vars: { DATABASE_URL: "postgres://db.test/other" },
    });

    expect(second.updatedAt).not.toBe(first.updatedAt);
    await expect(getVarset(clock.ctx, PROJECT, "shared")).resolves.toEqual(second);
    expect(await listVarsets(clock.ctx, PROJECT)).toEqual(["shared"]);
  });

  it("refuses a name that is not a slug", async () => {
    const error = await rejectsWith(
      () => putVarset(clock.ctx, PROJECT, { name: "Shared Set", vars: VARS }),
      "invalid-slug",
    );
    expect(error.detail).toContain("Shared Set");
  });

  it("says plainly that one was never written", async () => {
    const error = await rejectsWith(() => getVarset(clock.ctx, PROJECT, "missing"), "not-found");

    expect(error.status).toBe(404);
  });

  it("refuses one an earlier build wrote in a sealed form, naming the way back", async () => {
    await store.put(
      varsetKey(PROJECT, "sealed"),
      JSON.stringify({ v: 1, alg: "A256GCM", iv: "aaaa", ct: "bbbb" }),
    );

    const error = await rejectsWith(
      () => getVarset(clock.ctx, PROJECT, "sealed"),
      "invalid-varset",
    );
    expect(error.detail).toContain("scafo varset set");
  });
});

describe("a record filed under a content id by an earlier build", () => {
  const LEGACY = "bf5d1d1d9e1b80b058709197e0c8f910e9c7362c1400ccbd2309fa7305565a78";

  it("is read as unreadable rather than as a bad name, and can be deleted", async () => {
    await store.put(
      varsetKey(PROJECT, LEGACY),
      JSON.stringify({ v: 1, alg: "A256GCM", iv: "aaaa", ct: "bbbb" }),
    );

    const error = await rejectsWith(() => getVarset(clock.ctx, PROJECT, LEGACY), "invalid-varset");
    expect(error.detail).toContain("scafo varset set");
    expect(await listVarsets(clock.ctx, PROJECT)).toEqual([LEGACY]);

    await deleteVarset(clock.ctx, PROJECT, LEGACY);
    expect(await listVarsets(clock.ctx, PROJECT)).toEqual([]);
  });

  it("is a name nothing new may be written under", async () => {
    const error = await rejectionOf(() =>
      putVarset(clock.ctx, PROJECT, { name: LEGACY, vars: VARS }),
    );

    expect(error.code).toBe("invalid-slug");
  });
});

describe("listVarsets", () => {
  it("names every varset of the project, sorted", async () => {
    for (const name of ["staging", "shared", "preview"]) {
      await putVarset(clock.ctx, PROJECT, { name, vars: VARS });
    }

    expect(await listVarsets(clock.ctx, PROJECT)).toEqual(["preview", "shared", "staging"]);
    await createProject(clock.ctx, { slug: "other" });
    expect(await listVarsets(clock.ctx, "other")).toEqual([]);
  });
});

describe("which environments a varset is carried by", () => {
  it("names them sorted, and none for one nothing points at", async () => {
    await putVarset(clock.ctx, PROJECT, { name: "shared", vars: VARS });
    await putVarset(clock.ctx, PROJECT, { name: "spare", vars: VARS });
    for (const env of ["staging", "production"]) {
      await createEnvironment(clock.ctx, PROJECT, { name: env });
      await setEnvironmentVarset(clock.ctx, PROJECT, env, "shared");
    }

    expect(await environmentsUsingVarset(clock.ctx, PROJECT, "shared")).toEqual([
      "production",
      "staging",
    ]);
    expect(await environmentsUsingVarset(clock.ctx, PROJECT, "spare")).toEqual([]);
  });
});

describe("varsetUses", () => {
  const VERSION = "aaaaaaaa";

  beforeEach(async () => {
    await createDeployment(clock.ctx, PROJECT, { version: VERSION });
    await putVarset(clock.ctx, PROJECT, { name: "shared", vars: VARS });
    for (const env of ["staging", "production"]) {
      await createEnvironment(clock.ctx, PROJECT, { name: env });
      await setEnvironmentVarset(clock.ctx, PROJECT, env, "shared");
    }
  });

  it("names only the environments that point at it, sorted", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "preview" });
    await putVarset(clock.ctx, PROJECT, { name: "spare", vars: VARS });

    expect(await varsetUses(clock.ctx, PROJECT, "shared")).toEqual([
      { env: "production", carried: "never" },
      { env: "staging", carried: "never" },
    ]);
    expect(await varsetUses(clock.ctx, PROJECT, "spare")).toEqual([]);
  });

  it("reads a deploy that carried this very content as current", async () => {
    await recordRevision(clock.ctx, PROJECT, "production", VERSION, {
      varset: { name: "shared", hash: await varsetHash(VARS) },
    });

    expect(await varsetUses(clock.ctx, PROJECT, "shared")).toEqual([
      { env: "production", carried: "current" },
      { env: "staging", carried: "never" },
    ]);
  });

  it("reads a deploy that carried other content, another varset, or none, as stale", async () => {
    await recordRevision(clock.ctx, PROJECT, "production", VERSION, {
      varset: { name: "shared", hash: await varsetHash({ ...VARS, FEATURE_FLAGS: "stable" }) },
    });
    await recordRevision(clock.ctx, PROJECT, "staging", VERSION);

    expect(await varsetUses(clock.ctx, PROJECT, "shared")).toEqual([
      { env: "production", carried: "stale" },
      { env: "staging", carried: "stale" },
    ]);

    /* Editing the varset is what moves a deploy that WAS current to stale. */
    await recordRevision(clock.ctx, PROJECT, "staging", VERSION, {
      varset: { name: "shared", hash: await varsetHash(VARS) },
    });
    await putVarset(clock.ctx, PROJECT, { name: "shared", vars: { ...VARS, EXTRA: "1" } });

    expect(await varsetUses(clock.ctx, PROJECT, "shared")).toContainEqual({
      env: "staging",
      carried: "stale",
    });
  });
});

describe("deleteVarset", () => {
  it("refuses while an environment still carries it, naming them", async () => {
    await putVarset(clock.ctx, PROJECT, { name: "shared", vars: VARS });
    await createEnvironment(clock.ctx, PROJECT, { name: "production" });
    await setEnvironmentVarset(clock.ctx, PROJECT, "production", "shared");

    const error = await rejectsWith(
      () => deleteVarset(clock.ctx, PROJECT, "shared"),
      "reference-held",
    );
    expect(error.detail).toContain("production");
    await expect(getVarset(clock.ctx, PROJECT, "shared")).resolves.toMatchObject({
      name: "shared",
    });
  });

  it("deletes one nothing points at, and says so when it was never there", async () => {
    await putVarset(clock.ctx, PROJECT, { name: "spare", vars: VARS });

    await expect(deleteVarset(clock.ctx, PROJECT, "spare")).resolves.toBeUndefined();
    await rejectsWith(() => getVarset(clock.ctx, PROJECT, "spare"), "not-found");
    await rejectsWith(() => deleteVarset(clock.ctx, PROJECT, "spare"), "not-found");
  });
});

describe("setEnvironmentVarset", () => {
  beforeEach(async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "production" });
  });

  it("requires the varset to exist before an environment points at it", async () => {
    await rejectsWith(
      () => setEnvironmentVarset(clock.ctx, PROJECT, "production", "missing"),
      "not-found",
    );
    await expect(getEnvironment(clock.ctx, PROJECT, "production")).resolves.not.toHaveProperty(
      "varset",
    );
  });

  it("points at one by name, and drops the field again", async () => {
    await putVarset(clock.ctx, PROJECT, { name: "shared", vars: VARS });

    const pointed = await setEnvironmentVarset(clock.ctx, PROJECT, "production", "shared");
    expect(pointed.varset).toBe("shared");

    const cleared = await setEnvironmentVarset(clock.ctx, PROJECT, "production", null);
    expect("varset" in cleared).toBe(false);
    await expect(getEnvironment(clock.ctx, PROJECT, "production")).resolves.not.toHaveProperty(
      "varset",
    );
  });
});
