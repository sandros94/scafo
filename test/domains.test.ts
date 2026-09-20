/* Custom domains: one claim per host, mirrored on the application that serves it. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  applicationKey,
  blockApplication,
  checkDomain,
  claimDomain,
  claimedApplication,
  createApplication,
  domainConflict,
  getApplication,
  MAX_APPLICATION_DOMAINS,
  readJson,
  releaseApplicationDomain,
  releaseDomain,
  retireApplication,
} from "../src/core/registry/index.ts";
import { setApplicationLabels } from "../src/core/registry/applications.ts";
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

  it("rejects a host that is not one to claim", async () => {
    const error = await rejectsWith(
      () => claimDomain(clock.ctx, "shop.example.com:8443", APPLICATION),
      "invalid-input",
    );
    expect(error.status).toBe(400);
    await expect(checkDomain(clock.ctx, "shop.example.com")).resolves.toBeNull();
  });

  it("stores one spelling of a name DNS reads as one", async () => {
    await claimDomain(clock.ctx, "Shop.Example.COM", APPLICATION);

    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([HOST]);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({
      application: APPLICATION,
    });
    /* And claiming it again in another casing is the same claim, not a second. */
    await claimDomain(clock.ctx, "SHOP.example.com", APPLICATION);
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([HOST]);
  });

  it("refuses a BLOCKED application, which is served nowhere to point a host at", async () => {
    await blockApplication(clock.ctx, APPLICATION);

    const error = await rejectsWith(
      () => claimDomain(clock.ctx, HOST, APPLICATION),
      "application-blocked",
    );

    expect(error.status).toBe(409);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("claims for a RETIRED application, which is coming back or going away", async () => {
    await retireApplication(clock.ctx, APPLICATION);

    await expect(claimDomain(clock.ctx, HOST, APPLICATION)).resolves.toMatchObject({
      application: APPLICATION,
    });
    await invariants(store);
  });

  it(`holds an application to ${String(MAX_APPLICATION_DOMAINS)} domains, naming the bound`, async () => {
    for (let i = 0; i < MAX_APPLICATION_DOMAINS; i++) {
      await claimDomain(clock.ctx, `h${String(i)}.example.com`, APPLICATION);
    }

    const error = await rejectsWith(
      () => claimDomain(clock.ctx, HOST, APPLICATION),
      "invalid-input",
    );

    expect(error.detail).toContain(String(MAX_APPLICATION_DOMAINS));
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toHaveLength(
      MAX_APPLICATION_DOMAINS,
    );
    /* The bound is on new hosts: one it already holds is still idempotent. */
    await expect(claimDomain(clock.ctx, "h0.example.com", APPLICATION)).resolves.toMatchObject({
      application: APPLICATION,
    });
    /* And the refused claim left no key behind for anyone else to trip over. */
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    await invariants(store);
  });

  it("re-reads and wins when the record moved under it", async () => {
    /* A CAS conflict on the mirror is retried from a fresh read, so a claim that
       raced another write of the same record still lands — and keeps what the
       write it lost to had said. */
    let raced = false;
    store.onBeforePut = async (key): Promise<void> => {
      if (raced || key !== applicationKey(APPLICATION)) return;
      raced = true;
      await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme" });
    };

    await claimDomain(clock.ctx, HOST, APPLICATION);
    store.onBeforePut = undefined;

    expect(raced).toBe(true);
    const application = await getApplication(clock.ctx, APPLICATION);
    expect(application.domains).toEqual([HOST]);
    expect(application.labels).toEqual({ tenant: "acme" });
    await invariants(store);
  });
});

