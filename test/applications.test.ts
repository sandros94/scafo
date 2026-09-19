/*
 * The application record: what an application IS in the registry, the mutations
 * that may touch it, its monotonic deployment notice, and what a block does to
 * everything a node reads.
 */

import type { H3 } from "h3";
import { beforeEach, describe, expect, it } from "vitest";
import { deploymentRevision, recordRevision } from "../src/core/registry/_revision.ts";
import { readJson } from "../src/core/registry/cas.ts";
import type { RegistryContext } from "../src/core/registry/context.ts";
import {
  acquireLease,
  applicationKey,
  applicationsPrefix,
  blockApplication,
  claimDomain,
  countingRegistry,
  createApplication,
  createDeployment,
  createDeployRecord,
  findApplication,
  getApplication,
  listApplications,
  listApplicationRecords,
  registerNode,
  setApplicationLabels,
  setNodeSelector,
  setReplicas,
  setTrustPolicy,
  unblockApplication,
  updateApplication,
  writePlacement,
} from "../src/core/registry/index.ts";
import type { ApplicationRecord, TrustPolicy } from "../src/core/types/registry.ts";
import type { CasStore } from "../src/core/types/store.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { desiredFrom } from "../src/daemon/_desired.ts";
import { createRegistryView } from "../src/core/registry/view.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import {
  CLOCK_START_MS,
  ctxWith,
  type ManualClock,
  rejectionOf,
  rejectsWith,
  TEST_VERSIONS,
} from "./_helpers.ts";

const APPLICATION = "shop";
const VERSION = "b1b1b1b1";
const POLICY: TrustPolicy = {
  v: 1,
  issuers: [{ iss: "https://issuer.test", aud: "scafo", subjects: ["repo:acme/shop:*"] }],
};

let clock: ManualClock;

beforeEach(() => {
  clock = ctxWith(new MemoryCasStore());
});

describe("when an application came into being", () => {
  it("stamps createdAt and begins with no deployment notice and no domains", async () => {
    const created = await createApplication(clock.ctx, { name: APPLICATION });

    expect(created).toMatchObject({
      v: 1,
      name: APPLICATION,
      createdAt: new Date(CLOCK_START_MS).toISOString(),
      deployment: null,
      domains: [],
    });
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toEqual(created);
  });

  it("leaves the first stamp alone when a retried create finds it there", async () => {
    const first = await createApplication(clock.ctx, { name: APPLICATION });
    clock.tick(60_000);

    const again = await createApplication(clock.ctx, { name: APPLICATION });

    /* The name is the whole identity and creation is idempotent, so a second
       deploy into the same application must not restate when it began. */
    expect(again).toEqual(first);
  });

  it("records replicas and a selector on first creation without making them identity", async () => {
    const created = await createApplication(clock.ctx, {
      name: "placed",
      replicas: "all",
      nodeSelector: { tier: "fast" },
    });
    expect(created).toMatchObject({ replicas: "all", nodeSelector: { tier: "fast" } });

    /* Settings beyond the identity apply on first creation only, so a retried
       create stays idempotent however the application has been used since. */
    await expect(createApplication(clock.ctx, { name: "placed" })).resolves.toEqual(created);
  });

  it("lists names and records lexicographically", async () => {
    for (const name of ["zeta", APPLICATION, "alpha"]) {
      await createApplication(clock.ctx, { name });
    }

    await expect(listApplications(clock.ctx)).resolves.toEqual(["alpha", APPLICATION, "zeta"]);
    await expect(
      listApplicationRecords(clock.ctx).then((records) => records.map((record) => record.name)),
    ).resolves.toEqual(["alpha", APPLICATION, "zeta"]);
  });
});

describe("listing applications", () => {
  /* The listing every node runs on every reconcile pass, so what it costs is
     part of what it is: one listing, of the application prefix alone, however
     much history the installation has published. */
  it("reads one key per application and none of their history", async () => {
    const inner = new MemoryCasStore();
    const listed: Array<{ prefix: string; keys: string[] }> = [];
    const recording: CasStore = {
      get: (key) => inner.get(key),
      getBytes: (key, opts) => inner.getBytes(key, opts),
      put: (key, body, cas) => inner.put(key, body, cas),
      del: (key) => inner.del(key),
      list: async (prefix) => {
        const keys = await inner.list(prefix);
        listed.push({ prefix, keys });
        return keys;
      },
      listEntries: (prefix) => inner.listEntries(prefix),
    };
    const counted = countingRegistry(ctxWith(recording).ctx);
    const names = ["alpha", APPLICATION, "zeta"];
    for (const name of names) {
      await createApplication(counted.registry, { name });
      await setTrustPolicy(counted.registry, name, POLICY);
      for (let index = 0; index < 25; index++) {
        await createDeployment(counted.registry, name, { version: hex(index, 8) });
      }
      for (let index = 0; index < 40; index++) {
        await createDeployRecord(counted.registry, name, {
          id: `${name}.${hex(index, 16)}`,
          node: "node-a",
        });
      }
    }
    listed.length = 0;
    const before = counted.counts().list;

    await expect(listApplications(counted.registry)).resolves.toEqual(names);

    expect(counted.counts().list - before).toBe(1);
    expect(listed).toEqual([
      { prefix: applicationsPrefix(), keys: names.map((name) => applicationKey(name)) },
    ]);
  });

  it("ignores a key under the prefix that is not one application record", async () => {
    await createApplication(clock.ctx, { name: APPLICATION });
    for (const stray of [
      `${applicationsPrefix()}${APPLICATION}/old.json`,
      `${applicationsPrefix()}README`,
      `${applicationsPrefix()}Shop.json`,
    ]) {
      await clock.ctx.store.put(stray, "{}");
    }

    await expect(listApplications(clock.ctx)).resolves.toEqual([APPLICATION]);
  });
});

