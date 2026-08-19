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
  buildKey,
  createBuild,
  createEnvironment,
  createProject,
  deleteKey,
  deletePlacement,
  flipAlias,
  type LeaseHandle,
  retireEnvironment,
  setNodeSelector,
  setSplit,
  unretireEnvironment,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith } from "./_helpers.ts";

const PROJECT = "shop";
const OTHER_PROJECT = "blog";
const BUILD = "b1b1b1b1";
const OTHER_BUILD = "b2b2b2b2";
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

describe("an environment that carries a node selector", () => {
  const FAST = { tier: "fast" };

  it("is NOT served anywhere while no coordinator has placed it", async () => {
    /*
     * THE ASYMMETRY, and the whole reason this is not the fallback above. A
     * selector is an explicit constraint — the operator has said which nodes may
     * run this — while the run-everywhere fallback exists to preserve behaviour
     * nobody ever stated. Serving it here before the coordinator has decided
     * would break exactly what was asked for, on the widest possible set of
     * nodes: every one of them, including all the ones the selector excludes.
     */
    await setNodeSelector(registry, PROJECT, "prod", FAST);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId });
      expect(state.environments, nodeId).toEqual([]);
      /* And it is reported as undecided rather than as placed on nobody: there
         is no decision to report, which is the state it is waiting out. */
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("is served the moment a decision names this node, selector and all", async () => {
    /*
     * The record WINS over both rules. Which nodes satisfy a selector is the
     * coordinator's judgement, made over the labels of the whole fleet at once,
     * and a node that re-decided it locally would fight the only writer there
     * is — including through every window in which the two disagree.
     */
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
    /* A decision naming one node reads very differently once it is clear the
       environment asked for exactly one kind of node. */
    await deployed(PROJECT, "staging");
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await writePlacement(registry, PROJECT, "staging", [SELF, PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true, selector: FAST },
      /* No selector, no field: an unconstrained environment says nothing here. */
      { project: PROJECT, env: "staging", nodes: [SELF, PEER], self: true },
    ]);
  });

  it("goes back to being served everywhere the moment the selector is cleared", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    expect((await readDesired(registry, { nodeId: SELF })).environments).toEqual([]);

    await setNodeSelector(registry, PROJECT, "prod", null);

    /* Undecided AND unconstrained is the fallback's case again, so the node
       takes it straight back rather than waiting for a coordinator. */
    for (const nodeId of [SELF, PEER]) {
      const state = await readDesired(registry, { nodeId });
      expect(
        state.environments.map((entry) => entry.env.name),
        nodeId,
      ).toEqual(["prod"]);
    }
  });

  it("leaves the environments beside it entirely alone", async () => {
    await deployed(PROJECT, "staging");
    await setNodeSelector(registry, PROJECT, "prod", FAST);

    const state = await readDesired(registry, { nodeId: SELF });

    /* One constrained environment waiting on a coordinator must not hold up the
       unconstrained ones this node is already meant to be serving. */
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["staging"]);
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

  it("leaves out a RETIRED environment, however squarely it is placed here", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await retireEnvironment(registry, PROJECT, "prod");

    const state = await readDesired(registry, { nodeId: SELF });

    /*
     * It leaves by the same door a reassignment uses: it drops out of the
     * desired state, the next pass stops whatever runs for it, and because the
     * routing is rendered from what this node actually runs, its hosts stop
     * resolving with its processes. Nothing in the route renderer knows what
     * retirement is.
     */
    expect(state.environments).toEqual([]);
    /* The decision is still reported as long as the record is there — the
       coordinator drops it on its next pass, and this is the truth until then. */
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true },
    ]);
  });

  it("takes it straight back the moment it is unretired", async () => {
    await retireEnvironment(registry, PROJECT, "prod");
    expect((await readDesired(registry, { nodeId: SELF })).environments).toEqual([]);

    await unretireEnvironment(registry, PROJECT, "prod");

    /* Reversibility, seen from the node: nothing was taken away from the
       environment, so nothing has to be rebuilt to serve it again. */
    const state = await readDesired(registry, { nodeId: SELF });
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.environments[0].builds.map((leg) => leg.build.id)).toEqual([BUILD]);
  });

  it("leaves a retired environment out on every node, not just this one", async () => {
    await retireEnvironment(registry, PROJECT, "prod");

    for (const nodeId of [SELF, PEER, "node-c"]) {
      expect((await readDesired(registry, { nodeId })).environments, nodeId).toEqual([]);
    }
  });

  it("keeps it out once the coordinator has dropped its placement record too", async () => {
    /*
     * The state a retired environment actually settles in, and the one that
     * reads backwards: the coordinator DELETES the placement of an environment
     * nothing should serve, and a missing placement record is the fallback that
     * means "served everywhere". The two together would start a retired
     * environment on every node in the installation if the retirement check
     * were not what decides this.
     */
    await writePlacement(registry, PROJECT, "prod", [SELF, PEER], lease);
    await retireEnvironment(registry, PROJECT, "prod");
    await deletePlacement(registry, PROJECT, "prod", lease);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId });
      expect(state.environments, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("reads nothing at all out of an empty registry", async () => {
    const empty = ctxWith(new MemoryCasStore()).ctx;

    expect(await readDesired(empty, { nodeId: SELF })).toEqual({
      environments: [],
      placements: [],
      failures: [],
    });
  });
});