describe("a claim made WITH the one label below its host", () => {
  const SUB = `preview.${HOST}`;
  /** The environment of `shop` the base's own label names. */
  const FAMILY = `${APPLICATION}-preview`;

  beforeEach(async () => {
    await createApplication(clock.ctx, { name: FAMILY });
  });

  it("records the flag on the claim and mirrors it on the application", async () => {
    const claim = await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });

    expect(claim.wildcard).toBe(true);
    const application = await getApplication(clock.ctx, APPLICATION);
    expect(application.domains).toEqual([HOST]);
    /* A SUBSET of `domains`, so every reader that knows only the one field is
       still correct about which hosts the application holds. */
    expect(application.wildcardDomains).toEqual([HOST]);
    await invariants(store);
  });

  it("upgrades a claim the application already holds, and never downgrades one", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);
    expect((await getApplication(clock.ctx, APPLICATION)).wildcardDomains).toBeUndefined();

    const upgraded = await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });
    expect(upgraded.wildcard).toBe(true);
    expect((await getApplication(clock.ctx, APPLICATION)).wildcardDomains).toEqual([HOST]);

    /* Re-running the plain `add` leaves it exactly as it was: dropping it
       silently would take every subdomain out of routing. */
    const again = await claimDomain(clock.ctx, HOST, APPLICATION);
    expect(again.wildcard).toBe(true);
    expect((await checkDomain(clock.ctx, HOST))?.wildcard).toBe(true);
    expect((await getApplication(clock.ctx, APPLICATION)).wildcardDomains).toEqual([HOST]);
    await invariants(store);
  });

  it("drops the whole claim on release, mirror and all", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });
    await claimDomain(clock.ctx, "www.example.com", APPLICATION);

    await releaseApplicationDomain(clock.ctx, HOST, APPLICATION);

    const application = await getApplication(clock.ctx, APPLICATION);
    expect(application.domains).toEqual(["www.example.com"]);
    /* The key goes with the last wildcard rather than lingering as an empty list. */
    expect(application.wildcardDomains).toBeUndefined();
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    await invariants(store);
  });

  it("lets only the holder's own family claim a host one label under it", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });

    /* Its own environment may: that is the name the wildcard already routes there. */
    await expect(claimDomain(clock.ctx, SUB, FAMILY)).resolves.toMatchObject({
      application: FAMILY,
    });
    /* And the holder itself may take another one. */
    await expect(claimDomain(clock.ctx, `www.${HOST}`, APPLICATION)).resolves.toMatchObject({
      application: APPLICATION,
    });

    const error = await rejectsWith(
      () => claimDomain(clock.ctx, `shop.${HOST}`, NEIGHBOUR),
      "reference-held",
    );
    expect(error.status).toBe(409);
    expect(error.detail).toContain(APPLICATION);
    await expect(checkDomain(clock.ctx, `shop.${HOST}`)).resolves.toBeNull();
    await invariants(store);
  });

  it("leaves a host two labels under the base to anyone", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });

    /* A wildcard covers one label, so `a.b.shop.example.com` is nobody's. */
    await expect(claimDomain(clock.ctx, `a.b.${HOST}`, NEIGHBOUR)).resolves.toMatchObject({
      application: NEIGHBOUR,
    });
  });

  it("refuses the wildcard while somebody outside the family holds a host under it", async () => {
    await claimDomain(clock.ctx, SUB, NEIGHBOUR);

    const error = await rejectsWith(
      () => claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true }),
      "reference-held",
    );

    expect(error.detail).toContain(SUB);
    expect(error.detail).toContain(NEIGHBOUR);
    /* Nothing was written: the plain claim is still there to be made. */
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    await expect(claimDomain(clock.ctx, HOST, APPLICATION)).resolves.toMatchObject({
      application: APPLICATION,
    });
    expect((await getApplication(clock.ctx, APPLICATION)).wildcardDomains).toBeUndefined();
  });

  it("takes the wildcard when everything under it is the family's own", async () => {
    await claimDomain(clock.ctx, SUB, FAMILY);
    await claimDomain(clock.ctx, `www.${HOST}`, APPLICATION);

    await expect(
      claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true }),
    ).resolves.toMatchObject({ wildcard: true });
    await invariants(store);
  });

  it("answers which claim stands in the way, and how it relates to the host asked for", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });
    await claimDomain(clock.ctx, "www.example.com", NEIGHBOUR);

    await expect(domainConflict(clock.ctx, SUB, NEIGHBOUR)).resolves.toEqual({
      host: HOST,
      application: APPLICATION,
      relation: "parent",
    });
    await expect(domainConflict(clock.ctx, "www.example.com", APPLICATION)).resolves.toEqual({
      host: "www.example.com",
      application: NEIGHBOUR,
      relation: "exact",
    });
    await expect(
      domainConflict(clock.ctx, "example.com", NEIGHBOUR, { wildcard: true }),
    ).resolves.toEqual({ host: HOST, application: APPLICATION, relation: "child" });
    /* Nothing in the way of the claim the application already holds. */
    await expect(domainConflict(clock.ctx, HOST, APPLICATION)).resolves.toBeNull();
  });
});

