/*
 * `/v1/projects`: the projects of a fleet, read and administered through a node.
 *
 * The write verbs here are ADMIN-ONLY, and that is the whole posture of the
 * surface. Blocking a project is a full stop — it refuses serving, deploys and
 * wakes at once — so it is the fleet's decision about a tenant rather than the
 * tenant's about itself. An operator-tier key that reaches the project in every
 * other way is refused here, because the alternative is a tenant who can lift
 * the block that was put on them.
 *
 * The READ verb is scoped like every other listing on this API: an operator-tier
 * caller sees the projects its key reaches and nothing else, marked `scoped` so
 * a client cannot read a filtered answer as the whole fleet.
 */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createObservability, type Observability } from "../src/daemon/observe.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import { createProject, getProject } from "../src/core/registry/projects.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import type { ProjectRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const ADMIN_ID = "op-aaaa1111";
const TENANT_ID = "op-bbbb2222";
const VERSION = "0.0.0-test";

/** The tenant's own project, and the one belonging to somebody else on the fleet. */
const MINE = "acme";
const THEIRS = "zenith";

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

/** Body of the read and write routes here. */
interface ProjectsResult {
  projects: ProjectRecord[];
  scoped?: true;
}

let clock: ManualClock;
let admin: Keypair;
let tenant: Keypair;
let observed: Observability;
let app: H3;
/** When each seeded project was created, for asserting a record byte for byte. */
let created: Map<string, string | undefined>;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });
  observed = createObservability({ enabled: true, now: () => new Date(clock.nowMs()) });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: admin.publicKey.x },
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await trust(ADMIN_ID, admin, "admin");
  await trust(TENANT_ID, tenant, "operator", [MINE]);

  created = new Map();
  for (const slug of [MINE, THEIRS]) {
    created.set(slug, (await createProject(clock.ctx, { slug })).createdAt);
  }

  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
    observability: observed,
  });
});

