/* Environment records and their monotonic deployment notice. */

import { beforeEach, describe, expect, it } from "vitest";
import { deploymentRevision, recordDeployment } from "../src/core/registry/_deployment.ts";
import {
  createBuild,
  createEnvironment,
  createProject,
  environmentKey,
  getEnvironment,
  listEnvironments,
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
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
});

describe("environment records", () => {
  it("fixes the fleet prefix and begins without a deployment notice", async () => {
    expect(await getEnvironment(clock.ctx, PROJECT, ENV)).toMatchObject({
      v: 1,
      name: ENV,
      prefix: fleetPrefix(PROJECT, ENV),
      deployment: null,
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

describe("deployment revision", () => {
  it("records only a monotonic revision and timestamp", async () => {
    const update = await recordDeployment(clock.ctx, PROJECT, ENV, BUILD);
    expect(update.environment.deployment).toEqual({
      revision: 1,
      deployedAt: new Date(clock.nowMs()).toISOString(),
    });
  });

  it("commutes concurrent records into consecutive revisions", async () => {
    const successor = "bbbbbbbb";
    await createBuild(clock.ctx, PROJECT, { id: successor });
    const inner = clock.ctx.store;
    let collide = true;
    clock.ctx.store = {
      get: (key) => inner.get(key),
      getBytes: (key, opts) => inner.getBytes(key, opts),
      put: async (key, body, cas) => {
        if (
          collide &&
          key === environmentKey(PROJECT, ENV) &&
          typeof body === "string" &&
          (JSON.parse(body) as { deployment?: { revision?: number } }).deployment?.revision === 1
        ) {
          collide = false;
          await recordDeployment({ ...clock.ctx, store: inner }, PROJECT, ENV, successor);
        }
        return inner.put(key, body, cas);
      },
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
    };

    await recordDeployment(clock.ctx, PROJECT, ENV, BUILD);
    await expect(getEnvironment(clock.ctx, PROJECT, ENV)).resolves.toMatchObject({
      deployment: { revision: 2 },
    });
  });

  it("refuses malformed and exhausted revisions instead of wrapping them", async () => {
    const environment = await getEnvironment(clock.ctx, PROJECT, ENV);
    expect(() =>
      deploymentRevision({
        ...environment,
        deployment: { revision: 0, deployedAt: environment.createdAt },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() =>
      deploymentRevision({
        ...environment,
        deployment: { revision: 1, deployedAt: "not-a-date" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    /* A record written before the notice existed carries no key at all. */
    expect(() => deploymentRevision({ ...environment, deployment: undefined as never })).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );

    await clock.ctx.store.put(
      environmentKey(PROJECT, ENV),
      JSON.stringify({
        ...environment,
        deployment: {
          revision: Number.MAX_SAFE_INTEGER,
          deployedAt: environment.createdAt,
        },
      }),
      {},
    );
    await rejectsWith(() => recordDeployment(clock.ctx, PROJECT, ENV, BUILD), "invalid-input");
  });
});