/** `value` as `width` lowercase hexadecimal characters, zero-padded. */
function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

describe("labels", () => {
  beforeEach(async () => {
    await createApplication(clock.ctx, { name: APPLICATION });
  });

  it("round-trips a map, and replaces it wholesale", async () => {
    await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme", plan: "pro" });
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      labels: { tenant: "acme", plan: "pro" },
    });

    /* REPLACES rather than merges: the caller states the whole map, so a label
       dropped downstream is gone here rather than surviving forever. */
    await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme" });
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      labels: { tenant: "acme" },
    });
  });

  it("drops the field entirely when the map is emptied", async () => {
    await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme" });

    await setApplicationLabels(clock.ctx, APPLICATION, {});

    await expect(getApplication(clock.ctx, APPLICATION)).resolves.not.toHaveProperty("labels");
  });

  it("refuses an application that is not there", async () => {
    const error = await rejectsWith(
      () => setApplicationLabels(clock.ctx, "ghost", { a: "b" }),
      "not-found",
    );

    expect(error.status).toBe(404);
  });
});

describe("blocking an application", () => {
  beforeEach(async () => {
    await createApplication(clock.ctx, { name: APPLICATION });
  });

  it("sets the flag, and clears it on the way back", async () => {
    await expect(blockApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      blocked: true,
    });
    await expect(unblockApplication(clock.ctx, APPLICATION)).resolves.not.toHaveProperty("blocked");
  });

  it("is idempotent in both directions", async () => {
    await blockApplication(clock.ctx, APPLICATION);
    await expect(blockApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      blocked: true,
    });

    await unblockApplication(clock.ctx, APPLICATION);
    /* Unblocking one that was never blocked is not an error: a downstream
       platform retrying its own dunning pass must cost nothing. */
    await expect(unblockApplication(clock.ctx, APPLICATION)).resolves.not.toHaveProperty("blocked");
  });

  it("absent means not blocked, so nothing has to be written to start serving", async () => {
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.not.toHaveProperty("blocked");
  });

  it("touches nothing else about the application", async () => {
    await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme" });
    const before = await getApplication(clock.ctx, APPLICATION);

    await blockApplication(clock.ctx, APPLICATION);
    await unblockApplication(clock.ctx, APPLICATION);

    /* The whole promise of the verb: deployment and placement state is untouched
       and so is the application's own configuration, so unblocking restores what
       was there rather than something reconstructed. */
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toEqual(before);
  });

  it("refuses an application that is not there", async () => {
    expect((await rejectionOf(() => blockApplication(clock.ctx, "ghost"))).code).toBe("not-found");
  });
});

describe("what one mutation may never take from another", () => {
  beforeEach(async () => {
    await createApplication(clock.ctx, { name: APPLICATION });
    await createDeployment(clock.ctx, APPLICATION, { version: VERSION });
  });

  it("keeps an admin's block and labels across every deploy-side update", async () => {
    await blockApplication(clock.ctx, APPLICATION);
    await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme" });

    await recordRevision(clock.ctx, APPLICATION, VERSION);
    await setReplicas(clock.ctx, APPLICATION, 3);
    await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast" });

    /* Deploys and placement settings are the busy half of this record and the
       admin half is the one that must never be lost to them: a block silently
       dropped by a deploy would put a suspended application back in service. */
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      blocked: true,
      labels: { tenant: "acme" },
      replicas: 3,
      nodeSelector: { tier: "fast" },
      deployment: { revision: 1 },
    });
  });

  it("keeps the deploy-side state across every admin update", async () => {
    await recordRevision(clock.ctx, APPLICATION, VERSION);
    await setReplicas(clock.ctx, APPLICATION, 3);
    await setNodeSelector(clock.ctx, APPLICATION, { tier: "fast" });
    const before = await getApplication(clock.ctx, APPLICATION);

    await blockApplication(clock.ctx, APPLICATION);
    await setApplicationLabels(clock.ctx, APPLICATION, { tenant: "acme" });
    await setApplicationLabels(clock.ctx, APPLICATION, {});
    await unblockApplication(clock.ctx, APPLICATION);

    /* And the other way round: an admin verb states one field and carries the
       rest of the record forward untouched, so the revision, the replica count
       and the selector survive a block that came and went. */
    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toEqual(before);
  });
});

