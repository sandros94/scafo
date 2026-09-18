/* The whole `/v1/applications` route group as a node serves it: what each route
   reads, who may call it, and what a caller outside its scope is told. */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { type DaemonContext, createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { type Coordinator, createCoordinator } from "../src/daemon/coordinator.ts";
import { createObservability, type Observability } from "../src/daemon/observe.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  createApplication,
  findApplication,
  getApplication,
} from "../src/core/registry/applications.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { type OperatorRole, trustOperator } from "../src/core/registry/operators.ts";
import { applicationKey } from "../src/core/registry/paths.ts";
import type { ApplicationRecord, NodeRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS, urlOf } from "./_helpers.ts";

const NODE_ID = "node-a";
const PEER_ID = "node-b";
const ADMIN_ID = "op-aaaa1111";
const TENANT_ID = "op-bbbb2222";
const GLOB_ID = "op-cccc3333";

/** The tenant's own application, and the one belonging to somebody else on the fleet. */
const MINE = "acme";
const THEIRS = "zenith";

/** The three names a `shop-*` key is measured against. */
const GLOB_MATCH = "shop-preview";
const GLOB_BARE = "shop";
const GLOB_NEAR = "shopping";

/** Every application the fixture seeds, in the order a listing answers them. */
const SEEDED = [MINE, GLOB_BARE, GLOB_MATCH, GLOB_NEAR, THEIRS];

/** Where the peer says it is reached; what a forwarded request is addressed to. */
const PEER_ADDRESS = { internal: "10.0.0.5", apiPort: 7500 };

const TTL_MS = 15_000;

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

/** Body of `GET /v1/applications`. */
interface ApplicationsBody {
  applications: ApplicationRecord[];
  scoped?: true;
}

/** Body of every route that answers with one application. */
interface ApplicationBody {
  application: ApplicationRecord;
}

let clock: ManualClock;
let node: Keypair;
let peer: Keypair;
let admin: Keypair;
let tenant: Keypair;
let globber: Keypair;
let observed: Observability;
let app: H3;
/** When each seeded application was created, for asserting a record byte for byte. */
let created: Map<string, string>;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  peer = await generateJWK("EdDSA", { kid: PEER_ID });
  admin = await generateJWK("EdDSA", { kid: ADMIN_ID });
  tenant = await generateJWK("EdDSA", { kid: TENANT_ID });
  globber = await generateJWK("EdDSA", { kid: GLOB_ID });
  observed = createObservability({ enabled: true, now: () => new Date(clock.nowMs()) });

  await registerNode(clock.ctx, nodeRecord(NODE_ID, node.publicKey.x));
  await registerNode(clock.ctx, nodeRecord(PEER_ID, peer.publicKey.x));
  await trust(ADMIN_ID, admin, "admin");
  await trust(TENANT_ID, tenant, "operator", [MINE]);
  await trust(GLOB_ID, globber, "operator", ["shop-*"]);

  created = new Map();
  for (const name of SEEDED) {
    created.set(name, (await createApplication(clock.ctx, { name })).createdAt);
  }

  app = nodeApp().app;
});

