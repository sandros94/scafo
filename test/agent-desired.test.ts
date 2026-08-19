/*
 * What one node reads out of the registry as its own work.
 *
 * The case that matters most here is the one that looks like an omission: an
 * environment nobody has placed yet is served by every node. That fallback is
 * what keeps a bootstrap, a single-node installation and a rolling upgrade
 * running, and it is asserted first.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readDesired } from "../src/agent/_desired.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  flipAlias,
  type LeaseHandle,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const PROJECT = "shop";
const OTHER_PROJECT = "blog";
const BUILD = "b1b1b1b1";
const SELF = "node-a";
const PEER = "node-b";

let registry: RegistryContext;
let lease: LeaseHandle;

beforeEach(async () => {
  const clock = ctxWith(new MemoryCasStore());
  registry = clock.ctx;

  for (const project of [PROJECT, OTHER_PROJECT]) {
    await createProject(registry, { slug: project });
    await createBuild(registry, project, { id: BUILD, runtimeConfigurable: true });
  }
  await deployed(PROJECT, "prod");

  const acquired = await acquireLease(registry, SELF);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("an environment nobody has placed", () => {
  it("is served here, because no coordinator has decided anything yet", async () => {
    /*
     * THE FALLBACK THE WHOLE FEATURE HANGS FROM. A missing placement record is
     * the ordinary state of a bootstrap, of a single-node installation, and of
     * every node running a build that predates placement. Reading it as "not
     * mine" would take an installation off the air the first time it upgraded.
     */
    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    /* And it is reported as undecided rather than as placed on nobody. */
    expect(state.placements).toEqual([]);
  });

  it("is served by every node at once, which is what it did before placement existed", async () => {
    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId });
      expect(state.environments, nodeId).toHaveLength(1);
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

    /* The environment drops out of this node's desired state, which is what
       makes the reconcile loop stop whatever it still runs for it. The nodes
       named pick it up on their own passes. */
    expect(state.environments).toEqual([]);
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
    /* A record no coordinator will ever write — it refuses an empty fleet — but
       one that must be obeyed rather than second-guessed if it appears. */
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

describe("what is left out for reasons other than placement", () => {
  it("leaves out an environment whose alias was never flipped, placed or not", async () => {
    await createEnvironment(registry, PROJECT, { name: "fresh" });
    await writePlacement(registry, PROJECT, "fresh", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    /* "prod" is undecided and served here by the fallback; "fresh" is decided
       ONTO this node and still contributes nothing, because it has no build. */
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements.map((view) => view.env)).toEqual(["fresh"]);
  });

  it("reads nothing at all out of an empty registry", async () => {
    const empty = ctxWith(new MemoryCasStore()).ctx;

    expect(await readDesired(empty, { nodeId: SELF })).toEqual({
      environments: [],
      placements: [],
    });
  });
});

/** An environment with a build its alias points at, ready to be served. */
async function deployed(project: string, name: string): Promise<void> {
  await createEnvironment(registry, project, { name });
  await flipAlias(registry, project, name, BUILD);
}
