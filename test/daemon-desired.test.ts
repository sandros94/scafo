/*
 * What one node reads out of the registry as its own work.
 *
 * The case that matters most here is the one that looks like an omission: an
 * environment nobody has placed yet is served by every node. That fallback is
 * what keeps a bootstrap, a single-node installation and a rolling upgrade
 * running, and it is asserted first.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { type DesiredState, readDesired } from "../src/daemon/_desired.ts";
import {
  acquireLease,
  buildKey,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_BUILD_IDLE_S,
  DEFAULT_EPHEMERAL_PARK_AFTER_S,
  deleteKey,
  deletePlacement,
  environmentKey,
  flipAlias,
  type LeaseHandle,
  putJson,
  readJson,
  retireEnvironment,
  setNodeSelector,
  setParkPolicy,
  setSplit,
  stampBuildWake,
  stampEnvironmentWake,
  unretireEnvironment,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import type { EnvironmentRecord } from "../src/core/types/registry.ts";
import { DEFAULT_CONCURRENCY } from "../src/core/utils/concurrency.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, ObservingStore } from "./_helpers.ts";

const PROJECT = "shop";
const OTHER_PROJECT = "blog";
const BUILD = "b1b1b1b1";
const OTHER_BUILD = "b2b2b2b2";
/** A third build, so a wake has something to recall that is nobody's leg. */
const THIRD_BUILD = "b3b3b3b3";
const SELF = "node-a";
const PEER = "node-b";
const PREVIEW = "preview";
const HOUR_MS = 3_600_000;
/** How long an ephemeral environment runs past its last wake, by default. */
const PARK_AFTER_MS = DEFAULT_EPHEMERAL_PARK_AFTER_S * 1000;
/** How long a recalled build runs past ITS last wake, by default. */
const BUILD_IDLE_MS = DEFAULT_BUILD_IDLE_S * 1000;

let clock: ManualClock;
let registry: RegistryContext;
let lease: LeaseHandle;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
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
      parked: [],
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

