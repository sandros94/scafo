/* Wake targets are environments; builds have no independently addressable host. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import {
  blockProject,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  getEnvironment,
  retireEnvironment,
} from "../src/core/registry/index.ts";
import { resolveWakeTarget } from "../src/daemon/_wake-target.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const PROJECT = "shop";
const PREVIEW = "preview";
const BUILD = "aaaaaaaa";
const DOMAIN = "preview.example.com";

let clock: ManualClock;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: PREVIEW, ephemeral: true });
  await createBuild(clock.ctx, PROJECT, { id: BUILD, runtimeConfigurable: true });
  await recordDeployment(clock.ctx, PROJECT, PREVIEW, BUILD);
});

describe("resolveWakeTarget", () => {
  it("resolves an environment host", async () => {
    await expect(target(`shop--${PREVIEW}.apps.test`)).resolves.toMatchObject({
      kind: "environment",
      project: PROJECT,
      env: { name: PREVIEW, deployment: { revision: 1 } },
    });
  });

  it("resolves production from the project apex", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "production" });
    await recordDeployment(clock.ctx, PROJECT, "production", BUILD);
    await expect(target("shop.apps.test")).resolves.toMatchObject({
      env: { name: "production" },
    });
  });

  it("resolves a parked environment's custom domain", async () => {
    await claimDomain(clock.ctx, DOMAIN, PROJECT, PREVIEW);
    await expect(target(DOMAIN, true)).resolves.toMatchObject({ env: { name: PREVIEW } });
    await expect(target(DOMAIN)).resolves.toBeNull();
  });

  it("does not reinterpret an unknown environment label as a build", async () => {
    await expect(target(`shop--${BUILD}.apps.test`)).resolves.toBeNull();
  });

  it("refuses missing-current, retired and blocked environments", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "empty" });
    await expect(target("shop--empty.apps.test")).resolves.toBeNull();
    await retireEnvironment(clock.ctx, PROJECT, PREVIEW);
    await expect(target(`shop--${PREVIEW}.apps.test`)).resolves.toBeNull();

    await createEnvironment(clock.ctx, PROJECT, { name: "other" });
    await recordDeployment(clock.ctx, PROJECT, "other", BUILD);
    await blockProject(clock.ctx, PROJECT);
    await expect(target("shop--other.apps.test")).resolves.toBeNull();
  });

  it("answers unknown and malformed hosts uniformly", async () => {
    await expect(target("other.test")).resolves.toBeNull();
    await expect(target("not_a_host.apps.test")).resolves.toBeNull();
  });
});

async function target(host: string, parked = false): Promise<unknown> {
  const env = await getEnvironment(clock.ctx, PROJECT, PREVIEW);
  return resolveWakeTarget(clock.ctx, {
    host,
    platformDomains: ["apps.test"],
    parked: parked ? [{ project: PROJECT, env }] : [],
  });
}
