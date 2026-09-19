/*
 * Deleting an application because an operator said so: what it refuses, the
 * order it takes things apart in, everything of a sibling it must leave alone,
 * and what a lease taken away mid-run leaves.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createApplication,
  createDeployment,
  createDeployRecord,
  DEFAULT_RETIREMENT_GRACE_MS,
  deleteApplication,
  getApplication,
  getDeployRecord,
  getDeployment,
  getTrustPolicy,
  type LeaseHandle,
  readPlacement,
  renewLease,
  retireApplication,
  setTrustPolicy,
  writePlacement,
} from "../src/core/registry/index.ts";
import {
  applicationKey,
  deploymentKey,
  deploymentsPrefix,
  deployKey,
  deploysPrefix,
  domainKey,
  fleetPrefix,
  placementKey,
  trustKey,
} from "../src/core/registry/paths.ts";
import { readJson } from "../src/core/registry/cas.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import { coordinatorKey } from "../src/core/registry/paths.ts";
import type { CoordinatorLease, TrustPolicy } from "../src/core/types/registry.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, invariants, type ManualClock, rejectsWith } from "./_helpers.ts";

const APPLICATION = "shop";
const KEEPER = "blog";
const VERSION = "b1b1b1b1";
const HOST = "preview.example.com";
const HOUR_MS = 3_600_000;
const NODE = "node-a";
/** Root every registry document lives under; `paths.ts` keeps it private. */
const ROOT = "_scafo";

/**
 * Names that share the deleted one's leading characters without being it.
 * `shop-preview` and `shop2` both start with `shop`, so a prefix listing that
 * forgets its separator would take their keys down with it.
 */
const SIBLINGS = [`${APPLICATION}-preview`, `${APPLICATION}2`];

const FLEET_KEYS = [
  `${fleetPrefix(APPLICATION)}/node-a.json`,
  `${fleetPrefix(APPLICATION)}/state/routes.json`,
];

const POLICY: TrustPolicy = {
  v: 1,
  issuers: [
    {
      iss: "https://token.actions.githubusercontent.com",
      aud: "scafo",
      subjects: ["repo:sandros94/scafo:*"],
    },
  ],
};

let inner: MemoryCasStore;
let store: FaultStore;
let clock: ManualClock;
let lease: LeaseHandle;

beforeEach(async () => {
  inner = new MemoryCasStore();
  store = new FaultStore(inner);
  clock = ctxWith(store);

  for (const name of [APPLICATION, KEEPER, ...SIBLINGS]) {
    await createApplication(clock.ctx, { name });
    await createDeployment(clock.ctx, name, { version: VERSION });
    await recordRevision(clock.ctx, name, VERSION);
    await setTrustPolicy(clock.ctx, name, POLICY);
    await createDeployRecord(clock.ctx, name, {
      id: `${name}.a1b2c3d4e5f60718`,
      node: NODE,
    });
    await store.put(`${fleetPrefix(name)}/keep.json`, "{}");
  }

  for (const key of FLEET_KEYS) await store.put(key, "{}");

  const acquired = await acquireLease(clock.ctx, NODE);
  if (acquired === null) throw new Error("the fixture could not take the lease");
  lease = acquired;

  for (const name of [APPLICATION, KEEPER, ...SIBLINGS]) {
    await writePlacement(clock.ctx, name, [NODE], lease);
  }

  /* Every case here takes the same application apart, so the fixture puts it in
     the one state a deletion is allowed from: retired, and past its grace. */
  await retireApplication(clock.ctx, APPLICATION);
  clock.tick(DEFAULT_RETIREMENT_GRACE_MS);
});