describe("an ephemeral environment that has gone quiet", () => {
  beforeEach(async () => {
    for (const id of [OTHER_BUILD, THIRD_BUILD]) {
      await createBuild(registry, PROJECT, { id, runtimeConfigurable: true });
    }
  });

  it("is served exactly as it always was while its wake is fresh", async () => {
    await parkable(PREVIEW);
    await stampEnvironmentWake(registry, PROJECT, PREVIEW);
    clock.tick(PARK_AFTER_MS - 1);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual([PREVIEW, "prod"]);
    expect(state.parked).toEqual([]);
  });

  it("parks once nothing has woken it for as long as its policy allows", async () => {
    await parkable(PREVIEW);
    await setSplit(registry, PROJECT, PREVIEW, [
      { build: BUILD, weight: 90 },
      { build: OTHER_BUILD, weight: 10 },
    ]);
    await stampEnvironmentWake(registry, PROJECT, PREVIEW);
    clock.tick(PARK_AFTER_MS);

    const state = await readDesired(registry, { nodeId: SELF });

    /*
     * Its alias AND every leg of its split go together: parking is about the
     * environment, not about one pointer. The next pass stops them, and because
     * the routing is rendered from what this node actually runs, its own hosts
     * stop resolving with them.
     */
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    /* Reported rather than merely left out: an environment nothing runs for
       because it was never deployed looks exactly like one waiting to be woken,
       and only one of them is answered by sending it a request. */
    expect(parkedNames(state)).toEqual([{ project: PROJECT, env: PREVIEW }]);
    expect(state.failures).toEqual([]);
  });

  it("counts the wait from the alias flip when nothing has ever stamped it", async () => {
    await createEnvironment(registry, PROJECT, { name: PREVIEW, ephemeral: true });
    clock.tick(PARK_AFTER_MS);
    await flipAlias(registry, PROJECT, PREVIEW, BUILD);

    /* Created long ago, deployed a moment ago. An environment that predates
       wake stamps must not read as parked the instant a node that knows about
       parking picks it up. */
    expect((await readDesired(registry, { nodeId: SELF })).parked).toEqual([]);

    clock.tick(PARK_AFTER_MS);
    expect(parkedNames(await readDesired(registry, { nodeId: SELF }))).toEqual([
      { project: PROJECT, env: PREVIEW },
    ]);
  });

  it("counts the wait from its creation when it has neither a stamp nor a flip", async () => {
    /* The only case in which the creation is the base, and it is observable in
       one place: nothing of the environment's own is served either way, so what
       the base decides is whether a build somebody woke may run at its own host. */
    await createEnvironment(registry, PROJECT, { name: PREVIEW, ephemeral: true });
    clock.tick(PARK_AFTER_MS);
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(await legsOf(PREVIEW)).toEqual([{ id: THIRD_BUILD, role: "recalled" }]);
    /* And it is NOT called parked: an environment whose alias was never flipped
       serves nothing either way, and calling it parked would promise an operator
       that a request wakes something. */
    expect(state.parked).toEqual([]);
  });

  it("recalls a build woken while it is still inside its own window", async () => {
    /* Whether a build wake is honoured does not depend on the environment
       around it: here the environment is AWAKE (a deploy just stamped it) and
       has never flipped, and the woken build runs at its own host anyway. */
    await createEnvironment(registry, PROJECT, { name: PREVIEW, ephemeral: true });
    await stampEnvironmentWake(registry, PROJECT, PREVIEW);
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);

    expect(await legsOf(PREVIEW)).toEqual([{ id: THIRD_BUILD, role: "recalled" }]);
  });

  it("keeps it awake when the timestamp it would count from cannot be read", async () => {
    /* Nothing here should stop an application over a timestamp it could not
       parse: a damaged record is not evidence that anything has gone quiet. */
    await parkable(PREVIEW);
    await damageFlip(PREVIEW);
    clock.tick(PARK_AFTER_MS * 100);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual([PREVIEW, "prod"]);
    expect(state.parked).toEqual([]);
  });

  it("never parks one whose window is 0, which is how a preview is kept warm", async () => {
    await parkable(PREVIEW);
    await setParkPolicy(registry, PROJECT, PREVIEW, { afterS: 0 });
    clock.tick(PARK_AFTER_MS * 100);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(await legsOf(PREVIEW)).toEqual([{ id: BUILD, role: "alias" }]);
    expect(state.parked).toEqual([]);
  });

  it("leaves a LONG-LIVED environment alone, whatever window its record carries", async () => {
    /*
     * The belt in `resolveParkPolicy`, seen from the node. A long-lived
     * environment serves live traffic no wake stamp reflects — a stamp is
     * written when something is woken, and a warm environment is never woken —
     * so a record some other writer gave a window to must not take it off the
     * air on a clock.
     */
    await writeRecord("prod", { park: { afterS: 60 } });
    await stampEnvironmentWake(registry, PROJECT, "prod");
    clock.tick(HOUR_MS);

    const state = await readDesired(registry, { nodeId: SELF });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.parked).toEqual([]);
  });

  it("serves a parked environment's recalled build alone, and still calls it parked", async () => {
    await parkable(PREVIEW);
    await stampEnvironmentWake(registry, PROJECT, PREVIEW);
    clock.tick(PARK_AFTER_MS);
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);

    const state = await readDesired(registry, { nodeId: SELF });

    /* Its own hosts stay unserved — that is what parked means — while the one
       host somebody actually asked for comes back. Parked and desired at once,
       which is why the report is not simply "absent from desired state". */
    expect(await legsOf(PREVIEW)).toEqual([{ id: THIRD_BUILD, role: "recalled" }]);
    expect(parkedNames(state)).toEqual([{ project: PROJECT, env: PREVIEW }]);
  });
});