describe("an environment whose traffic is split", () => {
  beforeEach(async () => {
    await createBuild(registry, PROJECT, { id: OTHER_BUILD, runtimeConfigurable: true });
  });

  it("resolves the alias first, then the legs in the order the registry states them", async () => {
    await setSplit(registry, PROJECT, "prod", [
      { build: OTHER_BUILD, weight: 90 },
      { build: BUILD, weight: 10 },
    ]);

    const state = await readDesired(registry, { nodeId: SELF });

    /* Alias FIRST, whatever the split says, because the alias is the primary
       pointer whether or not it is also a leg — and then the split in its own
       order, so two nodes plan the same rollouts in the same sequence. */
    expect(state.environments[0].builds).toEqual([
      { build: expect.objectContaining({ id: BUILD }), role: "alias" },
      { build: expect.objectContaining({ id: OTHER_BUILD }), role: "split" },
    ]);
    expect(state.failures).toEqual([]);
  });

  it("counts a leg that names the alias once", async () => {
    await setSplit(registry, PROJECT, "prod", [
      { build: BUILD, weight: 50 },
      { build: OTHER_BUILD, weight: 50 },
    ]);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments[0].builds.map((leg) => leg.build.id)).toEqual([BUILD, OTHER_BUILD]);
    expect(state.environments[0].builds[0].role).toBe("alias");
  });

  it("keeps the environment and records the leg whose build is gone", async () => {
    /*
     * A corrupted or raced registry — the reaper refuses to delete a build any
     * split references — and the reading that matters is what does NOT happen:
     * the environment stays desired, so nothing it runs is planned for a stop.
     * Dropping the leg silently would retire the process still serving it and
     * hand its share of the traffic to the other legs.
     */
    await setSplit(registry, PROJECT, "prod", [
      { build: BUILD, weight: 90 },
      { build: OTHER_BUILD, weight: 10 },
    ]);
    await deleteKey(registry, buildKey(PROJECT, OTHER_BUILD));

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.environments[0].builds.map((leg) => leg.build.id)).toEqual([BUILD]);
    expect(state.environments[0].unresolved).toEqual([OTHER_BUILD]);
    expect(state.failures).toEqual([
      { subject: `${PROJECT}/prod`, detail: expect.stringContaining(OTHER_BUILD) },
    ]);
  });

  it("says nothing about unresolved legs when every one of them resolved", async () => {
    await setSplit(registry, PROJECT, "prod", [
      { build: BUILD, weight: 90 },
      { build: OTHER_BUILD, weight: 10 },
    ]);

    const state = await readDesired(registry, { nodeId: SELF });

    /* No field rather than an empty one: an environment with nothing missing
       says nothing here, exactly as an unconstrained one says no selector. */
    expect(state.environments[0].unresolved).toBeUndefined();
  });

  it("goes back to the alias alone the moment the split is cleared", async () => {
    await setSplit(registry, PROJECT, "prod", [
      { build: BUILD, weight: 50 },
      { build: OTHER_BUILD, weight: 50 },
    ]);
    await setSplit(registry, PROJECT, "prod", null);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments[0].builds.map((leg) => leg.build.id)).toEqual([BUILD]);
  });

  it("leaves a retired environment out, split or no split", async () => {
    await setSplit(registry, PROJECT, "prod", [
      { build: BUILD, weight: 50 },
      { build: OTHER_BUILD, weight: 50 },
    ]);
    await retireEnvironment(registry, PROJECT, "prod");

    expect((await readDesired(registry, { nodeId: SELF })).environments).toEqual([]);
  });
});

/** An environment with a build its alias points at, ready to be served. */
async function deployed(project: string, name: string): Promise<void> {
  await createEnvironment(registry, project, { name });
  await flipAlias(registry, project, name, BUILD);
}
