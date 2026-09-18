/* Custom domains: one claim per host, mirrored on the application that serves it. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applicationKey,
  checkDomain,
  claimDomain,
  createApplication,
  getApplication,
  readJson,
  releaseDomain,
} from "../src/core/registry/index.ts";
import { domainKey } from "../src/core/registry/paths.ts";
import type { DomainClaim } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const APPLICATION = "shop";
const NEIGHBOUR = "blog";
const HOST = "shop.example.com";

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);
  await createApplication(clock.ctx, { name: APPLICATION });
  await createApplication(clock.ctx, { name: NEIGHBOUR });
});

describe("claimDomain", () => {
  it("claims the host and mirrors it on the application", async () => {
    const claim = await claimDomain(clock.ctx, HOST, APPLICATION);

    expect(claim).toEqual({
      v: 1,
      application: APPLICATION,
      claimedAt: new Date(clock.nowMs()).toISOString(),
    });
    await expect(checkDomain(clock.ctx, HOST)).resolves.toEqual(claim);
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([HOST]);
    await invariants(store);
  });

  it("is idempotent for the same application", async () => {
    const first = await claimDomain(clock.ctx, HOST, APPLICATION);
    clock.tick(60_000);
    const second = await claimDomain(clock.ctx, HOST, APPLICATION);

    expect(second).toEqual(first);
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([HOST]);
  });

  it("refuses a host another application already holds", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    const error = await rejectsWith(
      () => claimDomain(clock.ctx, HOST, NEIGHBOUR),
      "reference-held",
    );
    expect(error.status).toBe(409);
    expect((await getApplication(clock.ctx, NEIGHBOUR)).domains).toEqual([]);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({
      application: APPLICATION,
    });
  });

  it("requires the application to exist", async () => {
    await rejectsWith(() => claimDomain(clock.ctx, HOST, "missing"), "not-found");
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("rejects a host that is not a DNS name", async () => {
    const error = await rejectsWith(
      () => claimDomain(clock.ctx, "Shop.Example.com", APPLICATION),
      "invalid-slug",
    );
    expect(error.status).toBe(400);
  });
});

describe("checkDomain", () => {
  it("answers null for a host nobody claimed", async () => {
    await expect(checkDomain(clock.ctx, "unclaimed.example.com")).resolves.toBeNull();
  });
});

describe("releaseDomain", () => {
  it("drops the listing before the claim", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);
    await releaseDomain(clock.ctx, HOST);

    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([]);
    await invariants(store);
  });

  it("is a no-op for a host that was never claimed", async () => {
    const before = store.puts + store.dels;
    await expect(releaseDomain(clock.ctx, "unclaimed.example.com")).resolves.toBeUndefined();
    expect(store.puts + store.dels).toBe(before);
  });

  it("tolerates an application that is already gone", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);
    await inner.del(applicationKey(APPLICATION));

    await expect(releaseDomain(clock.ctx, HOST)).resolves.toBeUndefined();
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });
});

describe("a claim killed before the application learns about it", () => {
  it("leaves a legal state that re-running the claim repairs", async () => {
    store.failAfter(1);

    await expect(async () => claimDomain(clock.ctx, HOST, APPLICATION)).rejects.toThrow(
      /Injected fault/,
    );

    const claim = await readJson<DomainClaim>(clock.ctx, domainKey(HOST));
    expect(claim?.value.application).toBe(APPLICATION);
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([]);
    await invariants(store);

    store.clearFaults();
    await claimDomain(clock.ctx, HOST, APPLICATION);
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([HOST]);
    await invariants(store);
  });
});
