/* A build record is written once and never rewritten, and the module offers no way to. */

import { describe, expect, it } from "vitest";
import * as buildsModule from "../src/core/registry/builds.ts";
import { createBuild, createProject, getBuild, listBuilds } from "../src/core/registry/index.ts";
import { artifactKey, buildKey } from "../src/core/registry/paths.ts";
import type { BuildInput } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const BUILD: BuildInput = {
  id: "0123abcd",
  runtimeConfigurable: true,
  builtWithVarset: "aaaaaaaa",
  source: {
    provider: "github",
    repo: "sandros94/scalo",
    ref: "refs/heads/main",
    commit: "cafe1234",
  },
};

async function seeded(): Promise<{ store: MemoryCasStore; clock: ManualClock }> {
  const store = new MemoryCasStore();
  const clock = ctxWith(store);
  await createProject(clock.ctx, { slug: PROJECT });
  return { store, clock };
}

describe("createBuild", () => {
  it("stamps the record and defaults the artifact key", async () => {
    const { clock } = await seeded();

    const record = await createBuild(clock.ctx, PROJECT, BUILD);
    expect(record).toMatchObject({
      v: 1,
      id: BUILD.id,
      artifact: artifactKey(PROJECT, BUILD.id),
      runtimeConfigurable: true,
      builtWithVarset: "aaaaaaaa",
    });
    expect(Date.parse(record.createdAt)).toBe(clock.nowMs());
    await expect(getBuild(clock.ctx, PROJECT, BUILD.id)).resolves.toEqual(record);
  });

  it("keeps a caller-supplied artifact key", async () => {
    const { clock } = await seeded();
    const record = await createBuild(clock.ctx, PROJECT, {
      ...BUILD,
      artifact: "artifacts/custom",
    });
    expect(record.artifact).toBe("artifacts/custom");
  });

  it("is idempotent and keeps the original createdAt", async () => {
    const { clock } = await seeded();
    const first = await createBuild(clock.ctx, PROJECT, BUILD);

    clock.tick(60_000);
    const second = await createBuild(clock.ctx, PROJECT, BUILD);

    expect(second).toEqual(first);
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.createdAt)).toBeLessThan(clock.nowMs());
  });

  it("refuses to rewrite a build whose contents differ", async () => {
    const { store, clock } = await seeded();
    await createBuild(clock.ctx, PROJECT, BUILD);
    const before = await store.get(buildKey(PROJECT, BUILD.id));

    const error = await rejectsWith(
      () => createBuild(clock.ctx, PROJECT, { ...BUILD, runtimeConfigurable: false }),
      "immutable",
    );
    expect(error.status).toBe(409);

    const after = await store.get(buildKey(PROJECT, BUILD.id));
    expect(after).toEqual(before);
  });

  it("rejects an id that is not a content digest", async () => {
    const { clock } = await seeded();

    const error = await rejectsWith(
      () => createBuild(clock.ctx, PROJECT, { ...BUILD, id: "b1" }),
      "invalid-slug",
    );
    expect(error.status).toBe(400);
  });
});

describe("getBuild / listBuilds", () => {
  it("throws not-found for a build that was never recorded", async () => {
    const { clock } = await seeded();

    const error = await rejectsWith(() => getBuild(clock.ctx, PROJECT, "deadbeef"), "not-found");
    expect(error.detail).toContain(buildKey(PROJECT, "deadbeef"));
  });

  it("lists ids lexicographically, ignoring anything nested", async () => {
    const { store, clock } = await seeded();
    for (const id of ["cccccccc", "aaaaaaaa", "bbbbbbbb"]) {
      await createBuild(clock.ctx, PROJECT, { ...BUILD, id });
    }
    await store.put(`${buildKey(PROJECT, "aaaaaaaa").slice(0, -".json".length)}/nested.json`, "{}");

    await expect(listBuilds(clock.ctx, PROJECT)).resolves.toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
      "cccccccc",
    ]);
  });
});

describe("the builds module surface", () => {
  it("exposes no way to update or delete a build", () => {
    const exported = Object.keys(buildsModule).sort();
    expect(exported).toEqual(["createBuild", "getBuild", "listBuilds"]);

    for (const name of exported) {
      expect(name, `${name} mutates builds`).not.toMatch(/delete|remove|set|update|write/i);
    }
  });
});