describe("claimedApplication", () => {
  beforeEach(async () => {
    await createApplication(clock.ctx, { name: `${APPLICATION}-preview` });
  });

  it("names the exact holder, the family member a wildcard covers, and nobody else", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION, { wildcard: true });
    await claimDomain(clock.ctx, "www.example.com", NEIGHBOUR);

    await expect(claimedApplication(clock.ctx, HOST)).resolves.toBe(APPLICATION);
    await expect(claimedApplication(clock.ctx, "www.example.com")).resolves.toBe(NEIGHBOUR);
    await expect(claimedApplication(clock.ctx, `preview.${HOST}`)).resolves.toBe(
      `${APPLICATION}-preview`,
    );
    /* NEVER THE HOLDER for an arbitrary subdomain, although the routing sends
       one there: it names the application that label would be, and the caller
       finds out there is no such application. */
    await expect(claimedApplication(clock.ctx, `anything.${HOST}`)).resolves.toBe(
      `${APPLICATION}-anything`,
    );
    await expect(claimedApplication(clock.ctx, `a.b.${HOST}`)).resolves.toBeNull();
    await expect(claimedApplication(clock.ctx, "nobody.example.com")).resolves.toBeNull();
  });

  it("reads nothing above a host whose claim was not made with its subdomains", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    await expect(claimedApplication(clock.ctx, `preview.${HOST}`)).resolves.toBeNull();
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

describe("releaseApplicationDomain", () => {
  it("drops a host the application holds", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    await expect(releaseApplicationDomain(clock.ctx, HOST, APPLICATION)).resolves.toBeUndefined();

    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([]);
    await invariants(store);
  });

  it("takes the host as DNS reads it, whatever the casing on the command line", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    await releaseApplicationDomain(clock.ctx, "SHOP.Example.com", APPLICATION);

    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("NEVER releases a claim another application holds, and says the same as a claim nobody holds", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    const held = await rejectsWith(
      () => releaseApplicationDomain(clock.ctx, HOST, NEIGHBOUR),
      "not-found",
    );
    const never = await rejectsWith(
      () => releaseApplicationDomain(clock.ctx, "unclaimed.example.com", NEIGHBOUR),
      "not-found",
    );

    /* The same words for both, so asking cannot tell a held host from a free
       one for an application the caller does not reach. */
    expect(held.detail?.replace(HOST, "X")).toBe(
      never.detail?.replace("unclaimed.example.com", "X"),
    );
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({
      application: APPLICATION,
    });
    expect((await getApplication(clock.ctx, APPLICATION)).domains).toEqual([HOST]);
  });

  it("releases for a blocked application, so nothing is trapped by a block", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);
    await blockApplication(clock.ctx, APPLICATION);

    await expect(releaseApplicationDomain(clock.ctx, HOST, APPLICATION)).resolves.toBeUndefined();

    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("refuses a host that is no host at all before it reads anything", async () => {
    const before = store.gets;

    await rejectsWith(
      () => releaseApplicationDomain(clock.ctx, "*.example.com", APPLICATION),
      "invalid-input",
    );

    expect(store.gets).toBe(before);
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
