/*
 * What one node reads out of the registry as its own work.
 *
 * Missing placement is an explicit compatibility choice: production requires a
 * decision and starts nothing, while the legacy reader retains the old
 * unconstrained fallback for rolling upgrades. Both contracts are asserted
 * first so no caller can select one by omission.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { type DesiredState, readDesired } from "../src/daemon/_desired.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_EPHEMERAL_PARK_AFTER_S,
  deletePlacement,
  environmentKey,
  type LeaseHandle,
  putJson,
  readJson,
  retireEnvironment,
  setNodeSelector,
  setParkPolicy,
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
const SELF = "node-a";
const PEER = "node-b";
const PREVIEW = "preview";
const HOUR_MS = 3_600_000;
/** How long an ephemeral environment runs past its last wake, by default. */
const PARK_AFTER_MS = DEFAULT_EPHEMERAL_PARK_AFTER_S * 1000;

let clock: ManualClock;
let registry: RegistryContext;
let lease: LeaseHandle;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  registry = clock.ctx;

  for (const project of [PROJECT, OTHER_PROJECT]) {
    await createProject(registry, { slug: project });
    await createBuild(registry, project, { id: BUILD });
  }
  await deployed(PROJECT, "prod");

  const acquired = await acquireLease(registry, SELF);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("an environment nobody has placed", () => {
  it("is not served by a credit-capable daemon until placement is explicit", async () => {
    const state = await readDesired(registry, { nodeId: SELF, mode: "required" });

    expect(state.environments).toEqual([]);
    expect(state.placements).toEqual([]);
  });

  it("is served only when the caller explicitly selects legacy fallback", async () => {
    /*
     * The compatibility seam for a daemon that predates required placement.
     * Production never selects this mode; an explicit rolling-upgrade reader
     * retains the former unconstrained behaviour until it is replaced.
     */
    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    /* And it is reported as undecided rather than as placed on nobody. */
    expect(state.placements).toEqual([]);
  });

  it("is served by every node at once, which is what it did before placement existed", async () => {
    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId, mode: "legacy-fallback" });
      expect(state.environments, nodeId).toHaveLength(1);
    }
  });
});

describe("an environment that has been placed", () => {
  it("is served here when the decision names this node", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF, PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF, PEER], self: true },
    ]);
  });

  it("is NOT served here when the decision names other nodes", async () => {
    await writePlacement(registry, PROJECT, "prod", [PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

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

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

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

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments).toEqual([]);
    expect(state.placements[0]).toMatchObject({ nodes: [], self: false });
  });

  it("filters each project on its own", async () => {
    await deployed(OTHER_PROJECT, "prod");
    await writePlacement(registry, PROJECT, "prod", [PEER], lease);
    await writePlacement(registry, OTHER_PROJECT, "prod", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

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
      const state = await readDesired(registry, { nodeId, mode: "legacy-fallback" });
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

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true, selector: FAST },
    ]);
  });

  it("is left out again when the decision names other nodes", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    await writePlacement(registry, PROJECT, "prod", [PEER], lease);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

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

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.placements).toEqual([
      { project: PROJECT, env: "prod", nodes: [SELF], self: true, selector: FAST },
      /* No selector, no field: an unconstrained environment says nothing here. */
      { project: PROJECT, env: "staging", nodes: [SELF, PEER], self: true },
    ]);
  });

  it("returns to the legacy run-everywhere fallback when the selector is cleared", async () => {
    await setNodeSelector(registry, PROJECT, "prod", FAST);
    expect(
      (await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" })).environments,
    ).toEqual([]);

    await setNodeSelector(registry, PROJECT, "prod", null);

    /* Undecided AND unconstrained is the fallback's case again, so the node
       takes it straight back rather than waiting for a coordinator. */
    for (const nodeId of [SELF, PEER]) {
      const state = await readDesired(registry, { nodeId, mode: "legacy-fallback" });
      expect(
        state.environments.map((entry) => entry.env.name),
        nodeId,
      ).toEqual(["prod"]);
    }
  });

  it("leaves the environments beside it entirely alone", async () => {
    await deployed(PROJECT, "staging");
    await setNodeSelector(registry, PROJECT, "prod", FAST);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    /* One constrained environment waiting on a coordinator must not hold up the
       unconstrained ones this node is already meant to be serving. */
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["staging"]);
  });
});