describe("GET /v1/applications", () => {
  it("answers an admin every application of the fleet, unmarked", async () => {
    const body = await listing(await asKey(ADMIN_ID, admin));

    expect(body.applications.map((entry) => entry.name)).toEqual(SEEDED);
    expect(body.scoped).toBeUndefined();
  });

  it("reports the block flag, which is what a listing is read for", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));

    const body = await listing(await asKey(ADMIN_ID, admin));

    expect(body.applications.find((entry) => entry.name === MINE)?.blocked).toBe(true);
    expect(body.applications.find((entry) => entry.name === THEIRS)).not.toHaveProperty("blocked");
  });

  it("narrows a scoped caller to what its key reaches, and marks the answer", async () => {
    const response = await app.request("/v1/applications", {
      headers: await asKey(TENANT_ID, tenant),
    });
    const raw = await response.text();

    expect(response.status).toBe(200);
    const body = JSON.parse(raw) as ApplicationsBody;
    expect(body.applications.map((entry) => entry.name)).toEqual([MINE]);
    expect(body.scoped).toBe(true);

    expect(raw).not.toContain(THEIRS);
  });

  it("narrows a PREFIX GLOB to the names that carry the prefix and no others", async () => {
    const response = await app.request("/v1/applications", {
      headers: await asKey(GLOB_ID, globber),
    });
    const raw = await response.text();

    const body = JSON.parse(raw) as ApplicationsBody;
    expect(body.applications.map((entry) => entry.name)).toEqual([GLOB_MATCH]);
    expect(body.scoped).toBe(true);

    /* The prefix is a boundary, not a substring search: neither the bare name
       nor the one that merely starts with the same letters is in reach. */
    expect(raw).not.toContain(GLOB_NEAR);
  });

  it("REDACTS the labels from a scoped caller, because they are not the tenant's", async () => {
    await label(MINE, { account: "acct-4417", client: "Northwind Ltd" });

    const response = await app.request("/v1/applications", {
      headers: await asKey(TENANT_ID, tenant),
    });
    const raw = await response.text();

    const body = JSON.parse(raw) as ApplicationsBody;
    expect(body.applications.map((entry) => entry.name)).toEqual([MINE]);
    expect(body.applications[0]).not.toHaveProperty("labels");

    expect(raw).not.toContain("acct-4417");
    expect(raw).not.toContain("Northwind");
  });

  it("STRIPS the field rather than emptying it, so absent keeps one spelling", async () => {
    await label(MINE, { account: "acct-4417" });

    const body = await listing(await asKey(TENANT_ID, tenant));

    expect(body.applications[0]).not.toHaveProperty("labels");
    expect(JSON.stringify(body.applications[0])).toBe(
      JSON.stringify({
        v: 1,
        name: MINE,
        createdAt: createdAtOf(MINE),
        deployment: null,
        domains: [],
      }),
    );
  });

  it("keeps them for an ADMIN, which is who they are for", async () => {
    await label(MINE, { account: "acct-4417" });

    const body = await listing(await asKey(ADMIN_ID, admin));

    expect(body.applications.find((entry) => entry.name === MINE)?.labels).toEqual({
      account: "acct-4417",
    });
  });

  it("still shows a scoped caller the BLOCK flag, which is their own application's state", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));

    const body = await listing(await asKey(TENANT_ID, tenant));

    expect(body.applications[0]?.blocked).toBe(true);
  });
});

