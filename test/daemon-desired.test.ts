/* What one read of the registry tells a node it should be serving. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { desiredFrom, type DesiredState } from "../src/daemon/_desired.ts";
import { createRegistryView } from "../src/core/registry/view.ts";
import {
  acquireLease,
  applicationKey,
  blockApplication,
  createApplication,
  createDeployment,
  deletePlacement,
  type LeaseHandle,
  retireApplication,
  setNodeSelector,
  unretireApplication,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { DEFAULT_CONCURRENCY } from "../src/core/utils/concurrency.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, ObservingStore } from "./_helpers.ts";

const APP = "shop";
const OTHER = "blog";
const STAGING = "shop-staging";
const PREVIEW = "shop-preview";
const VERSION = "b1b1b1b1";
const SELF = "node-a";
const PEER = "node-b";

let clock: ManualClock;
let registry: RegistryContext;
let lease: LeaseHandle;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  registry = clock.ctx;

  await deployed(APP);

  const acquired = await acquireLease(registry, SELF);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;
});

describe("an application nobody has placed", () => {
  it("is served nowhere, and reported nowhere either", async () => {
    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await desiredFor(registry, nodeId);

      expect(state.applications, nodeId).toEqual([]);
      expect(state.fleet, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });
});

describe("an application that has been placed", () => {
  it("is served here when the decision names this node", async () => {
    await writePlacement(registry, APP, [SELF, PEER], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications.map((entry) => entry.name)).toEqual([APP]);
    expect(state.placements).toEqual([{ application: APP, nodes: [SELF, PEER], self: true }]);
  });

  it("is NOT served here when the decision names other nodes", async () => {
    await writePlacement(registry, APP, [PEER], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications).toEqual([]);
    /* Still part of the fleet view: this node routes to it, it just does not run it. */
    expect(state.fleet.map((entry) => entry.name)).toEqual([APP]);
    expect(state.placements).toEqual([{ application: APP, nodes: [PEER], self: false }]);
  });

  it("reports what it is NOT serving, so an operator can see where it went", async () => {
    await deployed(STAGING);
    await writePlacement(registry, APP, [SELF], lease);
    await writePlacement(registry, STAGING, [PEER], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications.map((entry) => entry.name)).toEqual([APP]);
    expect(state.placements).toEqual([
      { application: APP, nodes: [SELF], self: true },
      { application: STAGING, nodes: [PEER], self: false },
    ]);
  });

  it("is served nowhere when the decision names nobody", async () => {
    await writePlacement(registry, APP, [], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications).toEqual([]);
    expect(state.placements[0]).toMatchObject({ nodes: [], self: false });
  });

  it("filters each application on its own", async () => {
    await deployed(OTHER);
    await writePlacement(registry, APP, [PEER], lease);
    await writePlacement(registry, OTHER, [SELF], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications.map((entry) => entry.name)).toEqual([OTHER]);
    expect(state.placements.map((view) => `${view.application}:${String(view.self)}`)).toEqual([
      `${OTHER}:true`,
      `${APP}:false`,
    ]);
  });
});