describe("what may never change", () => {
  beforeEach(async () => {
    await createApplication(clock.ctx, { name: APPLICATION });
  });

  it("keeps v and name immutable through an update", async () => {
    const name = await rejectionOf(() =>
      updateApplication(clock.ctx, APPLICATION, (current) => ({ ...current, name: "other" })),
    );
    const version = await rejectionOf(() =>
      updateApplication(clock.ctx, APPLICATION, (current) => ({
        ...current,
        v: 2 as unknown as 1,
      })),
    );

    expect(name.code).toBe("immutable");
    expect(version.code).toBe("immutable");
  });

  it("keeps them immutable through the block verbs too", async () => {
    await blockApplication(clock.ctx, APPLICATION);

    const stored = await readJson<ApplicationRecord>(clock.ctx, applicationKey(APPLICATION));
    expect(stored?.value).toMatchObject({ v: 1, name: APPLICATION });
  });
});

describe("deployment revision", () => {
  beforeEach(async () => {
    await createApplication(clock.ctx, { name: APPLICATION });
    await createDeployment(clock.ctx, APPLICATION, { version: VERSION });
  });

  it("records only a monotonic revision and timestamp", async () => {
    const update = await recordRevision(clock.ctx, APPLICATION, VERSION);

    expect(update.application.deployment).toEqual({
      revision: 1,
      deployedAt: new Date(clock.nowMs()).toISOString(),
    });
  });

  it("commutes concurrent records into consecutive revisions", async () => {
    const successor = "bbbbbbbb";
    await createDeployment(clock.ctx, APPLICATION, { version: successor });
    const inner = clock.ctx.store;
    let collide = true;
    clock.ctx.store = {
      get: (key) => inner.get(key),
      getBytes: (key, opts) => inner.getBytes(key, opts),
      put: async (key, body, cas) => {
        if (
          collide &&
          key === applicationKey(APPLICATION) &&
          typeof body === "string" &&
          (JSON.parse(body) as { deployment?: { revision?: number } }).deployment?.revision === 1
        ) {
          collide = false;
          await recordRevision({ ...clock.ctx, store: inner }, APPLICATION, successor);
        }
        return inner.put(key, body, cas);
      },
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
      listEntries: (prefix) => inner.listEntries(prefix),
    };

    await recordRevision(clock.ctx, APPLICATION, VERSION);

    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      deployment: { revision: 2 },
    });
  });

  it("refuses malformed and exhausted revisions instead of wrapping them", async () => {
    const application = await getApplication(clock.ctx, APPLICATION);
    expect(() =>
      deploymentRevision({
        ...application,
        deployment: { revision: 0, deployedAt: application.createdAt },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    expect(() =>
      deploymentRevision({
        ...application,
        deployment: { revision: 1, deployedAt: "not-a-date" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-input" }));
    /* A record carrying no notice at all is bucket input like any other. */
    expect(() => deploymentRevision({ ...application, deployment: undefined as never })).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );

    await clock.ctx.store.put(
      applicationKey(APPLICATION),
      JSON.stringify({
        ...application,
        deployment: {
          revision: Number.MAX_SAFE_INTEGER,
          deployedAt: application.createdAt,
        },
      }),
      {},
    );
    await rejectsWith(() => recordRevision(clock.ctx, APPLICATION, VERSION), "invalid-input");
  });
});

describe("what a block does to a node", () => {
  const NODE_ID = "node-a";
  const NEIGHBOUR = "blog";
  const PLATFORM_DOMAIN = "apps.test";
  const CUSTOM_DOMAIN = "shop.example.com";

  let registry: RegistryContext;
  let app: H3;

  beforeEach(async () => {
    clock = ctxWith(new MemoryCasStore());
    registry = clock.ctx;

    await registerNode(registry, {
      v: 1,
      id: NODE_ID,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
      addresses: { internal: "10.0.0.4", apiPort: 7400 },
    });
    const lease = await acquireLease(registry, NODE_ID);
    if (lease === null) throw new Error("the fixture could not take the lease");

    for (const name of [APPLICATION, NEIGHBOUR]) {
      await createApplication(registry, { name });
      await createDeployment(registry, name, { version: VERSION });
      await recordRevision(registry, name, VERSION);
      await writePlacement(registry, name, [NODE_ID], lease);
    }
    await claimDomain(registry, CUSTOM_DOMAIN, APPLICATION);

    app = createNodeApp({
      config: daemonConfig(),
      nodeId: NODE_ID,
      registry,
      supervisor: idleSupervisor(),
      versions: TEST_VERSIONS,
    });
  });

  describe("what a node reads as its work", () => {
    it("drops a blocked application, and nobody else's", async () => {
      await blockApplication(registry, APPLICATION);

      const state = desiredFrom(await createRegistryView(registry).sync(), { nodeId: NODE_ID });

      expect(state.applications.map((entry) => entry.name)).toEqual([NEIGHBOUR]);
      expect(state.fleet.map((entry) => entry.name)).toEqual([NEIGHBOUR]);
    });

    it("keeps its placement view, which is what unblocking comes back to", async () => {
      await blockApplication(registry, APPLICATION);

      const state = desiredFrom(await createRegistryView(registry).sync(), { nodeId: NODE_ID });

      /* The block takes it out of service, not out of the fleet: the decision
         about which nodes would run it is still the coordinator's and still
         stands, so lifting the block needs no new one. */
      expect(state.placements.map((entry) => entry.application)).toContain(APPLICATION);
    });

    it("brings it all back on the next pass, from records nothing touched", async () => {
      await blockApplication(registry, APPLICATION);
      desiredFrom(await createRegistryView(registry).sync(), { nodeId: NODE_ID });

      await unblockApplication(registry, APPLICATION);
      const state = desiredFrom(await createRegistryView(registry).sync(), { nodeId: NODE_ID });

      expect(state.applications.map((entry) => entry.name).sort()).toEqual([
        NEIGHBOUR,
        APPLICATION,
      ]);
    });
  });

  describe("GET /v1/ingress/ask", () => {
    it("refuses the platform host of a blocked application", async () => {
      const before = await ask(`${APPLICATION}.${PLATFORM_DOMAIN}`);
      expect(before.status).toBe(200);

      await blockApplication(registry, APPLICATION);

      expect((await ask(`${APPLICATION}.${PLATFORM_DOMAIN}`)).status).toBe(404);
    });

    it("refuses a custom domain claimed by a blocked application", async () => {
      expect((await ask(CUSTOM_DOMAIN)).status).toBe(200);

      await blockApplication(registry, APPLICATION);

      expect((await ask(CUSTOM_DOMAIN)).status).toBe(404);
    });

    it("answers for both again once the block is lifted", async () => {
      await blockApplication(registry, APPLICATION);
      await unblockApplication(registry, APPLICATION);

      expect((await ask(CUSTOM_DOMAIN)).status).toBe(200);
      expect((await ask(`${APPLICATION}.${PLATFORM_DOMAIN}`)).status).toBe(200);
    });

    it("leaves the fleet's own apex alone, which is no application's name", async () => {
      await blockApplication(registry, APPLICATION);

      expect((await ask(PLATFORM_DOMAIN)).status).toBe(200);
    });
  });

  async function ask(domain: string): Promise<Response> {
    return app.request(`/v1/ingress/ask?domain=${domain}`);
  }

  function daemonConfig(): DaemonConfig {
    return {
      bucket: {
        endpoint: "http://store.test:9000",
        region: "us-east-1",
        bucket: "registry",
        accessKey: "key",
        secretKey: "secret",
      },
      node: { id: NODE_ID, listen: "127.0.0.1:7400" },
      platformDomains: [PLATFORM_DOMAIN],
      runtime: {
        binPath: "celld",
        portRangeStart: 42_000,
        portRangeEnd: 42_998,
        portQuarantineMs: 600_000,
        bindHost: "127.0.0.1",
      },
      observability: { enabled: false },
      api: { public: true, jsonBytes: 65_536 },
    };
  }

  function idleSupervisor(): Supervisor {
    return {
      start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
      stop: () => Promise.resolve(),
      status: () => null,
      list: (): ProcessStatus[] => [],
      forget: () => {},
      onExit: () => {},
    };
  }
});

describe("what a first deploy may state about the application it creates", () => {
  it("refuses a replica count and a selector that are not one", async () => {
    const ctx: RegistryContext = { store: new MemoryCasStore() };

    for (const replicas of [0, -1, 1.5, "many"]) {
      await expect(
        createApplication(ctx, { name: "shop", replicas: replicas as never }),
        String(replicas),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
    await expect(
      createApplication(ctx, { name: "shop", nodeSelector: { "": "x" } }),
    ).rejects.toMatchObject({ code: "invalid-input" });

    /* Refused before anything is written. */
    await expect(findApplication(ctx, "shop")).resolves.toBeNull();
  });
});
