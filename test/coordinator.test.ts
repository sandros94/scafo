/* Coordinator lease acquisition, renewal, and immediate authority loss. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { type Coordinator, createCoordinator } from "../src/daemon/coordinator.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  DEFAULT_RETIREMENT_GRACE_MS,
  getEnvironment,
  readJson,
  retireEnvironment,
} from "../src/core/registry/index.ts";
import { buildKey, coordinatorKey } from "../src/core/registry/paths.ts";
import type { CoordinatorLease } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const BUILD = "b1b1b1b1";
const TTL_MS = 15_000;
const HOUR_MS = 3_600_000;

let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  clock = ctxWith(store);

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, {
    name: "preview",
    ephemeral: true,
  });
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
  await recordDeployment(clock.ctx, PROJECT, "preview", BUILD);
});

describe("createCoordinator", () => {
  it("takes the lease when nobody holds one", async () => {
    const coordinator = coordinatorFor("node-a");

    await coordinator.runOnce();

    const status = coordinator.status();
    expect(status.holding).toBe(true);
    expect(status.lease).toMatchObject({ node: "node-a", fence: 1 });
    expect(coordinator.handle()).not.toBeNull();
  });

  it("renews in place, keeping its fence rather than outranking itself", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();
    const first = await storedLease();

    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();
    const second = await storedLease();

    expect(coordinator.status().holding).toBe(true);
    expect(second.fence).toBe(first.fence);
    expect(Date.parse(second.acquiredAt)).toBeGreaterThan(Date.parse(first.acquiredAt));
  });

  it("does not reap an ephemeral environment merely because it is old", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    clock.tick(HOUR_MS);
    await coordinator.runOnce();

    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
    expect(coordinator.status().lastReapFailure).toBeNull();
    expect(coordinator.status().lastReapAt).not.toBeNull();
  });

  it("stops reaping the instant a renewal is refused", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    clock.tick(HOUR_MS);
    const stolen = await acquireLease(clock.ctx, "node-b", { ttlMs: TTL_MS });
    expect(stolen).not.toBeNull();
    const deletesBefore = store.dels;

    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(false);
    expect(coordinator.handle()).toBeNull();
    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });
  });

  it("stays a candidate for as long as the node that took over keeps renewing", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();
    clock.tick(HOUR_MS);
    const stolen = await acquireLease(clock.ctx, "node-b", { ttlMs: TTL_MS });
    if (stolen === null) throw new Error("the takeover did not happen");

    await coordinator.runOnce();
    for (let tick = 0; tick < 2; tick++) {
      clock.tick(TTL_MS / 3);
      await coordinator.runOnce();
      expect(coordinator.status().holding).toBe(false);
    }

    expect((await storedLease()).node).toBe("node-b");
  });

  it("keeps the lease when a reap fails, and reaps again on the next tick", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();
    await retireEnvironment(clock.ctx, PROJECT, "preview");
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS + 1);

    store.failAfter(1);
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(true);
    expect(coordinator.status().lastReapFailure).toContain("Injected fault");
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });

    store.clearFaults();
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(coordinator.status().lastReapFailure).toBeNull();
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
  });

  it("gives the lease up when the bucket will not take the renewal", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();
    clock.tick(TTL_MS / 3);

    store.failAfter(0);
    const deletesBefore = store.dels;
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(false);
    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });

    store.clearFaults();
    await coordinator.runOnce();
    expect(coordinator.status().holding).toBe(true);
    expect((await storedLease()).fence).toBe(2);
  });

  it("never lets a second node hold the lease while the first keeps renewing", async () => {
    const first = coordinatorFor("node-a");
    const second = coordinatorFor("node-b");

    await first.runOnce();
    for (let tick = 0; tick < 3; tick++) {
      await second.runOnce();
      expect(second.status().holding, `on tick ${String(tick)}`).toBe(false);
      expect(second.handle(), `on tick ${String(tick)}`).toBeNull();

      clock.tick(TTL_MS / 3);
      await first.runOnce();
      expect(first.status().holding, `on tick ${String(tick)}`).toBe(true);
    }

    expect((await storedLease()).node).toBe("node-a");
    expect((await storedLease()).fence).toBe(1);
  });

  it("hands the lease on when it stops, without waiting out the TTL", async () => {
    const first = coordinatorFor("node-a");
    const second = coordinatorFor("node-b");
    await first.runOnce();

    await first.stop();

    expect(first.status().holding).toBe(false);
    await second.runOnce();
    expect(second.status().holding).toBe(true);
    expect((await storedLease()).node).toBe("node-b");
  });

  it("reaps nothing at all when no build retention is configured", async () => {
    const coordinator = coordinatorFor("node-a", { buildRetentionMs: undefined });
    await coordinator.runOnce();
    await retireEnvironment(clock.ctx, PROJECT, "preview");
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS + 1);
    await coordinator.runOnce();

    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    await expect(store.get(buildKey(PROJECT, BUILD))).resolves.not.toBeNull();
  });
});

/** A coordinator for `nodeId`, reaping on every tick against the shared store. */
function coordinatorFor(nodeId: string, opts?: { buildRetentionMs?: number }): Coordinator {
  return createCoordinator(daemonFor(nodeId), {
    ttlMs: TTL_MS,
    reapIntervalMs: 0,
    ...(opts?.buildRetentionMs === undefined ? {} : { buildRetentionMs: opts.buildRetentionMs }),
  });
}

function daemonFor(nodeId: string): DaemonContext {
  return {
    config: daemonConfig(nodeId),
    nodeId,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: "0.0.0-test",
  };
}

async function storedLease(): Promise<CoordinatorLease> {
  const found = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
  if (found === null) throw new Error("no lease has been written");
  return found.value;
}

function daemonConfig(nodeId: string): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: nodeId, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** Runs nothing: the coordinator loop never touches the supervisor. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
