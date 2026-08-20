/* Custom domains: one claim per host, mirrored on the environment that serves it. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  checkDomain,
  claimDomain,
  createEnvironment,
  createProject,
  getEnvironment,
  readJson,
  releaseDomain,
} from "../src/core/registry/index.ts";
import { domainKey } from "../src/core/registry/paths.ts";
import type { DomainClaim } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const PROJECT = "app";
const HOST = "shop.example.com";

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);
  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, { name: "prod" });
  await createEnvironment(clock.ctx, PROJECT, { name: "staging" });
});

describe("claimDomain", () => {
  it("claims the host and mirrors it on the environment", async () => {
    const claim = await claimDomain(clock.ctx, HOST, PROJECT, "prod");

    expect(claim).toEqual({
      v: 1,
      project: PROJECT,
      environment: "prod",
      claimedAt: new Date(clock.nowMs()).toISOString(),
    });
    await expect(checkDomain(clock.ctx, HOST)).resolves.toEqual(claim);
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).domains).toEqual([HOST]);
    await invariants(store);
  });

  it("is idempotent for the same environment", async () => {
    const first = await claimDomain(clock.ctx, HOST, PROJECT, "prod");
    clock.tick(60_000);
    const second = await claimDomain(clock.ctx, HOST, PROJECT, "prod");

    expect(second).toEqual(first);
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).domains).toEqual([HOST]);
  });

  it("refuses a host another environment already holds", async () => {
    await claimDomain(clock.ctx, HOST, PROJECT, "prod");

    const error = await rejectsWith(
      () => claimDomain(clock.ctx, HOST, PROJECT, "staging"),
      "reference-held",
    );
    expect(error.status).toBe(409);
    expect((await getEnvironment(clock.ctx, PROJECT, "staging")).domains).toEqual([]);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ environment: "prod" });
  });

  it("requires the environment to exist", async () => {
    await rejectsWith(() => claimDomain(clock.ctx, HOST, PROJECT, "missing"), "not-found");
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("rejects a host that is not a DNS name", async () => {
    const error = await rejectsWith(
      () => claimDomain(clock.ctx, "Shop.Example.com", PROJECT, "prod"),
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
    await claimDomain(clock.ctx, HOST, PROJECT, "prod");
    await releaseDomain(clock.ctx, HOST);

    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).domains).toEqual([]);
    await invariants(store);
  });

  it("is a no-op for a host that was never claimed", async () => {
    const before = store.puts + store.dels;
    await expect(releaseDomain(clock.ctx, "unclaimed.example.com")).resolves.toBeUndefined();
    expect(store.puts + store.dels).toBe(before);
  });

  it("tolerates an environment that is already gone", async () => {
    await claimDomain(clock.ctx, HOST, PROJECT, "prod");
    await inner.del(`_scafo/projects/${PROJECT}/environments/prod.json`);

    await expect(releaseDomain(clock.ctx, HOST)).resolves.toBeUndefined();
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });
});

describe("a claim killed before the environment learns about it", () => {
  it("leaves a legal state that re-running the claim repairs", async () => {
    store.failAfter(1);

    await expect(async () => claimDomain(clock.ctx, HOST, PROJECT, "prod")).rejects.toThrow(
      /Injected fault/,
    );

    const claim = await readJson<DomainClaim>(clock.ctx, domainKey(HOST));
    expect(claim?.value.environment).toBe("prod");
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).domains).toEqual([]);
    await invariants(store);

    store.clearFaults();
    await claimDomain(clock.ctx, HOST, PROJECT, "prod");
    expect((await getEnvironment(clock.ctx, PROJECT, "prod")).domains).toEqual([HOST]);
    await invariants(store);
  });
});
