import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { readDesired } from "../src/daemon/_desired.ts";
import {
  acquireLease,
  createDeployment,
  createEnvironment,
  createProject,
  deletePlacement,
  environmentKey,
  type LeaseHandle,
  retireEnvironment,
  setNodeSelector,
  unretireEnvironment,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { DEFAULT_CONCURRENCY } from "../src/core/utils/concurrency.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, ObservingStore } from "./_helpers.ts";

const PROJECT = "shop";
const OTHER_PROJECT = "blog";
const VERSION = "b1b1b1b1";
const SELF = "node-a";
const PEER = "node-b";
const PREVIEW = "preview";

let clock: ManualClock;
let registry: RegistryContext;
let lease: LeaseHandle;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  registry = clock.ctx;

  for (const project of [PROJECT, OTHER_PROJECT]) {
    await createProject(registry, { slug: project });
    await createDeployment(registry, project, { version: VERSION });
  }
  await deployed(PROJECT, "prod");

  const acquired = await acquireLease(registry, SELF);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("an environment nobody has placed", () => {
  it("is served nowhere, and reported nowhere either", async () => {
    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId });

      expect(state.environments, nodeId).toEqual([]);
      expect(state.fleet, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });
});

describe("an environment that has been placed", () => {
  it("is served here when the decision names this node", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF, PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF, PEER], self: true },
    ]);
  });

  it("is NOT served here when the decision names other nodes", async () => {
    await writePlacement(registry, PROJECT, "prod", [PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments).toEqual([]);
    /* Still part of the fleet view: this node routes to it, it just does not run it. */
    expect(state.fleet.map((entry) => `${entry.project}/${entry.env.name}`)).toEqual([
      `${PROJECT}/prod`,
    ]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [PEER], self: false },
    ]);
  });

  it("reports what it is NOT serving, so an operator can see where it went", async () => {
    await deployed(PROJECT, "staging");
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await writePlacement(registry, PROJECT, "staging", [PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true },
      { project: PROJECT, env: "staging", nodes: [PEER], self: false },
    ]);
  });

  it("is served nowhere when the decision names nobody", async () => {
    await writePlacement(registry, PROJECT, "prod", [], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments).toEqual([]);
    expect(state.placements[0]).toMatchObject({ nodes: [], self: false });
  });

  it("filters each project on its own", async () => {
    await deployed(OTHER_PROJECT, "prod");
    await writePlacement(registry, PROJECT, "prod", [PEER], lease);
    await writePlacement(registry, OTHER_PROJECT, "prod", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.project)).toEqual([OTHER_PROJECT]);
    expect(
      state.placements.map((view) => `${view.project}/${view.env}:${String(view.self)}`),
    ).toEqual([`${OTHER_PROJECT}/prod:true`, `${PROJECT}/prod:false`]);
  });
});

describe("an environment that carries a node selector", () => {
  const FAST = { tier: "fast" };

  it("is NOT served anywhere while no coordinator has placed it", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId });
      expect(state.environments, nodeId).toEqual([]);
      expect(state.fleet, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("is served the moment a decision names this node, selector and all", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true, selector: FAST },
    ]);
  });

  it("is left out again when the decision names other nodes", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "prod", [PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments).toEqual([]);
    expect(state.placements[0]).toMatchObject({ self: false, selector: FAST });
  });

  it("reports the constraint beside the decision, so both are read together", async () => {
    await deployed(PROJECT, "staging");
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await writePlacement(registry, PROJECT, "staging", [SELF, PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true, selector: FAST },
      { project: PROJECT, env: "staging", nodes: [SELF, PEER], self: true },
    ]);
  });

  it("keeps serving what the decision says once the selector is cleared", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);

    await setNodeSelector(registry, PROJECT, "prod", null);

    const state = await readDesired(registry, { nodeId: SELF });
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true },
    ]);
  });

  it("leaves the environments beside it entirely alone", async () => {
    await deployed(PROJECT, "staging");
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "staging", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["staging"]);
  });
});

