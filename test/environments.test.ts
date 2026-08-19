/* Environments and the pointers that steer traffic: alias flips, rollbacks and splits. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createBuild,
  createEnvironment,
  createProject,
  flipAlias,
  getEnvironment,
  listEnvironments,
  putVarset,
  rollbackAlias,
  sealVarset,
  setEnvironmentVarset,
  setSplit,
  importVarsetKey,
} from "../src/core/registry/index.ts";
import { fleetPrefix } from "../src/core/registry/paths.ts";
import type { BuildInput } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const ENV = "prod";
const B1 = "aaaaaaaa";
const B2 = "bbbbbbbb";
const B3 = "cccccccc";
const FROZEN = "dddddddd";

let store: MemoryCasStore;
let clock: ManualClock;

function build(id: string, extra?: Partial<BuildInput>): BuildInput {
  return { id, runtimeConfigurable: true, ...extra };
}

beforeEach(async () => {
  store = new MemoryCasStore();
  clock = ctxWith(store);
  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: ENV });
  for (const id of [B1, B2, B3]) await createBuild(clock.ctx, PROJECT, build(id));
});

describe("createEnvironment", () => {
  it("fixes the fleet prefix at creation", async () => {
    const record = await getEnvironment(clock.ctx, PROJECT, ENV);
    expect(record).toMatchObject({
      v: 1,
      name: ENV,
      prefix: fleetPrefix(PROJECT, ENV),
      alias: null,
      split: null,
      domains: [],
      placement: "auto",
      ephemeral: false,
    });
    expect(record.prefix).toBe(`fleets/${PROJECT}/${ENV}`);
  });

  it("requires the project to exist", async () => {
    const error = await rejectsWith(
      () => createEnvironment(clock.ctx, "missing", { name: "preview" }),
      "not-found",
    );
    expect(error.detail).toContain("missing");
  });

  it("is idempotent, but refuses different settings", async () => {
    clock.tick(5000);
    const again = await createEnvironment(clock.ctx, PROJECT, { name: ENV });
    expect(again.createdAt).toBe((await getEnvironment(clock.ctx, PROJECT, ENV)).createdAt);

    await rejectsWith(
      () => createEnvironment(clock.ctx, PROJECT, { name: ENV, ephemeral: true }),
      "immutable",
    );
  });

  /*
   * A create is retried whenever a caller cannot tell whether the first one
   * landed, so it has to stay idempotent for the life of the environment — not
   * only while the record is still pristine.
   */
  it("stays idempotent once the environment has been in use", async () => {
    await flipAlias(clock.ctx, PROJECT, ENV, B1);

    const again = await createEnvironment(clock.ctx, PROJECT, { name: ENV });
    expect(again.alias).toMatchObject({ build: B1 });
  });

  it("lists environments lexicographically", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "alpha" });
    await expect(listEnvironments(clock.ctx, PROJECT)).resolves.toEqual(["alpha", ENV]);
  });
});

describe("flipAlias", () => {
  it("requires the build to exist", async () => {
    await rejectsWith(() => flipAlias(clock.ctx, PROJECT, ENV, "deadbeef"), "not-found");
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).alias).toBeNull();
  });

  it("records the flip against the injected clock", async () => {
    clock.tick(1000);
    const { environment } = await flipAlias(clock.ctx, PROJECT, ENV, B1);

    expect(environment.alias).toEqual({
      build: B1,
      flippedAt: new Date(clock.nowMs()).toISOString(),
    });
    expect(environment.alias?.previous).toBeUndefined();
  });

  it("moves the outgoing build into previous on every later flip", async () => {
    await flipAlias(clock.ctx, PROJECT, ENV, B1);
    clock.tick(1000);
    const second = await flipAlias(clock.ctx, PROJECT, ENV, B2);
    expect(second.environment.alias).toMatchObject({ build: B2, previous: B1 });

    clock.tick(1000);
    const third = await flipAlias(clock.ctx, PROJECT, ENV, B3);
    expect(third.environment.alias).toMatchObject({ build: B3, previous: B2 });
  });

  it("clears an active split: a flip is a full cutover", async () => {
    await flipAlias(clock.ctx, PROJECT, ENV, B1);
    await setSplit(clock.ctx, PROJECT, ENV, [
      { build: B1, weight: 90 },
      { build: B2, weight: 10 },
    ]);
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).split).not.toBeNull();

    const { environment } = await flipAlias(clock.ctx, PROJECT, ENV, B3);
    expect(environment.split).toBeNull();
    expect(environment.alias).toMatchObject({ build: B3, previous: B1 });
  });
});

describe("rollbackAlias", () => {
  it("swaps current and previous back and forth", async () => {
    await flipAlias(clock.ctx, PROJECT, ENV, B1);
    clock.tick(1000);
    await flipAlias(clock.ctx, PROJECT, ENV, B2);

    clock.tick(1000);
    const rolled = await rollbackAlias(clock.ctx, PROJECT, ENV);
    expect(rolled.alias).toEqual({
      build: B1,
      previous: B2,
      flippedAt: new Date(clock.nowMs()).toISOString(),
    });

    const forward = await rollbackAlias(clock.ctx, PROJECT, ENV);
    expect(forward.alias).toMatchObject({ build: B2, previous: B1 });
  });

  it("has nothing to roll back to before the second flip", async () => {
    const unflipped = await rejectsWith(() => rollbackAlias(clock.ctx, PROJECT, ENV), "not-found");
    expect(unflipped.detail).toContain("no previous build");

    await flipAlias(clock.ctx, PROJECT, ENV, B1);
    const flippedOnce = await rejectsWith(
      () => rollbackAlias(clock.ctx, PROJECT, ENV),
      "not-found",
    );
    expect(flippedOnce.detail).toContain("no previous build");
  });
});

