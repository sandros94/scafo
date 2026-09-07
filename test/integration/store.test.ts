/* Store-driver conformance against a real S3-compatible endpoint. */

import { S3Client } from "uns3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordDeployment } from "../../src/core/registry/_deployment.ts";
import {
  acquireLease,
  checkDomain,
  claimDomain,
  createBuild,
  createEnvironment,
  createProject,
  getVarsetEnvelope,
  importVarsetKey,
  initRegistry,
  type LeaseHandle,
  listProjects,
  openVarset,
  probeStore,
  putVarset,
  readMeta,
  type RegistryContext,
  releaseDomain,
  renewLease,
  sealVarset,
  setEnvironmentVarset,
} from "../../src/core/registry/index.ts";
import type { CasStore } from "../../src/core/types/store.ts";
import { createUns3Store } from "../../src/drivers/store/uns3.ts";
import { rejectsWith } from "../_helpers.ts";

/* The repo types web-standard globals only, so the runner's env is read off globalThis. */
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const ENDPOINT = env.S3_ENDPOINT ?? "";
const BUCKET = env.S3_BUCKET ?? "scafo-test";
const ACCESS_KEY = env.S3_ACCESS_KEY ?? "";
const SECRET_KEY = env.S3_SECRET_KEY ?? "";
const REGION = env.S3_REGION ?? "us-east-1";

const ROUND_TRIPS = 1000;
/* Sized for a REMOTE bucket, not a local container: a real provider an ocean or
   a country away answers one operation in 100-300ms, and a thousand sequential
   round trips are a latency bill, not a conformance question. */
const SLOW_TIMEOUT_MS = 600_000;

function randomHex(bytes: number): string {
  let hex = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(bytes))) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

