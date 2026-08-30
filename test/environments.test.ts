/* Environment records and their single current-build marker. */

import { beforeEach, describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { setCurrentBuild } from "../src/core/registry/_current.ts";
import {
  createBuild,
  createEnvironment,
  createProject,
  environmentKey,
  getEnvironment,
  importVarsetKey,
  listEnvironments,
  putVarset,
  sealVarset,
  setEnvironmentVarset,
} from "../src/core/registry/index.ts";
import { fleetPrefix } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const ENV = "prod";
const BUILD = "aaaaaaaa";

let clock: ManualClock;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: ENV });
  await createBuild(clock.ctx, PROJECT, { id: BUILD, runtimeConfigurable: true });
});

describe("environment records", () => {
  it("fixes the fleet prefix and begins without a current build", async () => {
    expect(await getEnvironment(clock.ctx, PROJECT, ENV)).toMatchObject({
      v: 1,
      name: ENV,
      prefix: fleetPrefix(PROJECT, ENV),
      alias: null,
    });
  });

  it("requires the project and lists names lexicographically", async () => {
    await rejectsWith(() => createEnvironment(clock.ctx, "missing", { name: "dev" }), "not-found");
    await createEnvironment(clock.ctx, PROJECT, { name: "zeta" });
    await createEnvironment(clock.ctx, PROJECT, { name: "alpha" });
    await expect(listEnvironments(clock.ctx, PROJECT)).resolves.toEqual(["alpha", ENV, "zeta"]);
  });

  it("is idempotent for identity and refuses a different one", async () => {
    await expect(createEnvironment(clock.ctx, PROJECT, { name: ENV })).resolves.toEqual(
      await getEnvironment(clock.ctx, PROJECT, ENV),
    );
    await rejectsWith(
      () => createEnvironment(clock.ctx, PROJECT, { name: ENV, ephemeral: true }),
      "immutable",
    );
  });

  it("records replicas and selectors on first creation without making them identity", async () => {
    const created = await createEnvironment(clock.ctx, PROJECT, {
      name: "placed",
      replicas: "all",
      nodeSelector: { tier: "fast" },
    });
    expect(created).toMatchObject({ replicas: "all", nodeSelector: { tier: "fast" } });

    await expect(createEnvironment(clock.ctx, PROJECT, { name: "placed" })).resolves.toEqual(
      created,
    );
  });
});

describe("current build", () => {
  it("records only the current build and timestamp", async () => {
    const update = await setCurrentBuild(clock.ctx, PROJECT, ENV, BUILD);
    expect(update.environment.alias).toEqual({
      build: BUILD,
      flippedAt: new Date(clock.nowMs()).toISOString(),
    });
    expect(update.warnings).toEqual([]);
  });

  it("warns when a frozen build cannot use the environment varset", async () => {
    const frozen = "bbbbbbbb";
    await createEnvironment(clock.ctx, PROJECT, { name: "warned", varset: "cccccccc" });
    await createBuild(clock.ctx, PROJECT, {
      id: frozen,
      runtimeConfigurable: false,
      builtWithVarset: "dddddddd",
    });
    const update = await setCurrentBuild(clock.ctx, PROJECT, "warned", frozen);
    expect(update.warnings.map((warning) => warning.code)).toEqual([
      "build-not-runtime-configurable",
    ]);
  });

  it("does not retry a stale current-marker write after its lock authority is lost", async () => {
    const successor = "bbbbbbbb";
    await createBuild(clock.ctx, PROJECT, { id: successor, runtimeConfigurable: true });
    const inner = clock.ctx.store;
    const controller = new AbortController();
    const lost = new ScafoError("lease-lost", "Pointer lock was lost");
    let collide = true;
    clock.ctx.store = {
      get: (key) => inner.get(key),
      getBytes: (key) => inner.getBytes(key),
      put: async (key, body, cas) => {
        if (
          collide &&
          key === environmentKey(PROJECT, ENV) &&
          typeof body === "string" &&
          (JSON.parse(body) as { alias?: { build?: string } }).alias?.build === BUILD
        ) {
          collide = false;
          controller.abort(lost);
          await setCurrentBuild({ ...clock.ctx, store: inner }, PROJECT, ENV, successor);
        }
        return inner.put(key, body, cas);
      },
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
    };

    await expect(
      setCurrentBuild(clock.ctx, PROJECT, ENV, BUILD, { signal: controller.signal }),
    ).rejects.toBe(lost);
    await expect(getEnvironment(clock.ctx, PROJECT, ENV)).resolves.toMatchObject({
      alias: { build: successor },
    });
  });
});

describe("setEnvironmentVarset", () => {
  it("requires the varset to exist", async () => {
    await rejectsWith(() => setEnvironmentVarset(clock.ctx, PROJECT, ENV, "deadbeef"), "not-found");
  });

  it("updates the environment and checks its current build", async () => {
    const frozen = "bbbbbbbb";
    const key = await importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await sealVarset({ TOKEN: { value: "t", secret: true } }, key);
    await putVarset(clock.ctx, PROJECT, sealed);
    await createBuild(clock.ctx, PROJECT, { id: frozen, runtimeConfigurable: false });
    await setCurrentBuild(clock.ctx, PROJECT, ENV, frozen);

    const update = await setEnvironmentVarset(clock.ctx, PROJECT, ENV, sealed.id);
    expect(update.environment.varset).toBe(sealed.id);
    expect(update.warnings.map((warning) => warning.code)).toEqual([
      "build-not-runtime-configurable",
    ]);
  });
});
