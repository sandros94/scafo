/* A deployment record is written once and never rewritten, and the module offers no way to. */

import { describe, expect, it } from "vitest";
import * as deploymentsModule from "../src/core/registry/deployments.ts";
import {
  createDeployment,
  createProject,
  getDeployment,
  listDeployments,
} from "../src/core/registry/index.ts";
import { deploymentKey } from "../src/core/registry/paths.ts";
import type { DeploymentInput } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const DEPLOYMENT: DeploymentInput = {
  version: "0123abcd",
  source: {
    provider: "github",
    repo: "sandros94/scafo",
    ref: "refs/heads/main",
    commit: "cafe1234",
  },
};

/** Every field two records of one deployment may not disagree about. */
const DIFFERENT_IN: Array<{ field: string; patch: Partial<DeploymentInput> }> = [
  {
    field: "oidc",
    patch: { oidc: { issuer: "https://ci.test", subject: "repo:sandros94/scafo" } },
  },
  {
    field: "source",
    patch: {
      source: {
        provider: "github",
        repo: "sandros94/scafo",
        ref: "refs/heads/main",
        commit: "beef5678",
      },
    },
  },
];

async function seeded(): Promise<{ store: MemoryCasStore; clock: ManualClock }> {
  const store = new MemoryCasStore();
  const clock = ctxWith(store);
  await createProject(clock.ctx, { slug: PROJECT });
  return { store, clock };
}

describe("createDeployment", () => {
  it("stamps the immutable deployment history record", async () => {
    const { clock } = await seeded();

    const record = await createDeployment(clock.ctx, PROJECT, DEPLOYMENT);
    expect(record).toMatchObject({
      v: 1,
      version: DEPLOYMENT.version,
    });
    expect(Date.parse(record.createdAt)).toBe(clock.nowMs());
    await expect(getDeployment(clock.ctx, PROJECT, DEPLOYMENT.version)).resolves.toEqual(record);
  });

  it("is idempotent and keeps the original createdAt", async () => {
    const { clock } = await seeded();
    const first = await createDeployment(clock.ctx, PROJECT, DEPLOYMENT);

    clock.tick(60_000);
    const second = await createDeployment(clock.ctx, PROJECT, DEPLOYMENT);

    expect(second).toEqual(first);
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.createdAt)).toBeLessThan(clock.nowMs());
  });

  it.each(DIFFERENT_IN)("still refuses a second record differing in $field", async ({ patch }) => {
    const { store, clock } = await seeded();
    const seedInput = { ...DEPLOYMENT };
    await createDeployment(clock.ctx, PROJECT, seedInput);
    const before = await store.get(deploymentKey(PROJECT, DEPLOYMENT.version));

    const error = await rejectsWith(
      () => createDeployment(clock.ctx, PROJECT, { ...seedInput, ...patch }),
      "immutable",
    );

    expect(error.status).toBe(409);
    expect(await store.get(deploymentKey(PROJECT, DEPLOYMENT.version))).toEqual(before);
  });

  it("rejects a version that is not a content digest", async () => {
    const { clock } = await seeded();

    const error = await rejectsWith(
      () => createDeployment(clock.ctx, PROJECT, { ...DEPLOYMENT, version: "b1" }),
      "invalid-slug",
    );
    expect(error.status).toBe(400);
  });
});

describe("getDeployment / listDeployments", () => {
  it("throws not-found for a deployment that was never recorded", async () => {
    const { clock } = await seeded();

    const error = await rejectsWith(
      () => getDeployment(clock.ctx, PROJECT, "deadbeef"),
      "not-found",
    );
    expect(error.detail).toContain(deploymentKey(PROJECT, "deadbeef"));
  });

  it("lists versions lexicographically, ignoring anything nested", async () => {
    const { store, clock } = await seeded();
    for (const version of ["cccccccc", "aaaaaaaa", "bbbbbbbb"]) {
      await createDeployment(clock.ctx, PROJECT, { ...DEPLOYMENT, version });
    }
    await store.put(
      `${deploymentKey(PROJECT, "aaaaaaaa").slice(0, -".json".length)}/nested.json`,
      "{}",
    );

    await expect(listDeployments(clock.ctx, PROJECT)).resolves.toEqual([
      "aaaaaaaa",
      "bbbbbbbb",
      "cccccccc",
    ]);
  });
});

describe("the deployments module surface", () => {
  it("exposes no way to update or delete a deployment", () => {
    const exported = Object.keys(deploymentsModule).sort();
    expect(exported).toEqual(["createDeployment", "getDeployment", "listDeployments"]);

    for (const name of exported) {
      expect(name, `${name} mutates deployments`).not.toMatch(/delete|remove|set|update|write/i);
    }
  });
});