describe("deleteApplication", () => {
  it("is carried through with the lease it was handed, whatever renews it meanwhile", async () => {
    /* The coordinator renews on its own timer while a deletion it was handed the
       lease for is still walking the application. A renewal is the same tenancy
       going on, and the deletion must not be refused by the node carrying it
       out. */
    const handed = lease;
    await renewLease(clock.ctx, lease);
    await renewLease(clock.ctx, await held(clock.ctx));

    const result = await deleteApplication(clock.ctx, APPLICATION, handed);

    expect(result.deleted.length).toBeGreaterThan(0);
    await rejectsWith(() => getApplication(clock.ctx, APPLICATION), "not-found");
  });

  it("refuses one that is not retired, and deletes nothing at all", async () => {
    const deletesBefore = store.dels;

    const error = await rejectsWith(
      () => deleteApplication(clock.ctx, KEEPER, lease),
      "invalid-input",
    );

    /* 409 rather than 400: the request is well-formed, the application is simply
       not in a state this call may act on. */
    expect(error.status).toBe(409);
    expect(error.detail).toContain("not retired");
    expect(store.dels).toBe(deletesBefore);
    await expect(getApplication(clock.ctx, KEEPER)).resolves.toMatchObject({ name: KEEPER });
    await invariants(store);
  });

  it("deletes the claims, then the fleet keys, then the record", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease);

    expect(deleted).toEqual([
      domainKey(HOST),
      `${fleetPrefix(APPLICATION)}/keep.json`,
      ...FLEET_KEYS,
      deployKey(APPLICATION, `${APPLICATION}.a1b2c3d4e5f60718`),
      deploymentKey(APPLICATION, VERSION),
      trustKey(APPLICATION),
      placementKey(APPLICATION),
      applicationKey(APPLICATION),
    ]);
    await rejectsWith(() => getApplication(clock.ctx, APPLICATION), "not-found");
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    await invariants(store);
  });

  it("takes the trust policy with it, so a pre-granted name stops authorizing", async () => {
    await deleteApplication(clock.ctx, APPLICATION, lease);

    /* A policy that outlived the application it names would keep letting a CI
       job deploy into a name nobody owns any more. */
    const error = await rejectsWith(() => getTrustPolicy(clock.ctx, APPLICATION), "not-found");

    expect(error.detail).toContain(trustKey(APPLICATION));
  });

  it("takes its placement, deployments and deploys with it", async () => {
    await deleteApplication(clock.ctx, APPLICATION, lease);

    await expect(readPlacement(clock.ctx, APPLICATION)).resolves.toBeNull();
    await rejectsWith(() => getDeployment(clock.ctx, APPLICATION, VERSION), "not-found");
    await rejectsWith(
      () => getDeployRecord(clock.ctx, APPLICATION, `${APPLICATION}.a1b2c3d4e5f60718`),
      "not-found",
    );
  });

  it("leaves no key of any kind behind, each kind living under a prefix of its own", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    await deleteApplication(clock.ctx, APPLICATION, lease);

    const left = [...(await store.list(`${ROOT}/`)), ...(await store.list("fleets/"))];
    expect(left).not.toContain(applicationKey(APPLICATION));
    expect(left).not.toContain(trustKey(APPLICATION));
    expect(left).not.toContain(placementKey(APPLICATION));
    expect(left).not.toContain(domainKey(HOST));
    /* By prefix as well as by key, so a record filed under a version or an id
       this case never named is caught too. */
    const owned = [
      deploymentsPrefix(APPLICATION),
      deploysPrefix(APPLICATION),
      `${fleetPrefix(APPLICATION)}/`,
    ];
    expect(left.filter((key) => owned.some((prefix) => key.startsWith(prefix)))).toEqual([]);
  });

  it("leaves an application whose name merely starts with this one untouched", async () => {
    await deleteApplication(clock.ctx, APPLICATION, lease);

    for (const sibling of SIBLINGS) {
      /* Every kind, because each lives under a prefix of its own and a listing
         that forgot its separator would empty one of them without the others
         ever noticing. */
      await expect(getApplication(clock.ctx, sibling)).resolves.toMatchObject({ name: sibling });
      await expect(getTrustPolicy(clock.ctx, sibling)).resolves.toEqual(POLICY);
      await expect(readPlacement(clock.ctx, sibling)).resolves.not.toBeNull();
      await expect(getDeployment(clock.ctx, sibling, VERSION)).resolves.toMatchObject({
        version: VERSION,
      });
      await expect(
        getDeployRecord(clock.ctx, sibling, `${sibling}.a1b2c3d4e5f60718`),
      ).resolves.toMatchObject({ application: sibling });
      await expect(store.get(`${fleetPrefix(sibling)}/keep.json`)).resolves.not.toBeNull();
    }
    await invariants(store);
  });

  it("deletes one that never retired when force says so", async () => {
    const { deleted } = await deleteApplication(clock.ctx, KEEPER, lease, { force: true });

    expect(deleted).toContain(applicationKey(KEEPER));
    await rejectsWith(() => getApplication(clock.ctx, KEEPER), "not-found");
  });

  it("leaves a domain another application took over alone", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);
    /* The claim moves on before the delete reaches it; it belongs to the
       neighbour now. */
    await inner.put(
      domainKey(HOST),
      JSON.stringify({ v: 1, application: KEEPER, claimedAt: "2026-01-01" }),
    );

    const { deleted } = await deleteApplication(clock.ctx, APPLICATION, lease);

    expect(deleted).not.toContain(domainKey(HOST));
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ application: KEEPER });
  });

  it("refuses one that is not there", async () => {
    const error = await rejectsWith(
      () => deleteApplication(clock.ctx, "ghost", lease),
      "not-found",
    );

    expect(error.detail).toContain(applicationKey("ghost"));
  });

  it("deletes nothing once the lease has been taken away", async () => {
    clock.tick(HOUR_MS);
    const stolen = await acquireLease(clock.ctx, "node-b");
    expect(stolen).not.toBeNull();

    const deletesBefore = store.dels;
    await rejectsWith(() => deleteApplication(clock.ctx, APPLICATION, lease), "lease-lost");

    expect(store.dels).toBe(deletesBefore);
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      name: APPLICATION,
    });
    for (const key of FLEET_KEYS) await expect(store.get(key)).resolves.not.toBeNull();
    await invariants(store);
  });

  it("stops at the step the lease was lost on, leaving the record for the next pass", async () => {
    await claimDomain(clock.ctx, HOST, APPLICATION);

    /* Taken away after the claim has been released, while the fleet keys are
       going: the application record must survive, because a record deleted
       ahead of its claims is one nothing would ever revisit. */
    store.onBeforeDel = async (key: string): Promise<void> => {
      if (!key.startsWith(fleetPrefix(APPLICATION))) return;
      store.onBeforeDel = undefined;
      clock.tick(HOUR_MS);
      await acquireLease(clock.ctx, "node-b");
    };

    await rejectsWith(() => deleteApplication(clock.ctx, APPLICATION, lease), "lease-lost");

    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      name: APPLICATION,
      /* Released before the record was touched, so nothing is left pointing at
         a claim that is gone and the next attempt starts from a consistent one. */
      domains: [],
    });
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
    await invariants(store);
  });
});

/** The lease as the store holds it now, as a handle the holder could renew. */
async function held(ctx: RegistryContext): Promise<LeaseHandle> {
  const found = await readJson<CoordinatorLease>(ctx, coordinatorKey());
  if (found === null) throw new Error("nobody holds the lease");
  return { lease: found.value, etag: found.etag };
}
