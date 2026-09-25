/* Application-scoped operator authorization and disclosure. */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import type { DeployMeta, DeployService, DeployStatus } from "../src/daemon/deploys.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  createApplication,
  createDeployment,
  getApplication,
  heartbeatNode,
  registerNode,
} from "../src/core/registry/index.ts";
import { getOperator, listOperators } from "../src/core/registry/operators.ts";
import { deleteKey, putJson } from "../src/core/registry/cas.ts";
import { operatorKey } from "../src/core/registry/paths.ts";
import type { OperatorRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { createFileArtifactStager } from "../src/drivers/artifact/file.ts";
import { DEPLOY_METADATA_HEADER, encodeDeployMetadata } from "../src/daemon/_intake.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS } from "./_helpers.ts";

const NODE_ID = "node-a";

/** The tenant's own application, and the one next door that is none of its business. */
const MINE = "acme";
const THEIRS = "globex";
/** The three names a `shop-*` key is measured against. */
const GLOB_MATCH = "shop-preview";
const GLOB_BARE = "shop";
const GLOB_NEAR = "shopping";
const VERSION = "aaaa1111";
const OTHER_VERSION = "bbbb2222";

const ADMIN_ID = "op-admin111";
/** An operator-tier key scoped to {@link MINE} and to nothing else. */
const TENANT_ID = "op-tenant11";
/** A key filed before roles or scopes existed: no `operator` block at all. */
const LEGACY_ID = "op-legacy11";
/** An operator-tier key whose whole scope is the prefix glob `shop-*`. */
const GLOB_ID = "op-glob1111";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let node: Keypair;
let admin: Keypair;
let tenant: Keypair;
let legacy: Keypair;
let globber: Keypair;
let deploys: StubDeploys;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });
  legacy = await generateJWK("EdDSA", { kid: LEGACY_ID });
  globber = await generateJWK("EdDSA", { kid: GLOB_ID });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: node.publicKey.x },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await fileKey(ADMIN_ID, admin, { role: "admin" });
  await fileKey(TENANT_ID, tenant, { role: "operator", applications: [MINE] });
  await fileKey(LEGACY_ID, legacy);
  await fileKey(GLOB_ID, globber, { role: "operator", applications: ["shop-*"] });

  for (const name of [MINE, THEIRS, GLOB_MATCH, GLOB_BARE, GLOB_NEAR]) {
    await createApplication(clock.ctx, { name });
    for (const version of [VERSION, OTHER_VERSION]) {
      await createDeployment(clock.ctx, name, { version });
    }
    await recordRevision(clock.ctx, name, VERSION);
  }

  deploys = stubDeploys();
  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
    deploys,
    artifactStager: createFileArtifactStager(),
  });
});

