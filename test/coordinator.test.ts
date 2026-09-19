/* Coordinator lease acquisition, renewal, and immediate authority loss. */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import type { DaemonContext } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { type Coordinator, createCoordinator } from "../src/daemon/coordinator.ts";
import {
  acquireLease,
  createApplication,
  createDeployment,
  DEFAULT_RETIREMENT_GRACE_MS,
  getApplication,
  registerNode,
  readJson,
  retireApplication,
} from "../src/core/registry/index.ts";
import { deploymentKey, coordinatorKey } from "../src/core/registry/paths.ts";
import type { CoordinatorLease } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { hintingStore } from "../src/core/registry/changes.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const APP = "preview";
const VERSION = "b1b1b1b1";
const TTL_MS = 15_000;
const HOUR_MS = 3_600_000;

let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  store = new FaultStore(new MemoryCasStore());
  /* Hinting, as `createRegistry` builds every registry: a coordinator decides
     from its view, and a view only re-reads what it is told has moved. */
  clock = ctxWith(hintingStore(store));

  await deployed(APP);
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

  it("does not reap an active application merely because it is old", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    clock.tick(HOUR_MS);
    await coordinator.runOnce();

    await expect(getApplication(clock.ctx, APP)).resolves.toMatchObject({ name: APP });
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
    await expect(getApplication(clock.ctx, APP)).resolves.toMatchObject({ name: APP });
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
    await retireApplication(clock.ctx, APP);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS + 1);

    store.failAfter(1);
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(true);
    expect(coordinator.status().lastReapFailure).toContain("Injected fault");
    await expect(getApplication(clock.ctx, APP)).resolves.toMatchObject({ name: APP });

    store.clearFaults();
    clock.tick(TTL_MS / 3);
    await coordinator.runOnce();

    expect(coordinator.status().lastReapFailure).toBeNull();
    await rejectsWith(() => getApplication(clock.ctx, APP), "not-found");
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
    await expect(getApplication(clock.ctx, APP)).resolves.toMatchObject({ name: APP });

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

  it("renews mid-pass, so a pass longer than the TTL does not lose the lease", async () => {
    for (const name of ["one", "two", "three", "four"]) await deployed(name);
    /* A live node, so the pass has placements to decide and write: a pass with
       nothing to read is not one that can outlast anything. */
    await registerNode(clock.ctx, {
      v: 1,
      id: "node-a",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "node-a" },
      addresses: { internal: "10.0.0.1", apiPort: 7400 },
      heartbeatAt: new Date(clock.nowMs()).toISOString(),
    });
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    /* Every read now costs half a TTL, so the pass alone outlasts the lease. */
    const inner = clock.ctx.store;
    clock.ctx.store = {
      get: (key) => {
        clock.tick(TTL_MS / 2);
        return inner.get(key);
      },
      getBytes: (key, opts) => inner.getBytes(key, opts),
      put: (key, body, cas) => inner.put(key, body, cas),
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
      listEntries: (prefix) => inner.listEntries(prefix),
    };
    const startedAt = clock.nowMs();
    await coordinator.runOnce();

    expect(clock.nowMs() - startedAt).toBeGreaterThan(TTL_MS);
    expect(coordinator.status().holding).toBe(true);
    const lease = await storedLease();
    expect(clock.nowMs() - Date.parse(lease.acquiredAt)).toBeLessThan(TTL_MS);
  });

  it("joins the pass already running rather than quietly doing nothing", async () => {
    const coordinator = coordinatorFor("node-a");
    const held = Promise.withResolvers<void>();
    const inner = clock.ctx.store;
    let stalled = false;
    /* The first write of the lease hangs, so a second caller arrives while the
       pass that decides who coordinates is still in the middle of deciding. */
    clock.ctx.store = {
      get: (key) => inner.get(key),
      getBytes: (key, opts) => inner.getBytes(key, opts),
      put: async (key, body, cas) => {
        if (key === coordinatorKey() && !stalled) {
          stalled = true;
          await held.promise;
        }
        return inner.put(key, body, cas);
      },
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
      listEntries: (prefix) => inner.listEntries(prefix),
    };

    const first = coordinator.runOnce();
    await expect.poll(() => stalled, { interval: 1 }).toBe(true);
    let joined = false;
    const second = coordinator.runOnce().then(() => {
      joined = true;
    });

    /* It waited: returning at once would tell a caller that nobody coordinates
       while this very node is taking the lease. */
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(joined).toBe(false);
    expect(coordinator.status().holding).toBe(false);

    held.resolve();
    await Promise.all([first, second]);

    expect(joined).toBe(true);
    expect(coordinator.status().holding).toBe(true);
    /* And it joined rather than ran: one pass, one acquisition, one fence. */
    expect((await storedLease()).fence).toBe(1);
  });

  it("reaps no deployment at all while no deployment retention is configured", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    clock.tick(DEFAULT_RETIREMENT_GRACE_MS + 1);
    await coordinator.runOnce();

    /* Age alone makes a deployment no candidate: without a retention it is kept
       however old it is, and so is the application still pointing at it. */
    await expect(getApplication(clock.ctx, APP)).resolves.toMatchObject({ name: APP });
    await expect(store.get(deploymentKey(APP, VERSION))).resolves.not.toBeNull();
  });

  it("reaps the deployments of an application it deletes, and the application with them", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();
    await retireApplication(clock.ctx, APP);
    clock.tick(DEFAULT_RETIREMENT_GRACE_MS + 1);

    await coordinator.runOnce();

    await rejectsWith(() => getApplication(clock.ctx, APP), "not-found");
    await expect(store.get(deploymentKey(APP, VERSION))).resolves.toBeNull();
  });
});

/** A coordinator for `nodeId`, reaping on every tick against the shared store. */
function coordinatorFor(nodeId: string): Coordinator {
  return createCoordinator(daemonFor(nodeId), { ttlMs: TTL_MS, reapIntervalMs: 0 });
}

/** An application with a deployment notice, as the first deploy leaves it. */
async function deployed(name: string): Promise<void> {
  await createApplication(clock.ctx, { name });
  await createDeployment(clock.ctx, name, { version: VERSION });
  await recordRevision(clock.ctx, name, VERSION);
}

function daemonFor(nodeId: string): DaemonContext {
  return {
    config: daemonConfig(nodeId),
    nodeId,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: { scafo: "0.0.0-test", celld: "0.5.0" },
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
    forget: () => {},
    onExit: () => {},
  };
}