describe("an application that carries a node selector", () => {
  const FAST = { tier: "fast" };

  it("is NOT served anywhere while no coordinator has placed it", async () => {
    await setNodeSelector(registry, APP, FAST);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await desiredFor(registry, nodeId);
      expect(state.applications, nodeId).toEqual([]);
      expect(state.fleet, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("is served the moment a decision names this node, selector and all", async () => {
    await setNodeSelector(registry, APP, FAST);
    await writePlacement(registry, APP, [SELF], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications.map((entry) => entry.name)).toEqual([APP]);
    expect(state.placements).toEqual([
      { application: APP, nodes: [SELF], self: true, selector: FAST },
    ]);
  });

  it("is left out again when the decision names other nodes", async () => {
    await setNodeSelector(registry, APP, FAST);
    await writePlacement(registry, APP, [PEER], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications).toEqual([]);
    expect(state.placements[0]).toMatchObject({ self: false, selector: FAST });
  });

  it("reports the constraint beside the decision, so both are read together", async () => {
    await deployed(STAGING);
    await setNodeSelector(registry, APP, FAST);
    await writePlacement(registry, APP, [SELF], lease);
    await writePlacement(registry, STAGING, [SELF, PEER], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.placements).toEqual([
      { application: APP, nodes: [SELF], self: true, selector: FAST },
      { application: STAGING, nodes: [SELF, PEER], self: true },
    ]);
  });

  it("keeps serving what the decision says once the selector is cleared", async () => {
    await setNodeSelector(registry, APP, FAST);
    await writePlacement(registry, APP, [SELF], lease);

    await setNodeSelector(registry, APP, null);

    const state = await desiredFor(registry, SELF);
    expect(state.applications.map((entry) => entry.name)).toEqual([APP]);
    expect(state.placements).toEqual([{ application: APP, nodes: [SELF], self: true }]);
  });

  it("leaves the applications beside it entirely alone", async () => {
    await deployed(STAGING);
    await setNodeSelector(registry, APP, FAST);
    await writePlacement(registry, STAGING, [SELF], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications.map((entry) => entry.name)).toEqual([STAGING]);
  });
});

describe("what is left out for reasons other than placement", () => {
  it("leaves out an application without a deployment notice, squarely placed as it is", async () => {
    await createApplication(registry, { name: "fresh" });
    await writePlacement(registry, "fresh", [SELF], lease);
    await writePlacement(registry, APP, [SELF], lease);

    const state = await desiredFor(registry, SELF);

    expect(state.applications.map((entry) => entry.name)).toEqual([APP]);
    expect(state.placements.map((view) => view.application)).toEqual(["fresh", APP]);
  });

  it("leaves out a BLOCKED application, however squarely it is placed here", async () => {
    await writePlacement(registry, APP, [SELF], lease);
    await blockApplication(registry, APP);

    const state = await desiredFor(registry, SELF);

    expect(state.applications).toEqual([]);
    expect(state.fleet).toEqual([]);
    /* The decision stays readable, because unblocking takes it straight back. */
    expect(state.placements).toEqual([{ application: APP, nodes: [SELF], self: true }]);
  });

  it("leaves out a RETIRED application, however squarely it is placed here", async () => {
    await writePlacement(registry, APP, [SELF], lease);
    await retireApplication(registry, APP);

    const state = await desiredFor(registry, SELF);

    expect(state.applications).toEqual([]);
    expect(state.placements).toEqual([{ application: APP, nodes: [SELF], self: true }]);
  });

  it("takes it straight back the moment it is unretired", async () => {
    await writePlacement(registry, APP, [SELF], lease);
    await retireApplication(registry, APP);
    expect((await desiredFor(registry, SELF)).applications).toEqual([]);

    await unretireApplication(registry, APP);

    const state = await desiredFor(registry, SELF);
    expect(state.applications.map((entry) => entry.name)).toEqual([APP]);
    expect(state.applications[0].deployment?.revision).toBe(1);
  });

  it("leaves a retired application out on every node, not just this one", async () => {
    await writePlacement(registry, APP, [SELF, PEER, "node-c"], lease);
    await retireApplication(registry, APP);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      expect((await desiredFor(registry, nodeId)).applications, nodeId).toEqual([]);
    }
  });

  it("keeps it out once the coordinator has dropped its placement record too", async () => {
    await writePlacement(registry, APP, [SELF, PEER], lease);
    await retireApplication(registry, APP);
    await deletePlacement(registry, APP, lease);

    for (const nodeId of [SELF, PEER, "node-c"]) {
      const state = await desiredFor(registry, nodeId);
      expect(state.applications, nodeId).toEqual([]);
      expect(state.fleet, nodeId).toEqual([]);
      expect(state.placements, nodeId).toEqual([]);
    }
  });

  it("reads nothing at all out of an empty registry", async () => {
    const empty = ctxWith(new MemoryCasStore()).ctx;

    expect(await desiredFor(empty, SELF)).toEqual({
      applications: [],
      fleet: [],
      placements: [],
    });
  });
});

describe("an old application", () => {
  it("remains desired indefinitely", async () => {
    await deployed(PREVIEW);
    await writePlacement(registry, PREVIEW, [SELF], lease);
    clock.tick(365 * 24 * 60 * 60 * 1000);

    expect(await isDesired(PREVIEW)).toBe(true);
  });
});

describe("how a pass reads all of that", () => {
  it("overlaps the applications of an installation, up to the bound and no further", async () => {
    const { ctx, observing } = await watchedInstallation();
    observing.reset();

    await desiredFor(ctx, SELF);

    expect(observing.peakReads).toBeGreaterThan(1);
    expect(observing.peakReads).toBeLessThanOrEqual(DEFAULT_CONCURRENCY);
  });

  it("takes exactly the bound it is given, however many applications there are", async () => {
    const { ctx, observing } = await watchedInstallation();

    for (const concurrency of [1, 3]) {
      observing.reset();
      await desiredFor(ctx, SELF, { concurrency });
      expect(observing.peakReads, `bounded to ${String(concurrency)}`).toBe(concurrency);
    }
  });

  it("answers exactly what it answered one read at a time", async () => {
    const { ctx, observing, names } = await watchedInstallation();
    observing.delays.set(applicationKey(names[0]), 20);

    const overlapped = await desiredFor(ctx, SELF);
    const sequential = await desiredFor(ctx, SELF, { concurrency: 1 });

    expect(overlapped).toEqual(sequential);
    expect(overlapped.applications.map((entry) => entry.name)).toEqual(names);
    expect(overlapped.placements.map((view) => view.application)).toEqual(names);
  });

  it("surfaces the failure of the FIRST application, not of the first read to fail", async () => {
    const { ctx, observing, names } = await watchedInstallation();
    observing.delays.set(applicationKey(names[1]), 20);
    observing.faults.set(applicationKey(names[1]), new Error("the second"));
    observing.faults.set(applicationKey(names[5]), new Error("the sixth"));

    await expect(desiredFor(ctx, SELF)).rejects.toThrow("the second");
    await expect(desiredFor(ctx, SELF, { concurrency: 1 })).rejects.toThrow("the second");
  });
});

/**
 * What `nodeId` should be serving, as one pass works it out: a registry view
 * synced from scratch, and the pure decision taken off the snapshot it answers.
 */
async function desiredFor(
  ctx: RegistryContext,
  nodeId: string,
  opts?: { concurrency?: number },
): Promise<DesiredState> {
  const view = createRegistryView(ctx, opts === undefined ? {} : opts);
  return desiredFrom(await view.sync(), { nodeId });
}

/** An application with a deployment notice, ready to be served. */
async function deployed(name: string): Promise<void> {
  await createApplication(registry, { name });
  await createDeployment(registry, name, { version: VERSION });
  await recordRevision(registry, name, VERSION);
}

/** Whether this node would run `name`. */
async function isDesired(name: string): Promise<boolean> {
  const state = await desiredFor(registry, SELF);
  return state.applications.some((entry) => entry.name === name);
}

/**
 * A dozen deployed and decided applications, over a store that watches how its
 * reads run.
 */
async function watchedInstallation(): Promise<{
  ctx: RegistryContext;
  observing: ObservingStore;
  names: string[];
}> {
  const observing = new ObservingStore(new MemoryCasStore());
  const { ctx } = ctxWith(observing);

  const taken = await acquireLease(ctx, SELF);
  if (taken === null) throw new Error("the fixture could not take the lease");

  const names = Array.from({ length: 12 }, (_, index) => `app-${String(index).padStart(2, "0")}`);
  for (const name of names) {
    await createApplication(ctx, { name });
    await createDeployment(ctx, name, { version: VERSION });
    await recordRevision(ctx, name, VERSION);
    await writePlacement(ctx, name, [SELF], taken);
  }
  return { ctx, observing, names };
}