describe("an operator scoped to one application cannot touch another", () => {
  it("deploys into its own application, and is refused the one next door", async () => {
    const mine = await upload(TENANT_ID, tenant, MINE);
    const theirs = await upload(TENANT_ID, tenant, THEIRS);

    expect(mine.status).toBe(202);
    expect(theirs.status).toBe(403);
    await expect(theirs.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    expect(deploys.started.map((meta) => meta.application)).toEqual([MINE]);
  });

  it("refuses the application next door before reading one artifact chunk", async () => {
    let reads = 0;
    const response = await app.request(`/v1/applications/${THEIRS}/deploys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await signNodeToken(tenant.privateKey, TENANT_ID)}`,
        [DEPLOY_METADATA_HEADER]: encodeDeployMetadata({}),
      },
      body: unreadBody(() => reads++),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(response.status).toBe(403);
    expect(reads).toBe(0);
    expect(deploys.started).toEqual([]);
  });

  it.each(applicationCalls())("runs %s on its own application", async (_what, path, init) => {
    const response = await call(pathIn(MINE, path), TENANT_ID, tenant, init);

    expect(response.status, await response.clone().text()).not.toBe(403);
  });

  it.each(applicationCalls())(
    "is refused %s on the application next door",
    async (_what, path, init) => {
      const response = await call(pathIn(THEIRS, path), TENANT_ID, tenant, init);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    },
  );

  it("changes nothing about the application it was refused", async () => {
    await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });

    expect((await getApplication(clock.ctx, THEIRS)).retiredAt).toBeUndefined();
  });

  /* The node record quotes what a failing runtime wrote to its own stderr, and
     that text belongs to the tenant whose application wrote it. */
  it("is told its own application is failing, and never reads the neighbour's words", async () => {
    await heartbeatNode(clock.ctx, NODE_ID, {
      failing: {
        [MINE]: { since: "2026-01-01T00:00:00.000Z", restarts: 4, lastError: "mine: wedged" },
        [THEIRS]: { since: "2026-01-01T00:00:00.000Z", restarts: 9, lastError: "theirs: secret" },
      },
    });

    const state = (await (
      await call("/v1/state", TENANT_ID, tenant, { method: "GET" })
    ).json()) as { node: { failing?: Record<string, unknown> } };

    expect(Object.keys(state.node.failing ?? {})).toEqual([MINE]);
    expect(JSON.stringify(state)).not.toContain("theirs: secret");
  });

  it("keeps a warm scoped key scoped after its record is revoked within the auth TTL", async () => {
    expect((await call("/v1/state", TENANT_ID, tenant, { method: "GET" })).status).toBe(200);
    await deleteKey(clock.ctx, operatorKey(TENANT_ID));

    const state = await call("/v1/state", TENANT_ID, tenant, { method: "GET" });
    const mutation = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });

    expect((await state.json()) as { scoped?: true }).toMatchObject({ scoped: true });
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });

  it("does not let revoked cached authority enroll a durable replacement", async () => {
    expect((await call("/v1/state", TENANT_ID, tenant, { method: "GET" })).status).toBe(200);
    await deleteKey(clock.ctx, operatorKey(TENANT_ID));
    const replacement = await generateJWK("EdDSA", { kid: "op-replace11" });

    const response = await enroll(TENANT_ID, tenant, publicHalf("op-replace11", replacement));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-invalid" });
    await expect(getOperator(clock.ctx, "op-replace11")).resolves.toBeNull();
  });

  it("does not let a warm old key inherit a same-id replacement's admin scope", async () => {
    expect((await call("/v1/state", TENANT_ID, tenant, { method: "GET" })).status).toBe(200);

    const replacement = await generateJWK("EdDSA", { kid: TENANT_ID });
    await fileKey(TENANT_ID, replacement, { role: "admin" });

    const foreign = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });

    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });

  it("is refused the status of a deploy that belongs to another application", async () => {
    const started = deploys.recordFor(THEIRS);

    const response = await call(`/v1/deploys/${started.id}`, TENANT_ID, tenant, { method: "GET" });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });
});

describe("an operator scoped to a PREFIX GLOB reaches what carries the prefix", () => {
  it.each(applicationCalls())("runs %s on a name under its prefix", async (_what, path, init) => {
    const response = await call(pathIn(GLOB_MATCH, path), GLOB_ID, globber, init);

    expect(response.status, await response.clone().text()).not.toBe(403);
  });

  it.each(applicationCalls())(
    "is refused %s on the bare prefix, which is a different application",
    async (_what, path, init) => {
      const response = await call(pathIn(GLOB_BARE, path), GLOB_ID, globber, init);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    },
  );

  it.each(applicationCalls())(
    "is refused %s on a name that merely starts with the same letters",
    async (_what, path, init) => {
      const response = await call(pathIn(GLOB_NEAR, path), GLOB_ID, globber, init);

      expect(response.status).toBe(403);
    },
  );

  it("deploys into a name under its prefix, and into neither of the two beside it", async () => {
    expect((await upload(GLOB_ID, globber, GLOB_MATCH)).status).toBe(202);
    expect((await upload(GLOB_ID, globber, GLOB_BARE)).status).toBe(403);
    expect((await upload(GLOB_ID, globber, GLOB_NEAR)).status).toBe(403);
    expect(deploys.started.map((meta) => meta.application)).toEqual([GLOB_MATCH]);
  });

  it("is answered a listing of the names under its prefix alone", async () => {
    const response = await call("/v1/applications", GLOB_ID, globber, { method: "GET" });
    const raw = await response.text();

    const body = JSON.parse(raw) as { applications: Array<{ name: string }>; scoped?: true };
    expect(body.applications.map((entry) => entry.name)).toEqual([GLOB_MATCH]);
    expect(body.scoped).toBe(true);
    expect(raw).not.toContain(GLOB_NEAR);
  });

  it("is answered a state document narrowed to what its prefix reaches", async () => {
    const response = await call("/v1/state", GLOB_ID, globber, { method: "GET" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ scoped: true });
  });
});