describe("what is left out for reasons other than placement", () => {
  it("leaves out an environment without a deployment notice, placed or not", async () => {
    await createEnvironment(registry, PROJECT, { name: "fresh" });
    await writePlacement(registry, PROJECT, "fresh", [SELF], lease);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    /* "prod" is undecided and served here by the fallback; "fresh" is decided
       ONTO this node and still contributes nothing, because it has no build. */
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.placements.map((view) => view.env)).toEqual(["fresh"]);
  });

  it("leaves out a RETIRED environment, however squarely it is placed here", async () => {
    await writePlacement(registry, PROJECT, "prod", [SELF], lease);
    await retireEnvironment(registry, PROJECT, "prod");

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

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
    expect(
      (await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" })).environments,
    ).toEqual([]);

    await unretireEnvironment(registry, PROJECT, "prod");

    /* Reversibility, seen from the node: nothing was taken away from the
       environment, so nothing has to be rebuilt to serve it again. */
    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });
    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.environments[0].env.deployment?.revision).toBe(1);
  });

  it("leaves a retired environment out on every node, not just this one", async () => {
    await retireEnvironment(registry, PROJECT, "prod");

    for (const nodeId of [SELF, PEER, "node-c"]) {
      expect(
        (await readDesired(registry, { nodeId, mode: "legacy-fallback" })).environments,
        nodeId,
      ).toEqual([]);
    }
  });

  it("keeps it out once the coordinator has dropped its placement record too", async () => {
    /*
     * The state a retired environment actually settles in, and the one that
     * reads backwards for this explicit LEGACY reader: the coordinator DELETES
     * the placement of an environment nothing should serve, and legacy fallback
     * treats that absence as unconstrained. The retirement check must still win.
     */
    await writePlacement(registry, PROJECT, "prod", [SELF, PEER], lease);
    await retireEnvironment(registry, PROJECT, "prod");
    await deletePlacement(registry, PROJECT, "prod", lease);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await readDesired(registry, { nodeId, mode: "legacy-fallback" });
      expect(state.environments, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("reads nothing at all out of an empty registry", async () => {
    const empty = ctxWith(new MemoryCasStore()).ctx;

    expect(await readDesired(empty, { nodeId: SELF, mode: "legacy-fallback" })).toEqual({
      environments: [],
      placements: [],
      parked: [],
      failures: [],
    });
  });
});

describe("an ephemeral environment that has gone quiet", () => {
  it("is served exactly as it always was while its wake is fresh", async () => {
    await parkable(PREVIEW);
    await stampEnvironmentWake(registry, PROJECT, PREVIEW);
    clock.tick(PARK_AFTER_MS - 1);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments.map((entry) => entry.env.name)).toEqual([PREVIEW, "prod"]);
    expect(state.parked).toEqual([]);
  });

  it("parks once nothing has woken it for as long as its policy allows", async () => {
    await parkable(PREVIEW);
    await stampEnvironmentWake(registry, PROJECT, PREVIEW);
    clock.tick(PARK_AFTER_MS);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    /*
     * Its runtime stops with the environment. The next pass stops it, and because
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

  it("does not let a deployment reset an environment's activity clock", async () => {
    await createEnvironment(registry, PROJECT, { name: PREVIEW, ephemeral: true });
    clock.tick(PARK_AFTER_MS);
    await recordDeployment(registry, PROJECT, PREVIEW, BUILD);

    /* Created long ago, deployed a moment ago. An environment that predates
       wake stamps must not read as parked the instant a node that knows about
       parking picks it up. */
    expect(
      parkedNames(await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" })),
    ).toEqual([{ project: PROJECT, env: PREVIEW }]);

    clock.tick(PARK_AFTER_MS);
    expect(
      parkedNames(await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" })),
    ).toEqual([{ project: PROJECT, env: PREVIEW }]);
  });

  it("counts the wait from its creation when it has neither a stamp nor a deployment", async () => {
    /* Nothing of an environment without a deployment notice is served. */
    await createEnvironment(registry, PROJECT, { name: PREVIEW, ephemeral: true });
    clock.tick(PARK_AFTER_MS);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.parked).toEqual([]);
  });

  it("refuses a malformed deployment marker", async () => {
    await parkable(PREVIEW);
    await damageCurrentTimestamp(PREVIEW);
    clock.tick(PARK_AFTER_MS * 100);

    await expect(
      readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("never parks one whose window is 0, which is how a preview is kept warm", async () => {
    await parkable(PREVIEW);
    await setParkPolicy(registry, PROJECT, PREVIEW, { afterS: 0 });
    clock.tick(PARK_AFTER_MS * 100);

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(await isDesired(PREVIEW)).toBe(true);
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

    const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });

    expect(state.environments.map((entry) => entry.env.name)).toEqual(["prod"]);
    expect(state.parked).toEqual([]);
  });
});

describe("how a pass reads all of that", () => {
  /*
   * A pass is a read per environment plus the reads that resolve it, and on a
   * hundred-millisecond store one after another that is seconds in front of
   * every wake and every runtime start. What is asserted here is that overlapping
   * them changes the LATENCY and nothing else: the same answer, in the same
   * order, with the same failure — and never more of the store at once than the
   * node said it would take.
   */
  it("overlaps the environments of a project, up to the bound and no further", async () => {
    const { ctx, observing } = await watchedInstallation();
    observing.reset();

    await readDesired(ctx, { nodeId: SELF, mode: "legacy-fallback" });

    expect(observing.peakReads).toBeGreaterThan(1);
    expect(observing.peakReads).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("takes exactly the bound it is given, however many environments there are", async () => {
    const { ctx, observing } = await watchedInstallation();

    for (const concurrency of [1, 3]) {
      observing.reset();
      await readDesired(ctx, { nodeId: SELF, mode: "legacy-fallback", concurrency });
      expect(observing.peakReads, `bounded to ${String(concurrency)}`).toBe(concurrency);
    }
  });

  it("answers exactly what it answered one read at a time", async () => {
    const { ctx, observing, names } = await watchedInstallation();
    /* The first environment of the listing answers LAST, so a state assembled
       as the reads came back would be in another order than the one below. */
    observing.delays.set(environmentKey(PROJECT, names[0]), 20);

    const overlapped = await readDesired(ctx, { nodeId: SELF, mode: "legacy-fallback" });
    const sequential = await readDesired(ctx, {
      nodeId: SELF,
      mode: "legacy-fallback",
      concurrency: 1,
    });

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

    await expect(readDesired(ctx, { nodeId: SELF, mode: "legacy-fallback" })).rejects.toThrow(
      "the second",
    );
    /* And it is the same failure the pass raised before any of this overlapped. */
    await expect(
      readDesired(ctx, { nodeId: SELF, mode: "legacy-fallback", concurrency: 1 }),
    ).rejects.toThrow("the second");
  });
});

/** An environment with a deployment notice, ready to be served. */
async function deployed(project: string, name: string): Promise<void> {
  await createEnvironment(registry, project, { name });
  await recordDeployment(registry, project, name, BUILD);
}

/** The same, ephemeral: the only kind of environment that parks on a clock. */
async function parkable(name: string): Promise<void> {
  await createEnvironment(registry, PROJECT, { name, ephemeral: true });
  await recordDeployment(registry, PROJECT, name, BUILD);
}

/** The parked environments by name; the state carries their whole records. */
function parkedNames(state: DesiredState): Array<{ project: string; env: string }> {
  return state.parked.map((entry) => ({ project: entry.project, env: entry.env.name }));
}

/** Whether this node would run `name`. */
async function isDesired(name: string): Promise<boolean> {
  const state = await readDesired(registry, { nodeId: SELF, mode: "legacy-fallback" });
  return state.environments.some((entry) => entry.env.name === name);
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
  await createBuild(ctx, PROJECT, { id: BUILD });

  const taken = await acquireLease(ctx, SELF);
  if (taken === null) throw new Error("the fixture could not take the lease");

  const names = Array.from({ length: 12 }, (_, index) => `env-${String(index).padStart(2, "0")}`);
  for (const name of names) {
    await createEnvironment(ctx, PROJECT, { name });
    await recordDeployment(ctx, PROJECT, name, BUILD);
    await writePlacement(ctx, PROJECT, name, [SELF], taken);
  }
  return { ctx, observing, names };
}

/** Leaves the environment with a current-deployment timestamp nothing can read. */
async function damageCurrentTimestamp(name: string): Promise<void> {
  const current = await readJson<EnvironmentRecord>(registry, environmentKey(PROJECT, name));
  const deployment = current?.value.deployment;
  await writeRecord(name, {
    deployment: { ...(deployment as NonNullable<typeof deployment>), deployedAt: "whenever" },
  });
}
