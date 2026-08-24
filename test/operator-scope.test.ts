/*
 * PROJECT-SCOPED OPERATORS: the multi-tenancy layer, on the wire.
 *
 * A `TrustedOperator` may carry a list of project slugs. Absent means every
 * project, which is what every key of every installation older than this wave
 * carries — so a fleet nobody has scoped behaves exactly as it did. Present
 * means those projects and no others, and the node API is where that is
 * enforced: at the point an operator-authed request NAMES a project.
 *
 * The scenario the whole thing exists for is the first describe below: a
 * platform hands a tenant an operator key, the tenant deploys and administers
 * their own project through it, and every route that names somebody else's is a
 * 403 that does not even tell them which other projects exist.
 *
 * The app is invoked through its fetch interface, so nothing binds a socket, and
 * the deploy intake is a stand-in — what is under test is authorization, not
 * what an artifact turns into.
 */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import type { DeployMeta, DeployService, DeployStatus } from "../src/daemon/deploys.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  createBuild,
  createEnvironment,
  createProject,
  flipAlias,
  getEnvironment,
  registerNode,
} from "../src/core/registry/index.ts";
import { getOperator } from "../src/core/registry/operators.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const VERSION = "0.0.0-test";

/** The tenant's own project, and the one next door that is none of its business. */
const MINE = "acme";
const THEIRS = "globex";
const ENVIRONMENT = "prod";
const PREVIEW = "preview";
const BUILD = "aaaa1111";
const OTHER_BUILD = "bbbb2222";

const ADMIN_ID = "op-admin111";
/** An operator-tier key scoped to {@link MINE} and to nothing else. */
const TENANT_ID = "op-tenant11";
/** A key filed before roles or scopes existed: no `operator` block at all. */
const LEGACY_ID = "op-legacy11";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let node: Keypair;
let admin: Keypair;
let tenant: Keypair;
let legacy: Keypair;
let deploys: StubDeploys;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });
  legacy = await generateJWK("EdDSA", { kid: LEGACY_ID });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: node.publicKey.x },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await fileKey(ADMIN_ID, admin, { role: "admin" });
  await fileKey(TENANT_ID, tenant, { role: "operator", projects: [MINE] });
  await fileKey(LEGACY_ID, legacy);

  for (const project of [MINE, THEIRS]) {
    await createProject(clock.ctx, { slug: project });
    await createEnvironment(clock.ctx, project, { name: ENVIRONMENT });
    await createEnvironment(clock.ctx, project, { name: PREVIEW, ephemeral: true });
    for (const id of [BUILD, OTHER_BUILD]) {
      await createBuild(clock.ctx, project, { id, runtimeConfigurable: true });
    }
    await flipAlias(clock.ctx, project, ENVIRONMENT, BUILD);
  }

  deploys = stubDeploys();
  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
    deploys,
  });
});