describe("what a scoped operator is told about the refusal", () => {
  it("names the application it asked for, and says the key is scoped", async () => {
    const response = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });
    const problem = (await response.json()) as { type: string; title: string; detail?: string };

    expect(problem.type).toBe("urn:scafo:auth-scope");
    expect(problem.detail).toContain(THEIRS);
    expect(problem.detail).toContain(TENANT_ID);
    expect(problem.detail).toContain("scoped");
  });

  it("NEVER names the other applications the key may reach, because those are tenants", async () => {
    await fileKey(TENANT_ID, tenant, { role: "operator", applications: [MINE, "initech"] });

    const response = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain("initech");
    expect(body).not.toContain(MINE);
  });
});

describe("every JSON control route is bounded", () => {
  it.each(["selector", "operator", "labels"] as const)(
    "%s accepts the exact cap and rejects every over-cap or malformed body without mutating",
    async (name) => {
      const spec = await jsonRoute(name);
      const exact = paddedJson(spec.accepted, 65_536);
      const oversized = paddedJson(spec.rejected, 65_537);

      const accepted = await rawJsonCall(
        spec.path,
        await signNodeToken(admin.privateKey, ADMIN_ID),
        bytes(exact),
      );
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      const standing = await spec.snapshot();

      for (const [what, body, headers] of [
        ["chunked +1", stream(bytes(oversized)), {}],
        ["false-small Content-Length", stream(bytes(oversized)), { "content-length": "1" }],
        ["malformed UTF-8", new Uint8Array([0xc3, 0x28]), {}],
        ["malformed JSON", bytes("{"), {}],
      ] as const) {
        const response = await rawJsonCall(
          spec.path,
          await signNodeToken(admin.privateKey, ADMIN_ID),
          body,
          headers,
        );
        expect(response.status, `${name}: ${what}`).toBe(what.includes("malformed") ? 400 : 413);
        expect(await spec.snapshot(), `${name}: ${what}`).toBe(standing);
      }
    },
  );
});

describe("a key that names no applications notices nothing", () => {
  it.each(applicationCalls())(
    "lets an ADMIN run %s on either application",
    async (_what, path, init) => {
      for (const application of [MINE, THEIRS]) {
        const response = await call(pathIn(application, path), ADMIN_ID, admin, init);

        expect(response.status, `${application}: ${await response.clone().text()}`).not.toBe(403);
      }
    },
  );

  it("lets an admin deploy into either application", async () => {
    for (const application of [MINE, THEIRS]) {
      expect((await upload(ADMIN_ID, admin, application)).status, application).toBe(202);
    }
  });

  it("lets a role-LESS key from before this wave reach every application", async () => {
    for (const application of [MINE, THEIRS]) {
      expect((await upload(LEGACY_ID, legacy, application)).status, application).toBe(202);
    }
  });

  it("leaves a NODE's own token alone, because a machine is never an operator", async () => {
    const response = await call(pathIn(THEIRS, "/retire"), NODE_ID, node, { method: "POST" });

    expect(response.status).toBe(200);
  });
});