describe("the builds a wake has recalled", () => {
  /* Nothing ticks in this block unless a test says so, so every environment
     here is comfortably inside its own window: what is under test is the
     BUILD's clock, not the environment's. */
  beforeEach(async () => {
    for (const id of [OTHER_BUILD, THIRD_BUILD]) {
      await createBuild(registry, PROJECT, { id, runtimeConfigurable: true });
    }
    await parkable(PREVIEW);
  });

  it("appends a woken build AFTER the alias and every leg of the split", async () => {
    await setSplit(registry, PROJECT, PREVIEW, [
      { build: BUILD, weight: 90 },
      { build: OTHER_BUILD, weight: 10 },
    ]);
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);

    /* Last on purpose: a recalled build serves the one caller that asked for its
       own host, while the alias and the legs carry the environment's traffic,
       and the planner rolls a build out in the order it is given. */
    expect(await legsOf(PREVIEW)).toEqual([
      { id: BUILD, role: "alias" },
      { id: OTHER_BUILD, role: "split" },
      { id: THIRD_BUILD, role: "recalled" },
    ]);
  });

  it("leaves out a build whose own wake has gone stale", async () => {
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);
    clock.tick(BUILD_IDLE_MS);

    expect(await legsOf(PREVIEW)).toEqual([{ id: BUILD, role: "alias" }]);
  });

  it("drops a stamp naming a build the registry no longer has, reporting nothing", async () => {
    /*
     * A build the reaper has taken is a permanent 404 by design — the bucket is
     * the source of truth and nothing brings the record back — so there is
     * nothing an operator could act on. Recording it as an unresolved leg
     * instead would count it as unproven and hold back every stop this
     * environment ever plans, forever.
     */
    await stampBuildWake(registry, PROJECT, PREVIEW, "deadbeef");

    const state = await readDesired(registry, { nodeId: SELF });
    const wanted = state.environments.find((entry) => entry.env.name === PREVIEW);

    expect(await legsOf(PREVIEW)).toEqual([{ id: BUILD, role: "alias" }]);
    expect(wanted?.unresolved).toBeUndefined();
    expect(state.failures).toEqual([]);
  });

  it("never runs a build twice because a wake named a leg it already has", async () => {
    await setSplit(registry, PROJECT, PREVIEW, [
      { build: BUILD, weight: 90 },
      { build: OTHER_BUILD, weight: 10 },
    ]);
    for (const id of [BUILD, OTHER_BUILD]) {
      await stampBuildWake(registry, PROJECT, PREVIEW, id);
    }

    /* One build is one process, whichever of the three roles put it there. */
    expect(await legsOf(PREVIEW)).toEqual([
      { id: BUILD, role: "alias" },
      { id: OTHER_BUILD, role: "split" },
    ]);
  });

  it("adds nothing at all to an environment that does not recall builds", async () => {
    await setParkPolicy(registry, PROJECT, PREVIEW, { recallBuilds: false });
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);

    expect(await legsOf(PREVIEW)).toEqual([{ id: BUILD, role: "alias" }]);
  });

  it("adds nothing when a woken build is given no time to run at all", async () => {
    await setParkPolicy(registry, PROJECT, PREVIEW, { buildIdleS: 0 });
    await stampBuildWake(registry, PROJECT, PREVIEW, THIRD_BUILD);

    expect(await legsOf(PREVIEW)).toEqual([{ id: BUILD, role: "alias" }]);
  });

  it("recalls one for a LONG-LIVED environment too, which never parks", async () => {
    /* Only the clock is refused a long-lived environment. Waking a superseded
       build at its own host is a request answering itself, and works on any
       environment there is. */
    await stampBuildWake(registry, PROJECT, "prod", THIRD_BUILD);

    expect(await legsOf("prod")).toEqual([
      { id: BUILD, role: "alias" },
      { id: THIRD_BUILD, role: "recalled" },
    ]);
  });
});