describe("GET /v1/applications/:name", () => {
  it("answers an admin the record as it stands, labels included", async () => {
    await label(MINE, { account: "acct-4417" });

    const response = await app.request(`/v1/applications/${MINE}`, {
      headers: await asKey(ADMIN_ID, admin),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ApplicationBody;
    expect(body.application.name).toBe(MINE);
    expect(body.application.labels).toEqual({ account: "acct-4417" });
  });

  it("STRIPS the labels for a non-admin the application belongs to", async () => {
    await label(MINE, { account: "acct-4417" });

    const response = await app.request(`/v1/applications/${MINE}`, {
      headers: await asKey(TENANT_ID, tenant),
    });
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect((JSON.parse(raw) as ApplicationBody).application).not.toHaveProperty("labels");
    expect(raw).not.toContain("acct-4417");
  });

  it("refuses a name outside the caller's scope and says nothing about it", async () => {
    const foreign = await show(THEIRS, await asKey(TENANT_ID, tenant));
    const absent = await show("no-such-application", await asKey(TENANT_ID, tenant));

    expect([foreign.status, absent.status]).toEqual([403, 403]);
    const [named, unnamed] = [await problemText(foreign), await problemText(absent)];
    expect(named.replace(THEIRS, "X")).toBe(unnamed.replace("no-such-application", "X"));
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    const response = await show("nothing", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/applications/:name/block", () => {
  it("blocks and unblocks for an admin, answering the record as it now stands", async () => {
    const blocked = await block(MINE, await asKey(ADMIN_ID, admin));
    expect(blocked.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({ blocked: true });

    const lifted = await unblock(MINE, await asKey(ADMIN_ID, admin));
    expect(lifted.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("is idempotent over the wire, both ways", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));
    expect((await block(MINE, await asKey(ADMIN_ID, admin))).status).toBe(200);

    await unblock(MINE, await asKey(ADMIN_ID, admin));
    expect((await unblock(MINE, await asKey(ADMIN_ID, admin))).status).toBe(200);
  });

  it("REFUSES an operator-tier key, even for an application it reaches", async () => {
    const response = await block(MINE, await asKey(TENANT_ID, tenant));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("blocked");
  });

  it("refuses a scoped key for an application it does not reach, telling it NOTHING", async () => {
    const foreign = await block(THEIRS, await asKey(TENANT_ID, tenant));
    const absent = await block("no-such-application", await asKey(TENANT_ID, tenant));

    expect([foreign.status, absent.status]).toEqual([403, 403]);
    const [named, unnamed] = [await problemText(foreign), await problemText(absent)];
    expect(named.replace(THEIRS, "X")).toBe(unnamed.replace("no-such-application", "X"));

    await expect(
      block(THEIRS, await asKey(TENANT_ID, tenant)).then((r) => r.json()),
    ).resolves.toMatchObject({ title: "Beyond this key's applications" });
    await expect(
      block(MINE, await asKey(TENANT_ID, tenant)).then((r) => r.json()),
    ).resolves.toMatchObject({ title: "Only an admin administers an application" });
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    const response = await block("nothing", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/applications/:name/labels", () => {
  it("replaces the map for an admin", async () => {
    const response = await label(MINE, { tenant: "acme", plan: "pro" });

    expect(response.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({
      labels: { tenant: "acme", plan: "pro" },
    });
  });

  it("REFUSES an operator-tier key", async () => {
    const response = await app.request(`/v1/applications/${MINE}/labels`, {
      method: "POST",
      headers: { ...(await asKey(TENANT_ID, tenant)), "content-type": "application/json" },
      body: JSON.stringify({ labels: { tenant: "acme" } }),
    });

    expect(response.status).toBe(403);
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("labels");
  });

  it("refuses a body that is not a map of strings", async () => {
    const response = await label(MINE, { tenant: 7 } as unknown as Record<string, string>);

    expect(response.status).toBe(400);
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    const response = await label("nothing", { tenant: "acme" });

    expect(response.status).toBe(404);
  });
});

describe("the two boundaries the route group stands behind", () => {
  /* Reading an application and deciding what the fleet says about one are an
     operator's, and a machine of the installation is not one. */
  const operatorOnly: Array<[name: string, method: string, path: (n: string) => string]> = [
    ["the listing", "GET", () => "/v1/applications"],
    ["one application", "GET", (n) => `/v1/applications/${n}`],
    ["blocking", "POST", (n) => `/v1/applications/${n}/block`],
    ["unblocking", "POST", (n) => `/v1/applications/${n}/unblock`],
    ["labelling", "POST", (n) => `/v1/applications/${n}/labels`],
  ];

  for (const [what, method, path] of operatorOnly) {
    it(`refuses a NODE token on ${what}`, async () => {
      const response = await app.request(path(MINE), {
        method,
        headers: { ...(await asKey(NODE_ID, node)), "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ labels: {} }) }),
      });

      expect(response.status).toBe(403);
    });
  }

  /* Changing or deleting one answers a peer as well: a node forwards a deletion
     to whichever node coordinates, under its own token. */
  const peerRoutes: Array<[name: string, method: string, path: string, body?: unknown]> = [
    ["retirement", "POST", `/v1/applications/${MINE}/retire`],
    ["unretirement", "POST", `/v1/applications/${MINE}/unretire`],
    ["the selector", "POST", `/v1/applications/${MINE}/selector`, { selector: { tier: "edge" } }],
    ["the replica count", "POST", `/v1/applications/${MINE}/replicas`, { replicas: 2 }],
    ["deletion", "DELETE", `/v1/applications/${MINE}?force=1`],
  ];

  for (const [what, method, path, body] of peerRoutes) {
    it(`accepts a NODE token on ${what}`, async () => {
      const response = await app.request(path, {
        method,
        headers: { ...(await asKey(NODE_ID, node)), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      expect(response.status).toBe(200);
    });

    it(`accepts an OPERATOR token in scope on ${what}`, async () => {
      const response = await app.request(path, {
        method,
        headers: { ...(await asKey(TENANT_ID, tenant)), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      expect(response.status).toBe(200);
    });

    it(`refuses an out-of-scope OPERATOR token on ${what}, and discloses nothing`, async () => {
      const foreign = await app.request(path.replace(MINE, THEIRS), {
        method,
        headers: { ...(await asKey(TENANT_ID, tenant)), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const absent = await app.request(path.replace(MINE, "no-such-application"), {
        method,
        headers: { ...(await asKey(TENANT_ID, tenant)), "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      expect([foreign.status, absent.status]).toEqual([403, 403]);
      const [named, unnamed] = [await problemText(foreign), await problemText(absent)];
      expect(named.replace(THEIRS, "X")).toBe(unnamed.replace("no-such-application", "X"));
      /* Refused before anything was read: the application is untouched. */
      await expect(findApplication(clock.ctx, THEIRS)).resolves.not.toBeNull();
    });
  }
});

describe("POST /v1/applications/:name/retire", () => {
  it("retires and unretires, answering the record as it now stands", async () => {
    const retired = await peerPost(`/v1/applications/${MINE}/retire`);
    expect(retired.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.toHaveProperty("retiredAt");

    const back = await peerPost(`/v1/applications/${MINE}/unretire`);
    expect(back.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("retiredAt");
  });

  it("keeps the first stamp, so a retry does not restart the grace", async () => {
    const first = (await (
      await peerPost(`/v1/applications/${MINE}/retire`)
    ).json()) as ApplicationBody;
    clock.tick(60_000);
    const again = (await (
      await peerPost(`/v1/applications/${MINE}/retire`)
    ).json()) as ApplicationBody;

    expect(again.application.retiredAt).toBe(first.application.retiredAt);
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    expect((await peerPost("/v1/applications/nothing/retire")).status).toBe(404);
  });
});

describe("POST /v1/applications/:name/selector", () => {
  it("states which nodes may serve it", async () => {
    const response = await peerPost(`/v1/applications/${MINE}/selector`, {
      selector: { tier: "edge" },
    });

    expect(response.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({
      nodeSelector: { tier: "edge" },
    });
  });

  it("clears the constraint with null, removing the field rather than emptying it", async () => {
    await peerPost(`/v1/applications/${MINE}/selector`, { selector: { tier: "edge" } });

    const response = await peerPost(`/v1/applications/${MINE}/selector`, { selector: null });

    expect(response.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("nodeSelector");
  });

  it("refuses a body that states no selector at all", async () => {
    expect((await peerPost(`/v1/applications/${MINE}/selector`, {})).status).toBe(400);
  });
});

describe("POST /v1/applications/:name/replicas", () => {
  it("records a whole number of nodes", async () => {
    const response = await peerPost(`/v1/applications/${MINE}/replicas`, { replicas: 2 });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ApplicationBody;
    expect(body.application.replicas).toBe(2);
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({ replicas: 2 });
  });

  it('records "all", which is every node that may serve it', async () => {
    const response = await peerPost(`/v1/applications/${MINE}/replicas`, { replicas: "all" });

    expect(response.status).toBe(200);
    await expect(getApplication(clock.ctx, MINE)).resolves.toMatchObject({ replicas: "all" });
  });

  for (const replicas of [0, -1, 1.5, "two", "ALL", true, []] as const) {
    it(`refuses ${JSON.stringify(replicas)}, which names no number of nodes`, async () => {
      const response = await peerPost(`/v1/applications/${MINE}/replicas`, { replicas });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:invalid-input" });
      await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("replicas");
    });
  }

  it("refuses a body that states no count, rather than assuming one", async () => {
    const response = await peerPost(`/v1/applications/${MINE}/replicas`, {});

    expect(response.status).toBe(400);
    await expect(getApplication(clock.ctx, MINE)).resolves.not.toHaveProperty("replicas");
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    const response = await peerPost("/v1/applications/nothing/replicas", { replicas: 2 });

    expect(response.status).toBe(404);
  });
});

describe("DELETE /v1/applications/:name", () => {
  it("deletes on the spot when this node is the one coordinating", async () => {
    const { app: self, coordinator } = nodeApp();
    await coordinator.runOnce();

    const response = await self.request(`/v1/applications/${MINE}?force=1`, {
      method: "DELETE",
      headers: await asKey(ADMIN_ID, admin),
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { deleted: string[] }).toMatchObject({
      deleted: expect.arrayContaining([applicationKey(MINE)]),
    });
    await expect(findApplication(clock.ctx, MINE)).resolves.toBeNull();
  });

  it("refuses an application that is neither retired nor forced", async () => {
    const { app: self, coordinator } = nodeApp();
    await coordinator.runOnce();

    const response = await self.request(`/v1/applications/${MINE}`, {
      method: "DELETE",
      headers: await asKey(ADMIN_ID, admin),
    });

    expect(response.status).toBe(409);
    await expect(findApplication(clock.ctx, MINE)).resolves.not.toBeNull();
  });

  it("FORWARDS to the node holding the lease, which carries the deletion out", async () => {
    const hops: Array<{ url: string; method: string; authorization: string; proxied: string }> = [];
    const coordinating = nodeApp({ nodeId: PEER_ID, keys: peer });
    await coordinating.coordinator.runOnce();

    const toPeer: typeof fetch = async (input, init) => {
      const url = new URL(urlOf(input));
      const headers = new Headers(init?.headers);
      hops.push({
        url: url.href,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? "",
        proxied: headers.get("x-scafo-proxied") ?? "",
      });
      return coordinating.app.request(`${url.pathname}${url.search}`, init);
    };
    const asking = nodeApp({ fetchFn: toPeer });

    const caller = await asKey(ADMIN_ID, admin);
    const response = await asking.app.request(`/v1/applications/${MINE}?force=1`, {
      method: "DELETE",
      headers: caller,
    });

    /* The peer's answer is the answer, and the application really is gone. */
    expect(response.status).toBe(200);
    expect((await response.json()) as { deleted: string[] }).toMatchObject({
      deleted: expect.arrayContaining([applicationKey(MINE)]),
    });
    await expect(findApplication(clock.ctx, MINE)).resolves.toBeNull();

    /* One hop, to where the peer says it is reached, marked as a hop and
       speaking as the asking node rather than passing the caller's token on. */
    expect(hops).toHaveLength(1);
    expect(hops[0]?.url).toBe(
      `http://${PEER_ADDRESS.internal}:${String(PEER_ADDRESS.apiPort)}/v1/applications/${MINE}?force=1`,
    );
    expect(hops[0]?.method).toBe("DELETE");
    expect(hops[0]?.proxied).not.toBe("");
    expect(hops[0]?.authorization).not.toBe(caller.authorization);
  });

  it("refuses a forwarded request that landed on a node coordinating nothing", async () => {
    const coordinating = nodeApp({ nodeId: PEER_ID, keys: peer });
    await coordinating.coordinator.runOnce();
    const asking = nodeApp();

    /* Already forwarded once, and this node does not hold the lease either: it
       is refused rather than passed on, so no request circles the mesh. */
    const response = await asking.app.request(`/v1/applications/${MINE}?force=1`, {
      method: "DELETE",
      headers: { ...(await asKey(NODE_ID, node)), "x-scafo-proxied": "1" },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:draining" });
    await expect(findApplication(clock.ctx, MINE)).resolves.not.toBeNull();
  });
});

describe("what the fleet records about it", () => {
  it("emits the audit pair for a block and for the way back", async () => {
    await block(MINE, await asKey(ADMIN_ID, admin));
    await unblock(MINE, await asKey(ADMIN_ID, admin));

    expect(auditEvents()).toEqual([
      { type: "application.blocked", actor: ADMIN_ID, application: MINE },
      { type: "application.unblocked", actor: ADMIN_ID, application: MINE },
    ]);
  });

  it("records nothing for a refused attempt", async () => {
    await block(MINE, await asKey(TENANT_ID, tenant));

    expect(auditEvents()).toEqual([]);
  });
});

/* ----------------------------------------------------------------- fixtures */

async function block(application: string, headers: Record<string, string>): Promise<Response> {
  return app.request(`/v1/applications/${application}/block`, { method: "POST", headers });
}

async function unblock(application: string, headers: Record<string, string>): Promise<Response> {
  return app.request(`/v1/applications/${application}/unblock`, { method: "POST", headers });
}

async function show(application: string, headers: Record<string, string>): Promise<Response> {
  return app.request(`/v1/applications/${application}`, { headers });
}

/** Replaces an application's labels as the admin they belong to. */
async function label(application: string, labels: Record<string, string>): Promise<Response> {
  return app.request(`/v1/applications/${application}/labels`, {
    method: "POST",
    headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
    body: JSON.stringify({ labels }),
  });
}

/** A write to one of the routes a node may call, made as the admin. */
async function peerPost(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { ...(await asKey(ADMIN_ID, admin)), "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** When the fixture created an application, as its own record records it. */
function createdAtOf(name: string): string | undefined {
  return created.get(name);
}

/** A refusal as its whole problem document, for comparing two of them. */
async function problemText(response: Response): Promise<string> {
  return JSON.stringify(await response.json());
}

async function listing(headers: Record<string, string>): Promise<ApplicationsBody> {
  const response = await app.request("/v1/applications", { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as ApplicationsBody;
}

async function trust(
  id: string,
  keys: Keypair,
  role: OperatorRole,
  applications?: string[],
): Promise<void> {
  await trustOperator(clock.ctx, {
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role,
    ...(applications === undefined ? {} : { applications }),
  });
}

async function asKey(id: string, keys: Keypair): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}` };
}

/** The audit lines the node recorded, stripped of what every event carries. */
function auditEvents(): Array<Record<string, unknown>> {
  return observed
    .snapshot()
    .events.filter((entry) => entry.type.startsWith("application."))
    .map(({ at: _at, ...rest }) => rest);
}

interface NodeUnderTest {
  app: H3;
  coordinator: Coordinator;
}

/** A node of this installation, with a coordinator loop it drives itself. */
function nodeApp(opts?: {
  nodeId?: string;
  keys?: Keypair;
  fetchFn?: typeof fetch;
}): NodeUnderTest {
  const nodeId = opts?.nodeId ?? NODE_ID;
  const daemon: DaemonContext = {
    config: daemonConfig(nodeId),
    nodeId,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
    signingKey: (opts?.keys ?? node).privateKey,
    observability: observed,
    ...(opts?.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  };
  const coordinator = createCoordinator(daemon, { ttlMs: TTL_MS, reapIntervalMs: 0 });
  daemon.coordinator = coordinator;

  return { app: createNodeApp(daemon), coordinator };
}

function nodeRecord(id: string, x: string): NodeRecord {
  return {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x },
    addresses: { ...PEER_ADDRESS },
  };
}

function daemonConfig(nodeId: string): DaemonConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: nodeId, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
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