describe("setSplit", () => {
  it("stores whole-number weights that sum to 100", async () => {
    const entries = [
      { build: B1, weight: 60 },
      { build: B2, weight: 40 },
    ];
    const record = await setSplit(clock.ctx, PROJECT, ENV, entries);
    expect(record.split).toEqual(entries);
  });

  it("leaves the alias untouched, so rollback still has a target", async () => {
    await flipAlias(clock.ctx, PROJECT, ENV, B1);
    clock.tick(1000);
    await flipAlias(clock.ctx, PROJECT, ENV, B2);
    const before = await getEnvironment(clock.ctx, PROJECT, ENV);

    const record = await setSplit(clock.ctx, PROJECT, ENV, [
      { build: B2, weight: 95 },
      { build: B3, weight: 5 },
    ]);

    expect(record.alias).toEqual(before.alias);
    const rolled = await rollbackAlias(clock.ctx, PROJECT, ENV);
    expect(rolled.alias).toMatchObject({ build: B1, previous: B2 });
    expect(rolled.split).not.toBeNull();
  });

  it("refuses weights that do not sum to 100", async () => {
    for (const weight of [39, 41]) {
      const error = await rejectsWith(
        () =>
          setSplit(clock.ctx, PROJECT, ENV, [
            { build: B1, weight: 60 },
            { build: B2, weight },
          ]),
        "invalid-input",
      );
      expect(error.status).toBe(400);
    }
  });

  it("refuses fewer than two legs, and weights that are not whole and positive", async () => {
    const single = await rejectsWith(
      () => setSplit(clock.ctx, PROJECT, ENV, [{ build: B1, weight: 100 }]),
      "invalid-input",
    );
    expect(single.detail).toContain("at least two builds");

    await rejectsWith(() => setSplit(clock.ctx, PROJECT, ENV, []), "invalid-input");
    await rejectsWith(
      () =>
        setSplit(clock.ctx, PROJECT, ENV, [
          { build: B1, weight: 99.5 },
          { build: B2, weight: 0.5 },
        ]),
      "invalid-input",
    );
    await rejectsWith(
      () =>
        setSplit(clock.ctx, PROJECT, ENV, [
          { build: B1, weight: 100 },
          { build: B2, weight: 0 },
        ]),
      "invalid-input",
    );
  });

  it("refuses a leg pointing at a build that is not there", async () => {
    await rejectsWith(
      () =>
        setSplit(clock.ctx, PROJECT, ENV, [
          { build: B1, weight: 50 },
          { build: "deadbeef", weight: 50 },
        ]),
      "not-found",
    );
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).split).toBeNull();
  });

  it("clears the split when passed null", async () => {
    await setSplit(clock.ctx, PROJECT, ENV, [
      { build: B1, weight: 50 },
      { build: B2, weight: 50 },
    ]);
    const cleared = await setSplit(clock.ctx, PROJECT, ENV, null);
    expect(cleared.split).toBeNull();
  });
});

describe("the runtime-configurable warning", () => {
  const frozen = (builtWith?: string): BuildInput =>
    build(FROZEN, { runtimeConfigurable: false, builtWithVarset: builtWith });

  it("warns when a frozen build cannot pick the environment varset up", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "warned", varset: "bbbbbbbb" });
    await createBuild(clock.ctx, PROJECT, frozen("aaaaaaaa"));

    const { warnings } = await flipAlias(clock.ctx, PROJECT, "warned", FROZEN);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("build-not-runtime-configurable");
    expect(warnings[0].detail).toContain(FROZEN);
  });

  it("stays quiet for a runtime-configurable build", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "quiet", varset: "bbbbbbbb" });
    const { warnings } = await flipAlias(clock.ctx, PROJECT, "quiet", B1);
    expect(warnings).toEqual([]);
  });

  it("stays quiet when the varsets match", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "matched", varset: "aaaaaaaa" });
    await createBuild(clock.ctx, PROJECT, frozen("aaaaaaaa"));

    const { warnings } = await flipAlias(clock.ctx, PROJECT, "matched", FROZEN);
    expect(warnings).toEqual([]);
  });
});

describe("setEnvironmentVarset", () => {
  it("requires the varset to have been stored first", async () => {
    await rejectsWith(() => setEnvironmentVarset(clock.ctx, PROJECT, ENV, "deadbeef"), "not-found");
    expect((await getEnvironment(clock.ctx, PROJECT, ENV)).varset).toBeUndefined();
  });

  it("points the environment at the varset and re-checks the serving build", async () => {
    const key = await importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await sealVarset({ TOKEN: { value: "t", secret: true } }, key);
    await putVarset(clock.ctx, PROJECT, sealed);
    await createBuild(clock.ctx, PROJECT, build(FROZEN, { runtimeConfigurable: false }));
    await flipAlias(clock.ctx, PROJECT, ENV, FROZEN);

    const { environment, warnings } = await setEnvironmentVarset(
      clock.ctx,
      PROJECT,
      ENV,
      sealed.id,
    );

    expect(environment.varset).toBe(sealed.id);
    expect(warnings.map((warning) => warning.code)).toEqual(["build-not-runtime-configurable"]);
  });

  it("raises no warning while nothing is serving yet", async () => {
    const key = await importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await sealVarset({ TOKEN: { value: "t", secret: true } }, key);
    await putVarset(clock.ctx, PROJECT, sealed);

    const { warnings } = await setEnvironmentVarset(clock.ctx, PROJECT, ENV, sealed.id);
    expect(warnings).toEqual([]);
  });
});