describe("an operator scoped to one project cannot touch another", () => {
  it("deploys into its own project, and is refused the one next door", async () => {
    const mine = await upload(TENANT_ID, tenant, MINE);
    const theirs = await upload(TENANT_ID, tenant, THEIRS);

    expect(mine.status).toBe(202);
    expect(theirs.status).toBe(403);
    await expect(theirs.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    /* And the refusal happened BEFORE anything was published, which is the only
       version of this that is worth anything. */
    expect(deploys.started.map((meta) => meta.project)).toEqual([MINE]);
  });

  it.each(environmentCalls())("runs %s on its own project", async (_what, path, init) => {
    const response = await call(pathIn(MINE, path), TENANT_ID, tenant, init);

    expect(response.status, await response.clone().text()).not.toBe(403);
  });

  it.each(environmentCalls())(
    "is refused %s on the project next door",
    async (_what, path, init) => {
      const response = await call(pathIn(THEIRS, path), TENANT_ID, tenant, init);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    },
  );

  it("changes nothing about the environment it was refused", async () => {
    await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });

    expect((await getEnvironment(clock.ctx, THEIRS, ENVIRONMENT)).retiredAt).toBeUndefined();
  });

  it("is refused the status of a deploy that belongs to another project", async () => {
    const started = deploys.recordFor(THEIRS);

    const response = await call(`/v1/deploys/${started.id}`, TENANT_ID, tenant, { method: "GET" });

    /* An id is only ever authenticated against the project of the deploy it
       belongs to, so a scoped key is refused there exactly as it is at intake. */
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });

  it("is refused a flip on another project's environment", async () => {
    const response = await call("/v1/aliases", TENANT_ID, tenant, {
      method: "POST",
      body: { project: THEIRS, environment: ENVIRONMENT, build: OTHER_BUILD },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });

  it("flips its own project's environment, which is the same call one project over", async () => {
    const response = await call("/v1/aliases", TENANT_ID, tenant, {
      method: "POST",
      body: { project: MINE, environment: ENVIRONMENT, build: OTHER_BUILD },
    });

    expect(response.status).toBe(200);
  });
});

describe("what a scoped operator is told about the refusal", () => {
  it("names the project it asked for, and says the key is scoped", async () => {
    const response = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });
    const problem = (await response.json()) as { type: string; title: string; detail?: string };

    expect(problem.type).toBe("urn:scafo:auth-scope");
    expect(problem.detail).toContain(THEIRS);
    expect(problem.detail).toContain(TENANT_ID);
    expect(problem.detail).toContain("scoped");
  });

  it("NEVER names the other projects the key may reach, because those are tenants", async () => {
    /* The whole point of handing a tenant an operator key rather than a bucket
       credential is that the tenant learns nothing about the fleet it is on.
       A refusal that enumerated the key's own list would be the leak. */
    await fileKey(TENANT_ID, tenant, { role: "operator", projects: [MINE, "initech"] });

    const response = await call(pathIn(THEIRS, "/retire"), TENANT_ID, tenant, { method: "POST" });
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).not.toContain("initech");
    expect(body).not.toContain(MINE);
  });
});

describe("a key that names no projects notices nothing", () => {
  it.each(environmentCalls())(
    "lets an ADMIN run %s on either project",
    async (_what, path, init) => {
      for (const project of [MINE, THEIRS]) {
        const response = await call(pathIn(project, path), ADMIN_ID, admin, init);

        expect(response.status, `${project}: ${await response.clone().text()}`).not.toBe(403);
      }
    },
  );

  it("lets an admin deploy into either project", async () => {
    for (const project of [MINE, THEIRS]) {
      expect((await upload(ADMIN_ID, admin, project)).status, project).toBe(202);
    }
  });

  it("lets a role-LESS key from before this wave reach every project", async () => {
    /* Absent scope is every project, exactly as an absent role is admin: an
       upgrade must never silently take an installation's operators away from
       the projects they were already deploying to. */
    for (const project of [MINE, THEIRS]) {
      expect((await upload(LEGACY_ID, legacy, project)).status, project).toBe(202);
    }
  });

  it("leaves a NODE's own token alone, because a machine is never an operator", async () => {
    const response = await call(pathIn(THEIRS, "/retire"), NODE_ID, node, { method: "POST" });

    expect(response.status).toBe(200);
  });
});