describe("how a pass reads all of that", () => {
  /*
   * A pass is a read per environment plus the reads that resolve it, and on a
   * hundred-millisecond store one after another that is seconds in front of
   * every wake and every rollout. What is asserted here is that overlapping
   * them changes the LATENCY and nothing else: the same answer, in the same
   * order, with the same failure — and never more of the store at once than the
   * node said it would take.
   */
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
    /* The first environment of the listing answers LAST, so a state assembled
       as the reads came back would be in another order than the one below. */
    observing.delays.set(environmentKey(PROJECT, names[0]), 20);

    const overlapped = await readDesired(ctx, { nodeId: SELF });
    const sequential = await readDesired(ctx, { nodeId: SELF, concurrency: 1 });

    expect(overlapped).toEqual(sequential);
    expect(overlapped.environments.map((entry) => entry.env.name)).toEqual(names);
    expect(overlapped.placements.map((view) => view.env)).toEqual(names);
  });

  it("surfaces the failure of the FIRST environment, not of the first read to fail", async () => {
    const { ctx, observing, names } = await watchedInstallation();
    /* The later one fails at once and the earlier one takes its time, so the
       failure that settles first is not the one a sequential pass would hit. */
    observing.delays.set(environmentKey(PROJECT, names[1]), 20);
    observing.faults.set(environmentKey(PROJECT, names[1]), new Error("the second"));
    observing.faults.set(environmentKey(PROJECT, names[5]), new Error("the sixth"));

    await expect(readDesired(ctx, { nodeId: SELF })).rejects.toThrow("the second");
    /* And it is the same failure the pass raised before any of this overlapped. */
    await expect(readDesired(ctx, { nodeId: SELF, concurrency: 1 })).rejects.toThrow("the second");
  });
});

/** An environment with a build its alias points at, ready to be served. */
async function deployed(project: string, name: string): Promise<void> {
  await createEnvironment(registry, project, { name });
  await flipAlias(registry, project, name, BUILD);
}

/** The same, ephemeral: the only kind of environment that parks on a clock. */
async function parkable(name: string): Promise<void> {
  await createEnvironment(registry, PROJECT, { name, ephemeral: true });
  await flipAlias(registry, PROJECT, name, BUILD);
}

/** The parked environments by name; the state carries their whole records. */
function parkedNames(state: DesiredState): Array<{ project: string; env: string }> {
  return state.parked.map((entry) => ({ project: entry.project, env: entry.env.name }));
}

/** The builds this node would run for `name`, in the order it would roll them out. */
async function legsOf(name: string): Promise<Array<{ id: string; role: string }>> {
  const state = await readDesired(registry, { nodeId: SELF });
  const wanted = state.environments.find((entry) => entry.env.name === name);
  return (wanted?.builds ?? []).map((leg) => ({ id: leg.build.id, role: leg.role }));
}

/** Rewrites an environment record in the bucket, as another writer would leave it. */
async function writeRecord(name: string, patch: Partial<EnvironmentRecord>): Promise<void> {
  const key = environmentKey(PROJECT, name);
  const current = await readJson<EnvironmentRecord>(registry, key);
  await putJson<EnvironmentRecord>(registry, key, {
    ...(current?.value as EnvironmentRecord),
    ...patch,
  });
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
  await createBuild(ctx, PROJECT, { id: BUILD, runtimeConfigurable: true });

  const taken = await acquireLease(ctx, SELF);
  if (taken === null) throw new Error("the fixture could not take the lease");

  const names = Array.from({ length: 12 }, (_, index) => `env-${String(index).padStart(2, "0")}`);
  for (const name of names) {
    await createEnvironment(ctx, PROJECT, { name });
    await flipAlias(ctx, PROJECT, name, BUILD);
    await writePlacement(ctx, PROJECT, name, [SELF], taken);
  }
  return { ctx, observing, names };
}

/** Leaves the environment with an alias flip nothing can read as a time. */
async function damageFlip(name: string): Promise<void> {
  const current = await readJson<EnvironmentRecord>(registry, environmentKey(PROJECT, name));
  const alias = current?.value.alias;
  await writeRecord(name, {
    alias: { ...(alias as NonNullable<typeof alias>), flippedAt: "whenever" },
  });
}