describe("GET /v1/projects", () => {
  it("answers an admin every project of the fleet, unmarked", async () => {
    const body = await listing(await asKey(ADMIN_ID, admin));

    expect(body.projects.map((entry) => entry.slug)).toEqual([MINE, THEIRS]);
    /* An admin is not a tenant: nothing was hidden, so nothing says it was. */
    expect(body.scoped).toBeUndefined();
  });

  it("reports the block flag, which is what a listing is read for", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));

    const body = await listing(await asKey(ADMIN_ID, admin));

    expect(body.projects.find((entry) => entry.slug === MINE)?.blocked).toBe(true);
    expect(body.projects.find((entry) => entry.slug === THEIRS)).not.toHaveProperty("blocked");
  });

  it("narrows a scoped caller to what its key reaches, and marks the answer", async () => {
    const response = await app.request("/v1/projects", { headers: await asKey(TENANT_ID, tenant) });
    const raw = await response.text();

    expect(response.status).toBe(200);
    const body = JSON.parse(raw) as ProjectsResult;
    expect(body.projects.map((entry) => entry.slug)).toEqual([MINE]);
    expect(body.scoped).toBe(true);

    /*
     * ASSERTED ON THE SERIALIZED BODY, not on the parsed shape. A tenant list is
     * exactly what a multi-tenant fleet hands out by accident, and a foreign slug
     * that survived anywhere in the document — in a record, in a count, in a
     * field nobody thought about — is the leak this route exists to not be.
     */
    expect(raw).not.toContain(THEIRS);
  });

  it("REDACTS the labels from a scoped caller, because they are not the tenant's", async () => {
    await app.request(`/v1/projects/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { account: "acct-4417", client: "Northwind Ltd" } }),
    });

    const response = await app.request("/v1/projects", { headers: await asKey(TENANT_ID, tenant) });
    const raw = await response.text();

    /*
     * THE READ SIDE HAS TO MATCH THE WRITE SIDE. Labels are admin-only to write
     * precisely because they are the PLATFORM's notes about a tenant — a billing
     * account, a client's real name, and on the dunning path that this whole
     * verb exists for, quite possibly a note about why this tenant is about to
     * be blocked. Handing them back on the read would publish every one of those
     * to the tenant they are about.
     */
    const body = JSON.parse(raw) as ProjectsResult;
    expect(body.projects.map((entry) => entry.slug)).toEqual([MINE]);
    expect(body.projects[0]).not.toHaveProperty("labels");

    /* Asserted on the SERIALIZED body too, in the enumeration-regression style:
       a value that survived anywhere in the document is the leak. */
    expect(raw).not.toContain("acct-4417");
    expect(raw).not.toContain("Northwind");
  });

  it("STRIPS the field rather than emptying it, so absent keeps one spelling", async () => {
    await app.request(`/v1/projects/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { account: "acct-4417" } }),
    });

    const body = await listing(await asKey(TENANT_ID, tenant));

    /* An empty map would be a second way of writing "no labels", and a client
       that learned to read one would misread the other. A labelled project and
       an unlabelled one are byte-identical here. */
    expect(body.projects[0]).not.toHaveProperty("labels");
    expect(JSON.stringify(body.projects[0])).toBe(
      JSON.stringify({ v: 1, slug: MINE, placement: "auto", createdAt: createdAtOf(MINE) }),
    );
  });

  it("keeps them for an ADMIN, which is who they are for", async () => {
    await app.request(`/v1/projects/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { account: "acct-4417" } }),
    });

    const body = await listing(await asKey(ADMIN_ID, admin));

    expect(body.projects.find((entry) => entry.slug === MINE)?.labels).toEqual({
      account: "acct-4417",
    });
  });

  it("still shows a scoped caller the BLOCK flag, which is their own project's state", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));

    const body = await listing(await asKey(TENANT_ID, tenant));

    /* Not redacted, and it must not be: it is their project, they are already
       living the refusals it causes, and hiding it would leave them debugging a
       deploy that fails for no visible reason. */
    expect(body.projects[0]?.blocked).toBe(true);
  });

  it("refuses a machine's own token, like every other operator surface", async () => {
    const response = await app.request("/v1/projects", {
      headers: await asKey(NODE_ID, admin),
    });

    expect(response.status).toBe(403);
  });
});

describe("POST /v1/projects/:project/block", () => {
  it("blocks and unblocks for an admin, answering the record as it now stands", async () => {
    const blocked = await block(MINE, await asKey(ADMIN_ID, admin));
    expect(blocked.status).toBe(200);
    await expect(getProject(clock.ctx, MINE)).resolves.toMatchObject({ blocked: true });

    const lifted = await unblock(MINE, await asKey(ADMIN_ID, admin));
    expect(lifted.status).toBe(200);
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("is idempotent over the wire, both ways", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));
    expect((await block(MINE, await asKey(ADMIN_ID, admin))).status).toBe(200);

    await unblock(MINE, await asKey(ADMIN_ID, admin));
    expect((await unblock(MINE, await asKey(ADMIN_ID, admin))).status).toBe(200);
  });

  it("REFUSES an operator-tier key, even for a project it reaches", async () => {
    const response = await block(MINE, await asKey(TENANT_ID, tenant));

    /*
     * The key reaches this project for every other verb — it deploys to it, it
     * retires its environments — and it may not stop it. A block is the fleet's
     * decision about a tenant, so a tenant able to lift their own would be no
     * block at all.
     */
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("refuses a scoped key for a project it does not reach, telling it NOTHING about it", async () => {
    const foreign = await block(THEIRS, await asKey(TENANT_ID, tenant));
    const absent = await block("no-such-project", await asKey(TENANT_ID, tenant));

    /*
     * THE SCOPE REFUSAL COMES FIRST, and this is what that buys. A caller
     * outside the project's scope meets the ordinary out-of-scope boundary and
     * learns only that its key does not reach the name IT named — not that the
     * project exists, not that it is blocked, not that blocking is a thing an
     * admin does here. A project that is really there and one that never was
     * are the same answer, word for word.
     */
    expect([foreign.status, absent.status]).toEqual([403, 403]);
    const [named, unnamed] = [await problemText(foreign), await problemText(absent)];
    expect(named.replace(THEIRS, "X")).toBe(unnamed.replace("no-such-project", "X"));

    /* And it is the SCOPE refusal rather than the tier one, which is what a
       caller inside the project's scope meets instead — telling the two apart
       is telling "there is a project here you may not stop" from "there is no
       project of yours by that name". */
    await expect(
      block(THEIRS, await asKey(TENANT_ID, tenant)).then((r) => r.json()),
    ).resolves.toMatchObject({ title: "Beyond this key's projects" });
    await expect(
      block(MINE, await asKey(TENANT_ID, tenant)).then((r) => r.json()),
    ).resolves.toMatchObject({ title: "Only an admin administers a project" });
  });

  it("answers not-found for a project this fleet does not hold", async () => {
    const response = await block("nothing", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/projects/:project/labels", () => {
  it("replaces the map for an admin", async () => {
    const response = await app.request(`/v1/projects/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { tenant: "acme", plan: "pro" } }),
    });

    expect(response.status).toBe(200);
    await expect(getProject(clock.ctx, MINE)).resolves.toMatchObject({
      labels: { tenant: "acme", plan: "pro" },
    });
  });

  it("REFUSES an operator-tier key", async () => {
    const response = await app.request(`/v1/projects/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(TENANT_ID, tenant)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { tenant: "acme" } }),
    });

    expect(response.status).toBe(403);
    await expect(getProject(clock.ctx, MINE)).resolves.not.toHaveProperty("labels");
  });

  it("refuses a body that is not a map of strings", async () => {
    const response = await app.request(`/v1/projects/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { tenant: 7 } }),
    });

    expect(response.status).toBe(400);
  });
});