describe("what is left out for reasons other than placement", () => {
  it("leaves out an environment without a deployment notice, squarely placed as it is", async () => {
    await createEnvironment(registry, PROJECT, { name: "fresh" });
    await writePlacement(registry, PROJECT, "fresh", [SELF], lease);
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements.map((view) => view.env)).toEqual(["fresh", "prod"]);
  });

  it("leaves out a RETIRED environment, however squarely it is placed here", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await retireEnvironment(registry, PROJECT, "prod");

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments).toEqual([]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true },
    ]);
  });

  it("takes it straight back the moment it is unretired", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await retireEnvironment(registry, PROJECT, "prod");
    expect((await readDesired(registry, { nodeId: SELF })).environments).toEqual([]);

    await unretireEnvironment(registry, PROJECT, "prod");

    const state = await readDesired(registry, { nodeId: SELF });
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.environments[0].env.deployment?.revision).toBe(1);
  });

  it("leaves a retired environment out on every node, not just this one", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF, PEER, "node-c"], lease);
    await retireEnvironment(registry, PROJECT, "prod");

    for (const nodeId of [SELF, PEER, "node-c"]) {
      expect((await readDesired(registry, { nodeId })).environments, nodeId).toEqual([]);
    }
  });

  it("keeps it out once the coordinator has dropped its placement record too", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF, PEER], lease);
    await retireEnvironment(registry, PROJECT, "prod");
    await deletePlacement(registry, PROJECT, "prod", lease);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId });
      expect(state.environments, nodeId).toEqual([]);
      expect(state.fleet, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("reads nothing at all out of an empty registry", async () => {
    const empty = ctxWith(new MemoryCasStore()).ctx;

    expect(await readDesired(empty, { nodeId: SELF })).toEqual({
      environments: [],
      fleet: [],
      placements: [],
    });
  });
});

describe("an old ephemeral environment", () => {
  it("remains desired indefinitely", async () => {
    await createEnvironment(registry, PROJECT, { name: PREVIEW, ephemeral: true });
    await recordRevision(registry, PROJECT, PREVIEW, VERSION);
    await writePlacement(registry, PROJECT, PREVIEW, [SELF], lease);
    clock.tick(365 * 24 * 60 * 60 * 1000);

    expect(await isDesired(PREVIEW)).toBe(true);
  });
});

describe("how a pass reads all of that", () => {
  it("overlaps the environments of a project, up to the bound and no further", async () => {
    const { ctx, observing } = await watchedInstallation();
    observing.reset();

    await readDesired(ctx, { nodeId: SELF });

    expect(observing.peakReads).toBeGreaterThan(1);
    expect(observing.peakReads).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("takes exactly the bound it is given, however many environments there are", async () => {
    const { ctx, observing } = await watchedInstallation();

    for (const concurrency of [1, 3]) {
      observing.reset();
      await readDesired(ctx, { nodeId: SELF, concurrency });
      expect(observing.peakReads, `bounded to ${String(concurrency)}`).toBe(concurrency);
    }
  });

  it("answers exactly what it answered one read at a time", async () => {
    const { ctx, observing, names } = await watchedInstallation();
    observing.delays.set(environmentKey(PROJECT, names[0]), 20);

    const overlapped = await readDesired(ctx, { nodeId: SELF });
    const sequential = await readDesired(ctx, {
      nodeId: SELF,
      concurrency: 1,
    });

    expect(overlapped).toEqual(sequential);
    expect(overlapped.environments.map((entry) => entry.env.name)).toEqual(names);
    expect(overlapped.placements.map((view) => view.env)).toEqual(names);
  });

  it("surfaces the failure of the FIRST environment, not of the first read to fail", async () => {
    const { ctx, observing, names } = await watchedInstallation();
    observing.delays.set(environmentKey(PROJECT, names[1]), 20);
    observing.faults.set(environmentKey(PROJECT, names[1]), new Error("the second"));
    observing.faults.set(environmentKey(PROJECT, names[5]), new Error("the sixth"));

    await expect(readDesired(ctx, { nodeId: SELF })).rejects.toThrow("the second");
    await expect(readDesired(ctx, { nodeId: SELF, concurrency: 1 })).rejects.toThrow("the second");
  });
});

/** An environment with a deployment notice, ready to be served. */
async function deployed(project: string, name: string): Promise<void> {
  await createEnvironment(registry, project, { name });
  await recordRevision(registry, project, name, VERSION);
}

/** Whether this node would run `name`. */
async function isDesired(name: string): Promise<boolean> {
  const state = await readDesired(registry, { nodeId: SELF });
  return state.environments.some((entry) => entry.env.name === name);
}

/**
 * One project of a dozen deployed and decided environments, over a store that
 * watches how its reads run.
 */
async function watchedInstallation(): Promise<{
  ctx: RegistryContext;
  observing: ObservingStore;
  names: string[];
}> {
  const observing = new ObservingStore(new MemoryCasStore());
  const { ctx } = ctxWith(observing);
  await createProject(ctx, { slug: PROJECT });
  await createDeployment(ctx, PROJECT, { version: VERSION });

  const taken = await acquireLease(ctx, SELF);
  if (taken === null) throw new Error("the fixture could not take the lease");

  const names = Array.from({ length: 12 }, (_, index) => `env-${String(index).padStart(2, "0")}`);
  for (const name of names) {
    await createEnvironment(ctx, PROJECT, { name });
    await recordRevision(ctx, PROJECT, name, VERSION);
    await writePlacement(ctx, PROJECT, name, [SELF], taken);
  }
  return { ctx, observing, names };
}
