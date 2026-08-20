/*
 * The coordinator loop: taking the lease, keeping it, and — the rule the whole
 * design rests on — stopping the moment a renewal is refused.
 *
 * The loop is driven a tick at a time rather than on its timer, and the clock is
 * the injected one, so every assertion is about what the loop decided and not
 * about how long a test was willing to wait.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { AgentContext } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { type Coordinator, createCoordinator } from "../src/agent/coordinator.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  flipAlias,
  getEnvironment,
  readJson,
} from "../src/core/registry/index.ts";
import { buildKey, coordinatorKey } from "../src/core/registry/paths.ts";
import type { CoordinatorLease } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const BUILD = "b1b1b1b1";
const TTL_MS = 15_000;
const IDLE_TTL_S = 900;
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
    idleTtlS: IDLE_TTL_S,
  });
  await createBuild(clock.ctx, PROJECT, { id: BUILD, runtimeConfigurable: true });
  await flipAlias(clock.ctx, PROJECT, "preview", BUILD);
});

describe("createCoordinator", () => {
  it("takes the lease when nobody holds one", async () => {
    const coordinator = coordinatorFor("node-a");

    await coordinator.runOnce();

    const status = coordinator.status();
    expect(status.holding).toBe(true);
    expect(status.lease).toMatchObject({ node: "node-a", fence: 1 });
    /* The fenced handle is what lease-gated calls take; a candidate has none. */
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
    /* Renewal is what moves the deadline; the fence only moves on a takeover. */
    expect(Date.parse(second.acquiredAt)).toBeGreaterThan(Date.parse(first.acquiredAt));
  });

  it("reaps what is idle while it holds the lease", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    clock.tick(IDLE_TTL_S * 1000 + 1);
    await coordinator.runOnce();

    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    expect(coordinator.status().lastReapFailure).toBeNull();
    expect(coordinator.status().lastReapAt).not.toBeNull();
  });

  it("stops reaping the instant a renewal is refused", async () => {
    const coordinator = coordinatorFor("node-a");
    await coordinator.runOnce();

    /* Long enough that the environment is reapable AND this node's lease has
       gone stale, so another node takes it over between two renewals. */
    clock.tick(HOUR_MS);
    const stolen = await acquireLease(clock.ctx, "node-b", { ttlMs: TTL_MS });
    expect(stolen).not.toBeNull();
    const deletesBefore = store.dels;

    await coordinator.runOnce();

    /*
     * The fencing rule. The reap was due on this very tick and the environment
     * was reapable, so the only reason nothing was deleted is that the loop
     * found out it is no longer the coordinator and stopped before doing any
     * coordinator-only work — node-b is already reaping against this registry.
     */
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

    /* The refused renewal, then two more ticks against a live foreign lease. */
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
    clock.tick(IDLE_TTL_S * 1000 + 1);

    /* The renewal goes through and the delete after it does not, so the reap is
       what fails rather than the lease. */
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
    clock.tick(IDLE_TTL_S * 1000 + 1);

    /* Not a takeover — the store simply refused the write. The loop cannot tell
       the two apart from here, and the safe reading of both is the same: a
       renewal that did not land means this node is not the coordinator, and the
       TTL will hand the lease to whoever asks next. */
    store.failAfter(0);
    const deletesBefore = store.dels;
    await coordinator.runOnce();

    expect(coordinator.status().holding).toBe(false);
    expect(store.dels).toBe(deletesBefore);
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      name: "preview",
    });

    /* And it comes back: the lease record still names this node, so the next
       tick takes it again — at a new fence, because a re-acquisition is one. */
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
    /* The clock has not moved, so only the release itself can let node-b in. */
    await second.runOnce();
    expect(second.status().holding).toBe(true);
    expect((await storedLease()).node).toBe("node-b");
  });

  it("reaps nothing at all when no build retention is configured", async () => {
    /* An installation that has never said how long it keeps builds is not one
       whose builds should start disappearing; the environment still goes. */
    const coordinator = coordinatorFor("node-a", { buildRetentionMs: undefined });
    await coordinator.runOnce();
    clock.tick(IDLE_TTL_S * 1000 + 1);
    await coordinator.runOnce();

    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, "preview"), "not-found");
    /* The build the deleted environment used to point at outlives it. */
    await expect(store.get(buildKey(PROJECT, BUILD))).resolves.not.toBeNull();
  });
});

/** A coordinator for `nodeId`, reaping on every tick against the shared store. */
function coordinatorFor(nodeId: string, opts?: { buildRetentionMs?: number }): Coordinator {
  return createCoordinator(agentFor(nodeId), {
    ttlMs: TTL_MS,
    /* Every tick reaps, so nothing a test observes depends on an interval. */
    reapIntervalMs: 0,
    ...(opts?.buildRetentionMs === undefined ? {} : { buildRetentionMs: opts.buildRetentionMs }),
  });
}

function agentFor(nodeId: string): AgentContext {
  return {
    config: agentConfig(nodeId),
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

function agentConfig(nodeId: string): AgentConfig {
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
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
    },
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