describe("granting a scope through POST /v1/operators", () => {
  it("records the applications an admin enrolled a key for", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      role: "operator",
      applications: [THEIRS],
    });

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toMatchObject({
      role: "operator",
      applications: [THEIRS],
    });
  });

  it("REFUSES to scope an admin, because an admin administers the whole fleet", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      role: "admin",
      applications: [MINE],
    });

    expect(response.status).toBe(400);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:invalid-input");
    expect(problem.detail).toContain("admin");
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toBeNull();
  });

  it("a scoped operator cannot rotate itself into a wider scope", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-wider111" });

    const response = await enroll(TENANT_ID, tenant, {
      ...publicHalf("op-wider111", minted),
      supersedes: TENANT_ID,
      applications: [MINE, THEIRS],
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(getOperator(clock.ctx, "op-wider111")).resolves.toBeNull();
  });

  it("a scoped operator cannot enrol an UNSCOPED key beside itself", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-beside11" });

    const response = await enroll(TENANT_ID, tenant, publicHalf("op-beside11", minted));

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, "op-beside11")).resolves.toMatchObject({
      applications: [MINE],
    });
  });

  it("a scoped operator cannot enrol a key into a application it cannot reach itself", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-beside11" });

    const response = await enroll(TENANT_ID, tenant, {
      ...publicHalf("op-beside11", minted),
      applications: [THEIRS],
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });

  it("carries the caller's scope onto the key a rotation registers, exactly as it carries the tier", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-rotated1" });

    const response = await enroll(TENANT_ID, tenant, {
      ...publicHalf("op-rotated1", minted),
      supersedes: TENANT_ID,
    });

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, "op-rotated1")).resolves.toMatchObject({
      role: "operator",
      supersedes: TENANT_ID,
      applications: [MINE],
    });
    const refused = await call(pathIn(THEIRS, "/retire"), "op-rotated1", minted, {
      method: "POST",
    });
    expect(refused.status).toBe(403);
  });

  it("lets an admin narrow a key it is enrolling to a single application", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });
    await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      applications: [MINE],
    });

    expect((await upload("op-joiner11", joiner, MINE)).status).toBe(202);
    expect((await upload("op-joiner11", joiner, THEIRS)).status).toBe(403);
  });

  it("refuses a scope naming no application at all", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      applications: [],
    });

    expect(response.status).toBe(400);
  });

  it("refuses a scope naming something that is not a application slug", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      applications: ["Not A Slug"],
    });

    expect(response.status).toBe(400);
  });
});

/** One call as the cases below state it: a method and, where there is one, a body. */
interface Call {
  method: string;
  body?: unknown;
}

interface JsonRoute {
  path: string;
  accepted: Record<string, unknown>;
  rejected: Record<string, unknown>;
  snapshot(): Promise<string>;
}

async function jsonRoute(name: "selector" | "operator" | "labels"): Promise<JsonRoute> {
  const application = (): Promise<string> =>
    getApplication(clock.ctx, MINE).then((record) => JSON.stringify(record));
  if (name === "selector") {
    return {
      path: pathIn(MINE, "/selector"),
      accepted: { selector: { tier: "fast" } },
      rejected: { selector: { tier: "slow" } },
      snapshot: application,
    };
  }
  if (name === "labels") {
    return {
      path: `/v1/applications/${MINE}/labels`,
      accepted: { labels: { plan: "pro" } },
      rejected: { labels: { plan: "free" } },
      snapshot: application,
    };
  }

  const first = await generateJWK("EdDSA", { kid: "op-json1111" });
  const second = await generateJWK("EdDSA", { kid: "op-json2222" });
  return {
    path: "/v1/operators",
    accepted: { ...publicHalf("op-json1111", first), applications: [MINE] },
    rejected: { ...publicHalf("op-json2222", second), applications: [MINE] },
    snapshot: () => listOperators(clock.ctx).then((records) => JSON.stringify(records)),
  };
}

async function rawJsonCall(
  path: string,
  token: string,
  body: BodyInit | Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: body as BodyInit,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });
}

function paddedJson(value: Record<string, unknown>, size: number): string {
  const raw = JSON.stringify(value);
  expect(raw.length).toBeLessThanOrEqual(size);
  return raw + " ".repeat(size - raw.length);
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(value.subarray(0, 32_768));
      controller.enqueue(value.subarray(32_768));
      controller.close();
    },
  });
}