describe("what the fleet records about it", () => {
  it("emits the audit pair for a block and for the way back", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));
    await unblock(MINE, await asKey(ADMIN_ID, admin));

    expect(auditEvents()).toEqual([
      { type: "project.blocked", actor: ADMIN_ID, project: MINE },
      { type: "project.unblocked", actor: ADMIN_ID, project: MINE },
    ]);
  });

  it("records nothing for a refused attempt", async () => {
    await block(MINE, await asKey(TENANT_ID, tenant));

    expect(auditEvents()).toEqual([]);
  });
});

/* ---------------------------------------------------------------- fixtures */

async function block(project: string, headers: Record<string, string>): Promise<Response> {
  return app.request(`/v1/projects/${project}/block`, { method: "POST", headers });
}

async function unblock(project: string, headers: Record<string, string>): Promise<Response> {
  return app.request(`/v1/projects/${project}/unblock`, { method: "POST", headers });
}

/** When the fixture created a project, as its own record records it. */
function createdAtOf(slug: string): string | undefined {
  return created.get(slug);
}

/** A refusal as its whole problem document, for comparing two of them. */
async function problemText(response: Response): Promise<string> {
  return JSON.stringify(await response.json());
}

async function listing(headers: Record<string, string>): Promise<ProjectsResult> {
  const response = await app.request("/v1/projects", { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as ProjectsResult;
}

async function trust(
  id: string,
  keys: Keypair,
  role: OperatorRole,
  projects?: string[],
): Promise<void> {
  await trustOperator(clock.ctx, {
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role,
    ...(projects === undefined ? {} : { projects }),
  });
}

async function asKey(id: string, keys: Keypair): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}` };
}

/** The audit lines the node recorded, stripped of what every event carries. */
function auditEvents(): Array<Record<string, unknown>> {
  return observed
    .snapshot()
    .events.filter((entry) => entry.type.startsWith("project."))
    .map(({ at: _at, ...rest }) => rest);
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
    onExit: () => {},
  };
}