describe("granting a scope through POST /v1/operators", () => {
  it("records the projects an admin enrolled a key for", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      role: "operator",
      projects: [THEIRS],
    });

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, "op-joiner11")).resolves.toMatchObject({
      role: "operator",
      projects: [THEIRS],
    });
  });

  it("REFUSES to scope an admin, because an admin administers the whole fleet", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      role: "admin",
      projects: [MINE],
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
      projects: [MINE, THEIRS],
    });

    /* The escalation this closes: rotation is the one registration an
       operator-tier key may make for itself, so a rotation that could widen a
       scope would make every scope advisory. */
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(getOperator(clock.ctx, "op-wider111")).resolves.toBeNull();
  });

  it("a scoped operator cannot enrol an UNSCOPED key beside itself", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-beside11" });

    /* No `projects` in the body at all, which for an unscoped caller means
       every project. A scoped caller's registration inherits the caller's own
       scope instead, so the omission is not a way out of one. */
    const response = await enroll(TENANT_ID, tenant, publicHalf("op-beside11", minted));

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, "op-beside11")).resolves.toMatchObject({
      projects: [MINE],
    });
  });

  it("a scoped operator cannot enrol a key into a project it cannot reach itself", async () => {
    const minted = await generateJWK("EdDSA", { kid: "op-beside11" });

    const response = await enroll(TENANT_ID, tenant, {
      ...publicHalf("op-beside11", minted),
      projects: [THEIRS],
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
      projects: [MINE],
    });
    /* And the new key is scoped on the WIRE, not only in the record. */
    const refused = await call(pathIn(THEIRS, "/retire"), "op-rotated1", minted, {
      method: "POST",
    });
    expect(refused.status).toBe(403);
  });

  it("lets an admin narrow a key it is enrolling to a single project", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });
    await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      projects: [MINE],
    });

    expect((await upload("op-joiner11", joiner, MINE)).status).toBe(202);
    expect((await upload("op-joiner11", joiner, THEIRS)).status).toBe(403);
  });

  it("refuses a scope naming no project at all", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      projects: [],
    });

    expect(response.status).toBe(400);
  });

  it("refuses a scope naming something that is not a project slug", async () => {
    const joiner = await generateJWK("EdDSA", { kid: "op-joiner11" });

    const response = await enroll(ADMIN_ID, admin, {
      ...publicHalf("op-joiner11", joiner),
      projects: ["Not A Slug"],
    });

    expect(response.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ helpers */

/** One call as the cases below state it: a method and, where there is one, a body. */
interface Call {
  method: string;
  body?: unknown;
}

/** Every operator-authed call that names a project in its PATH. */
function environmentCalls(): Array<[string, string, Call]> {
  return [
    ["retire", "/retire", { method: "POST" }],
    ["unretire", "/unretire", { method: "POST" }],
    ["selector", "/selector", { method: "POST", body: { selector: { tier: "fast" } } }],
    ["park", "/park", { method: "POST", body: { policy: null } }],
    ["split", "/split", { method: "POST", body: { split: null } }],
    /* The deletion is lease-gated and this app coordinates nothing, so what an
       allowed caller gets here is the coordinator's absence — which is exactly
       the point: it is not a 403, and it was decided AFTER the scope check. */
    ["delete", "", { method: "DELETE" }],
  ];
}

/** The environment route `suffix` names, inside `project`. */
function pathIn(project: string, suffix: string): string {
  return `/v1/environments/${project}/${ENVIRONMENT}${suffix}`;
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

/** An artifact upload naming `project`, as a deploy client sends one. */
async function upload(id: string, keys: Keypair, project: string): Promise<Response> {
  const form = new FormData();
  form.set("meta", JSON.stringify({ project, runtimeConfigurable: false }));
  form.set("artifact", new Blob([new Uint8Array([1, 2, 3])]), "artifact.tar.zst");

  return app.request("/v1/deploys", {
    method: "POST",
    headers: { authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}` },
    body: form,
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

/**
 * Files a key as an operator's, straight into the registry. With no `operator`
 * block at all it is the record every installation older than this wave holds.
 */
async function fileKey(
  id: string,
  keys: Keypair,
  operator?: { role: "admin" | "operator"; projects?: string[] },
): Promise<void> {
  await registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: "operator", apiPort: 0 },
    ...(operator === undefined ? {} : { operator }),
  });
}

interface StubDeploys extends DeployService {
  /** Every meta the route handed over, in order. */
  started: DeployMeta[];
  /** Records a deploy for `project` without going through the route. */
  recordFor(project: string): DeployStatus;
}

/**
 * A deploy intake that records what it was asked for and publishes nothing.
 * What is under test here is who may ask, not what an artifact becomes.
 */
function stubDeploys(): StubDeploys {
  const started: DeployMeta[] = [];
  const byId = new Map<string, DeployStatus>();
  let next = 0;

  const record = (project: string): DeployStatus => {
    next += 1;
    const status: DeployStatus = {
      id: `000000000000000${String(next)}`,
      project,
      state: "accepted",
      warnings: [],
    };
    byId.set(status.id, status);
    return status;
  };

  return {
    started,
    recordFor: record,
    start: (meta) => {
      started.push(meta);
      return Promise.resolve(record(meta.project));
    },
    get: (id) => byId.get(id) ?? null,
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
      probePath: "/",
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
      pointerHoldMs: 3_000,
    },
    observability: { enabled: false },
    api: { public: true },
  };
}

/** Reports nothing and runs nothing; no route here touches a process. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: (): ProcessStatus[] => [],
    onExit: () => {},
  };
}