/** Every operator-authed call that names an application in its PATH. */
function applicationCalls(): Array<[string, string, Call]> {
  return [
    ["show", "", { method: "GET" }],
    ["retire", "/retire", { method: "POST" }],
    ["unretire", "/unretire", { method: "POST" }],
    ["selector", "/selector", { method: "POST", body: { selector: { tier: "fast" } } }],
    ["replicas", "/replicas", { method: "POST", body: { replicas: 2 } }],
    ["delete", "?force=1", { method: "DELETE" }],
  ];
}

/** The application route `suffix` names, for `application`. */
function pathIn(application: string, suffix: string): string {
  return `/v1/applications/${application}${suffix}`;
}

/** One call to the node, signed by `keys` for exactly this request. */
async function call(path: string, id: string, keys: Keypair, sent: Call): Promise<Response> {
  return app.request(path, {
    method: sent.method,
    headers: {
      "authorization": `Bearer ${await signNodeToken(keys.privateKey, id)}`,
      "content-type": "application/json",
    },
    ...(sent.body === undefined ? {} : { body: JSON.stringify(sent.body) }),
  });
}

/** An artifact upload naming `application`, as a deploy client sends one. */
async function upload(id: string, keys: Keypair, application: string): Promise<Response> {
  return app.request(`/v1/applications/${application}/deploys`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}`,
      [DEPLOY_METADATA_HEADER]: encodeDeployMetadata({}),
    },
    body: new Uint8Array([1, 2, 3]),
  });
}

/** One registration on `/v1/operators`, signed by `keys`. */
async function enroll(id: string, keys: Keypair, body: unknown): Promise<Response> {
  return app.request("/v1/operators", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${await signNodeToken(keys.privateKey, id)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** The public half of a keypair, as the trust route is given one. */
function publicHalf(id: string, keys: Keypair): Record<string, unknown> {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x } };
}

/** Files an operator key directly; omitting `operator` models a legacy record. */
async function fileKey(
  id: string,
  keys: Keypair,
  operator?: { role: "admin" | "operator"; applications?: string[] },
): Promise<void> {
  await putJson<OperatorRecord>(clock.ctx, operatorKey(id), {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    ...operator,
  });
}

interface StubDeploys extends DeployService {
  /** Every meta the route handed over, in order. */
  started: DeployMeta[];
  /** Records a deploy for `application` without going through the route. */
  recordFor(application: string): DeployStatus;
}

/**
 * A deploy intake that records what it was asked for and publishes nothing.
 * What is under test here is who may ask, not what an artifact becomes.
 */
function stubDeploys(): StubDeploys {
  const started: DeployMeta[] = [];
  const byId = new Map<string, DeployStatus>();
  let next = 0;

  const record = (application: string): DeployStatus => {
    next += 1;
    const status: DeployStatus = {
      /* A deploy id names the application it belongs to; a poll is authenticated
         against that application before anything is read. */
      id: `${application}.000000000000000${String(next)}`,
      application,
      state: "accepted",
    };
    byId.set(status.id, status);
    return status;
  };

  return {
    started,
    recordFor: record,
    reserve: () => ({
      application: "stub",
      signal: new AbortController().signal,
      cancel: () => {},
      discard: () => Promise.resolve(),
      enqueue: () => {
        throw new Error("stub admission consumes artifacts directly");
      },
    }),
    admit: (meta) => {
      started.push(meta);
      return Promise.resolve({
        start: (artifact) => {
          void artifact.dispose();
          return Promise.resolve(record(meta.application));
        },
      });
    },
    get: (id) => byId.get(id) ?? null,
    stop: () => Promise.resolve(),
    usage: () => ({ activeTasks: 0, queuedTasks: 0, stagedBytes: 0, applications: {} }),
  };
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
    platformDomains: ["apps.test"],
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

function unreadBody(read: () => void): ReadableStream<Uint8Array> {
  let primed = false;
  return new ReadableStream<Uint8Array>({
    pull(stream): void {
      if (!primed) {
        primed = true;
        stream.enqueue(new Uint8Array([1]));
        return;
      }
      read();
      throw new Error("sentinel artifact body was read");
    },
  });
}

/** Reports nothing and runs nothing; no route here touches a process. */
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