describe.skipIf(ENDPOINT === "")("the uns3 store against a live bucket", () => {
  let store: CasStore;
  let ctx: RegistryContext;

  beforeAll(() => {
    const client = new S3Client({
      endpoint: ENDPOINT,
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      bucketStyle: "path",
      defaultBucket: BUCKET,
    });
    store = createUns3Store(client, { bucket: BUCKET, prefix: `itest-${randomHex(8)}` });
    ctx = { store };
  });

  afterAll(async () => {
    /* Ten at a time: a run leaves a four-digit number of keys behind, and a
       remote bucket deleting them one by one outlives any reasonable hook. */
    const keys = await store.list("");
    for (let at = 0; at < keys.length; at += 10) {
      await Promise.all(
        keys.slice(at, at + 10).map(async (key) =>
          store.del(key).catch(() => {
            /* Best effort: the next run works under its own prefix anyway. */
          }),
        ),
      );
    }
  }, SLOW_TIMEOUT_MS);

  describe("conditional writes", () => {
    it("passes the six-step conformance probe", async () => {
      await expect(probeStore(store)).resolves.toBeUndefined();
    });

    it("turns a create conflict into cas-conflict", async () => {
      const key = `v1/create-${randomHex(4)}.json`;
      const created = await store.put(key, `{"n":1}`, { ifNoneMatch: "*" });
      expect(created.etag).not.toBe("");

      const error = await rejectsWith(
        () => store.put(key, `{"n":2}`, { ifNoneMatch: "*" }),
        "cas-conflict",
      );
      expect(error.status).toBe(412);
      await expect(store.get(key)).resolves.toMatchObject({ body: `{"n":1}` });
    });

    it("turns a stale If-Match into cas-conflict", async () => {
      const key = `v1/update-${randomHex(4)}.json`;
      const first = await store.put(key, `{"n":1}`);
      const second = await store.put(key, `{"n":2}`, { ifMatch: first.etag });
      expect(second.etag).not.toBe(first.etag);

      await rejectsWith(() => store.put(key, `{"n":3}`, { ifMatch: first.etag }), "cas-conflict");
      await expect(store.get(key)).resolves.toMatchObject({ body: `{"n":2}`, etag: second.etag });
    });

    it("reads back null once a key is deleted", async () => {
      const key = `v1/delete-${randomHex(4)}.json`;
      await store.put(key, `{"n":1}`);
      await store.del(key);

      await expect(store.get(key)).resolves.toBeNull();
      await expect(store.del(key)).resolves.toBeUndefined();
    });

    it("gives back a non-text body byte for byte", async () => {
      /* What an observation flush is: bytes that are not UTF-8, written and read
         without a text round trip anywhere. `get` is allowed to mangle these —
         that is what its documented decode does — and `getBytes` is not. */
      const key = `v1/bytes-${randomHex(4)}.parquet`;
      const written = new Uint8Array([0x50, 0x41, 0x52, 0x31, 0xff, 0xfe, 0x00, 0x80, 0xc0]);
      await store.put(key, written);

      await expect(store.getBytes(key)).resolves.toEqual(written);
      await expect(store.getBytes(`${key}.missing`)).resolves.toBeNull();
    });

    it("answers a ranged read with that range and nothing else", async () => {
      /* What celld asks of the bucket since 0.4.1: a bucket that ignores
         `Range` and hands back the whole object stops the runtime process. */
      const key = `v1/range-${randomHex(4)}.json`;
      await store.put(key, `{"probe":3}`);

      await expect(store.getBytes(key, { range: { start: 2, end: 6 } })).resolves.toEqual(
        new TextEncoder().encode("probe"),
      );
    });

    it("lists every key under a prefix, and nothing outside it", async () => {
      const run = randomHex(4);
      for (const name of ["b", "a", "nested/c"]) {
        await store.put(`v1/list-${run}/${name}.json`, "{}");
      }
      await store.put(`v1/list-${run}-sibling.json`, "{}");

      await expect(store.list(`v1/list-${run}/`)).resolves.toEqual([
        `v1/list-${run}/a.json`,
        `v1/list-${run}/b.json`,
        `v1/list-${run}/nested/c.json`,
      ]);
    });
  });

  describe("write-then-read round trips", () => {
    it(
      `reads back exactly what it wrote, ${String(ROUND_TRIPS)} times`,
      async () => {
        const key = `v2/roundtrip-${randomHex(4)}.json`;
        let mismatches = 0;
        let conditionalChecks = 0;

        for (let i = 0; i < ROUND_TRIPS; i++) {
          const body = `v${String(i)}-${randomHex(4)}`;
          const written = await store.put(key, body);

          const read = await store.get(key);
          if (read === null || read.body !== body || read.etag !== written.etag) mismatches++;

          if (i % 100 === 0) {
            const next = `${body}-updated`;
            const updated = await store.put(key, next, { ifMatch: written.etag });
            const readBack = await store.get(key);
            if (readBack === null || readBack.body !== next || readBack.etag !== updated.etag) {
              mismatches++;
            }
            conditionalChecks++;
          }
        }

        expect(mismatches).toBe(0);
        expect(conditionalChecks).toBe(Math.ceil(ROUND_TRIPS / 100));
      },
      SLOW_TIMEOUT_MS,
    );
  });

  describe("the coordinator lease on a real bucket", () => {
    it("hands over on expiry, with the fence going up", async () => {
      const a = await acquireLease(ctx, "node-a", { ttlMs: 100 });
      expect(a).not.toBeNull();
      const held = a as LeaseHandle;
      expect(held.lease.fence).toBe(1);

      const renewed = await renewLease(ctx, held);
      expect(renewed.lease.fence).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 150));
      const b = await acquireLease(ctx, "node-b", { ttlMs: 100 });
      expect(b).not.toBeNull();
      expect((b as LeaseHandle).lease.fence).toBe(2);

      await rejectsWith(() => renewLease(ctx, renewed), "lease-lost");
    });
  });

  describe("the registry end to end", () => {
    it(
      "bootstraps, deploys, configures and releases",
      async () => {
        const project = `smoke${randomHex(3)}`;
        const buildId = randomHex(8);
        const host = `${project}.example.test`;

        const meta = await initRegistry(ctx, { platformDomains: ["apps.example.test"] });
        expect(meta.platformDomains).toEqual(["apps.example.test"]);
        await expect(readMeta(ctx)).resolves.toMatchObject({ v: 1 });

        await createProject(ctx, { slug: project });
        await expect(listProjects(ctx)).resolves.toContain(project);

        const build = await createBuild(ctx, project, { id: buildId });
        expect(build.id).toBe(buildId);

        await createEnvironment(ctx, project, { name: "prod" });
        const flipped = await recordDeployment(ctx, project, "prod", buildId);
        expect(flipped.environment.deployment).toMatchObject({ revision: 1 });

        const key = await importVarsetKey(crypto.getRandomValues(new Uint8Array(32)));
        const sealed = await sealVarset({ TOKEN: { value: "s3cr3t", secret: true } }, key);
        await putVarset(ctx, project, sealed);
        await expect(
          openVarset(await getVarsetEnvelope(ctx, project, sealed.id), key),
        ).resolves.toEqual({ TOKEN: { value: "s3cr3t", secret: true } });

        const configured = await setEnvironmentVarset(ctx, project, "prod", sealed.id);
        expect(configured.varset).toBe(sealed.id);

        await claimDomain(ctx, host, project, "prod");
        await expect(checkDomain(ctx, host)).resolves.toMatchObject({
          project,
          environment: "prod",
        });

        await releaseDomain(ctx, host);
        await expect(checkDomain(ctx, host)).resolves.toBeNull();
      },
      SLOW_TIMEOUT_MS,
    );
  });
});
