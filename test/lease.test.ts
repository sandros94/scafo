/* The coordinator lease is exclusive while live, and its fence only ever goes up. */

import { describe, expect, it } from "vitest";
import {
  acquireLease,
  createEnvironment,
  createProject,
  executeReap,
  isLeaseExpired,
  type LeaseHandle,
  planReap,
  readJson,
  registerNode,
  releaseLease,
  removeNode,
  renewLease,
  verifyLease,
} from "../src/core/registry/index.ts";
import type { CoordinatorLease, NodeRecord } from "../src/core/types/registry.ts";
import { coordinatorKey, nodeKey } from "../src/core/registry/paths.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, rejectsWith } from "./_helpers.ts";

const TTL_MS = 15_000;

const NODE: NodeRecord = {
  v: 1,
  id: "node-a",
  publicKey: { kty: "OKP", crv: "Ed25519", x: "Zm9v" },
  addresses: { internal: "10.0.0.1", apiPort: 7777 },
};

/** Acquires and unwraps the handle; a null return means the test premise broke. */
async function held(acquired: Promise<LeaseHandle | null>, who: string): Promise<LeaseHandle> {
  const handle = await acquired;
  expect(handle, `${who} should hold the lease`).not.toBeNull();
  return handle as LeaseHandle;
}

describe("acquireLease", () => {
  it("starts at fence 1 and increments on every acquisition", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());

    const first = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    expect(first.lease).toMatchObject({ v: 1, node: "node-a", fence: 1, ttlMs: TTL_MS });

    await releaseLease(ctx, first);
    const second = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a again");
    expect(second.lease.fence).toBe(2);
  });

  it("refuses a second node while the lease is live", async () => {
    const { ctx, tick } = ctxWith(new MemoryCasStore());

    await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    tick(TTL_MS - 1);
    await expect(acquireLease(ctx, "node-b", { ttlMs: TTL_MS })).resolves.toBeNull();
  });

  it("hands the lease over once it expires", async () => {
    const { ctx, tick } = ctxWith(new MemoryCasStore());

    const a = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    tick(TTL_MS + 1);
    expect(isLeaseExpired(a.lease, new Date(Date.parse(a.lease.acquiredAt) + TTL_MS))).toBe(true);

    const b = await held(acquireLease(ctx, "node-b", { ttlMs: TTL_MS }), "node-b");
    expect(b.lease.node).toBe("node-b");
    expect(b.lease.fence).toBe(2);
    await expect(verifyLease(ctx, b)).resolves.toBe(true);
  });

  it("keeps fences strictly monotonic across ten forced takeovers", async () => {
    const { ctx, tick } = ctxWith(new MemoryCasStore());
    const fences: number[] = [];

    for (let i = 0; i < 10; i++) {
      const handle = await held(
        acquireLease(ctx, i % 2 === 0 ? "node-a" : "node-b", { ttlMs: TTL_MS }),
        `takeover ${String(i)}`,
      );
      fences.push(handle.lease.fence);
      tick(TTL_MS + 1);
    }

    expect(fences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < fences.length; i++) expect(fences[i]).toBeGreaterThan(fences[i - 1]);

    const stored = await readJson<CoordinatorLease>(ctx, coordinatorKey());
    expect(stored?.value.fence).toBe(10);
  });
});

describe("renewLease", () => {
  it("extends in place without moving the fence", async () => {
    const { ctx, tick } = ctxWith(new MemoryCasStore());

    const first = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    tick(TTL_MS - 1);
    const renewed = await renewLease(ctx, first);

    expect(renewed.lease.fence).toBe(1);
    expect(Date.parse(renewed.lease.acquiredAt)).toBeGreaterThan(
      Date.parse(first.lease.acquiredAt),
    );
    await expect(verifyLease(ctx, first)).resolves.toBe(false);
    await expect(verifyLease(ctx, renewed)).resolves.toBe(true);
  });
});

describe("a superseded holder", () => {
  it("is rejected by renew, verify and every lease-gated write", async () => {
    const store = new FaultStore(new MemoryCasStore());
    const { ctx, tick } = ctxWith(store);

    await createProject(ctx, { slug: "app" });
    await createEnvironment(ctx, "app", { name: "preview", ephemeral: true, idleTtlS: 900 });
    await registerNode(ctx, NODE);

    const stale = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    tick(3_600_000);
    const plan = await planReap(ctx, { buildRetention: { maxAgeMs: 1000 } });
    expect(plan.environments).toHaveLength(1);

    await held(acquireLease(ctx, "node-b", { ttlMs: TTL_MS }), "node-b");
    const deletesBefore = store.dels;

    await expect(verifyLease(ctx, stale)).resolves.toBe(false);
    await rejectsWith(() => renewLease(ctx, stale), "lease-lost");
    await rejectsWith(() => removeNode(ctx, NODE.id, stale), "lease-lost");
    await rejectsWith(() => executeReap(ctx, plan, stale), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    expect(store.dels).toBe(0);
    await expect(readJson(ctx, nodeKey(NODE.id))).resolves.not.toBeNull();
  });
});

describe("releaseLease", () => {
  it("marks the lease takeable immediately", async () => {
    const { ctx } = ctxWith(new MemoryCasStore());

    const a = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    await releaseLease(ctx, a);

    const b = await held(acquireLease(ctx, "node-b", { ttlMs: TTL_MS }), "node-b");
    expect(b.lease.fence).toBe(2);
  });

  it("tolerates having already been taken over", async () => {
    const { ctx, tick } = ctxWith(new MemoryCasStore());

    const a = await held(acquireLease(ctx, "node-a", { ttlMs: TTL_MS }), "node-a");
    tick(TTL_MS + 1);
    await held(acquireLease(ctx, "node-b", { ttlMs: TTL_MS }), "node-b");

    await expect(releaseLease(ctx, a)).resolves.toBeUndefined();
    const current = await readJson<CoordinatorLease>(ctx, coordinatorKey());
    expect(current?.value.node).toBe("node-b");
  });
});
