/* The whole `/v1/applications` route group as a node serves it: what each route
   reads, who may call it, and what a caller outside its scope is told. */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
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
import { checkDomain } from "../src/core/registry/domains.ts";
import { createDeployment } from "../src/core/registry/deployments.ts";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { renderFleetRouting } from "../src/core/placement/fleet-routes.ts";
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

/** The platform domain the fixture's node serves, and a host outside it. */
const PLATFORM_DOMAIN = "apps.test";
const HOST = "shop.example.com";

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

/** Body of the two routes that claim and release a host. */
interface DomainBody extends ApplicationBody {
  host: string;
  platformHosts: string[];
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
    ["claiming a domain", "POST", (n) => `/v1/applications/${n}/domains/${HOST}`],
    ["releasing a domain", "DELETE", (n) => `/v1/applications/${n}/domains/${HOST}`],
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

describe("the domain routes", () => {
  it("claims a host for an admin, mirrors it, and says where it points", async () => {
    const response = await claim(MINE, HOST, await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(200);
    const body = (await response.json()) as DomainBody;
    expect(body.host).toBe(HOST);
    expect(body.application.domains).toEqual([HOST]);
    /* The platform hosts the claim is an addition to, which is what an operator
       points the new name at. */
    expect(body.platformHosts).toEqual([`${MINE}.${PLATFORM_DOMAIN}`]);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ application: MINE });
  });

  it("lets a scoped OPERATOR claim and release its own application's host", async () => {
    const claimed = await claim(MINE, HOST, await asKey(TENANT_ID, tenant));
    expect(claimed.status).toBe(200);

    const released = await release(MINE, HOST, await asKey(TENANT_ID, tenant));
    expect(released.status).toBe(200);
    expect(((await released.json()) as DomainBody).application.domains).toEqual([]);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("stores the host as DNS reads it, whatever casing the path carried", async () => {
    const response = await claim(MINE, "Shop.Example.COM", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(200);
    expect(((await response.json()) as DomainBody).host).toBe(HOST);
    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([HOST]);
  });

  it("refuses an out-of-scope OPERATOR exactly as the sibling setters do", async () => {
    const foreign = await claim(THEIRS, HOST, await asKey(TENANT_ID, tenant));
    const absent = await claim("no-such-application", HOST, await asKey(TENANT_ID, tenant));

    expect([foreign.status, absent.status]).toEqual([403, 403]);
    const [named, unnamed] = [await problemText(foreign), await problemText(absent)];
    expect(named.replace(THEIRS, "X")).toBe(unnamed.replace("no-such-application", "X"));
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("refuses a WORKLOAD token, which is the one thing a deploy pipeline holds", async () => {
    /* Whatever a CI job presents, it is not an operator key of this fleet, and
       this group stands behind the operator guard: taking a domain is never
       something a pipeline can do with the token it deploys with. */
    const workload = await signJws(
      { iss: "https://issuer.test", sub: "repo:acme/shop:ref:refs/heads/main", aud: "scafo" },
      (await generateJWK("EdDSA", { kid: "ci" })).privateKey,
      { alg: "EdDSA" },
    );

    const response = await claim(MINE, HOST, { authorization: `Bearer ${workload}` });

    expect(response.status).toBe(401);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("gives the first claim of the installation to whoever made it", async () => {
    expect((await claim(THEIRS, HOST, await asKey(ADMIN_ID, admin))).status).toBe(200);

    const response = await claim(MINE, HOST, await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(409);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:reference-held");
    /* An admin reaches every application, so it reads which one holds it. */
    expect(problem.detail).toContain(THEIRS);
    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([]);
  });

  it("NEVER names the holder to a caller whose key does not reach it", async () => {
    expect((await claim(THEIRS, HOST, await asKey(ADMIN_ID, admin))).status).toBe(200);

    const response = await claim(MINE, HOST, await asKey(TENANT_ID, tenant));
    const raw = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(raw)).toMatchObject({ type: "urn:scafo:reference-held" });
    expect(raw).not.toContain(THEIRS);
    expect(raw).toContain("another application");
  });

  it("refuses a host that belongs to this installation's own domains", async () => {
    for (const host of [`${MINE}.${PLATFORM_DOMAIN}`, PLATFORM_DOMAIN, `a.b.${PLATFORM_DOMAIN}`]) {
      const response = await claim(MINE, host, await asKey(ADMIN_ID, admin));

      expect(response.status, host).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:invalid-input" });
    }
    expect((await getApplication(clock.ctx, MINE)).domains).toEqual([]);
  });

  it("refuses a host that is no host at all, saying which rule it broke", async () => {
    const response = await claim(MINE, "shop_1.example.com", await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(400);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:invalid-input");
    expect(problem.detail).toContain("letters, digits and hyphens");
  });

  it("refuses a claim for a BLOCKED application and still lets one go", async () => {
    await claim(MINE, HOST, await asKey(ADMIN_ID, admin));
    await block(MINE, await asKey(ADMIN_ID, admin));

    const refused = await claim(MINE, "other.example.com", await asKey(ADMIN_ID, admin));
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      type: "urn:scafo:application-blocked",
    });

    const released = await release(MINE, HOST, await asKey(ADMIN_ID, admin));
    expect(released.status).toBe(200);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });

  it("refuses to release a host another application holds, and leaves it there", async () => {
    await claim(THEIRS, HOST, await asKey(ADMIN_ID, admin));

    const response = await release(MINE, HOST, await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(404);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ application: THEIRS });
  });

  it("answers not-found for an application this fleet does not hold", async () => {
    const response = await claim("nothing", HOST, await asKey(ADMIN_ID, admin));

    expect(response.status).toBe(404);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();
  });
});

describe("a claim made with the one label below its host", () => {
  /** The environment of `acme` that `preview.shop.example.com` names. */
  const FAMILY = `${MINE}-preview`;
  const SUB = `preview.${HOST}`;
  /** A key scoped to the application AND its environments, which `--wildcard` needs. */
  const WIDE_ID = "op-dddd4444";
  let wide: Keypair;

  beforeEach(async () => {
    wide = await generateJWK("EdDSA", { kid: WIDE_ID });
    await trust(WIDE_ID, wide, "operator", [MINE, `${MINE}-*`]);
    await createApplication(clock.ctx, { name: FAMILY });
  });

  it("records it on the claim and on the application when an admin asks", async () => {
    const response = await claim(MINE, HOST, await asKey(ADMIN_ID, admin), { wildcard: true });

    expect(response.status).toBe(200);
    expect(((await response.json()) as DomainBody).application.wildcardDomains).toEqual([HOST]);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ wildcard: true });
  });

  it("takes a key that reaches the environments too, and refuses one that does not", async () => {
    /* The tenant's key reaches "acme" exactly. Claiming a host WITH its
       subdomains also decides what "acme-<env>" answers on, so it takes a key
       enrolment would let reach those — the same coverage rule, asked here. */
    const refused = await claim(MINE, HOST, await asKey(TENANT_ID, tenant), { wildcard: true });

    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(checkDomain(clock.ctx, HOST)).resolves.toBeNull();

    /* The same key claims the host on its own without any of that. */
    expect((await claim(MINE, HOST, await asKey(TENANT_ID, tenant))).status).toBe(200);
    await expect(checkDomain(clock.ctx, HOST)).resolves.not.toHaveProperty("wildcard");

    const allowed = await claim(MINE, HOST, await asKey(WIDE_ID, wide), { wildcard: true });
    expect(allowed.status).toBe(200);
    await expect(checkDomain(clock.ctx, HOST)).resolves.toMatchObject({ wildcard: true });
  });

  it("keeps a host under it for the holder's own family, and refuses everyone else", async () => {
    await claim(MINE, HOST, await asKey(ADMIN_ID, admin), { wildcard: true });

    expect((await claim(FAMILY, SUB, await asKey(ADMIN_ID, admin))).status).toBe(200);

    const refused = await claim(THEIRS, `shop.${HOST}`, await asKey(ADMIN_ID, admin));
    expect(refused.status).toBe(409);
    const problem = (await refused.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:reference-held");
    /* An admin reaches every application, so it reads which one encloses it. */
    expect(problem.detail).toContain(MINE);
    expect(problem.detail).toContain(HOST);
  });

  it("NEVER names the enclosing holder to a caller whose key does not reach it", async () => {
    await claim(THEIRS, HOST, await asKey(ADMIN_ID, admin), { wildcard: true });

    const response = await claim(MINE, SUB, await asKey(TENANT_ID, tenant));
    const raw = await response.text();

    expect(response.status).toBe(409);
    expect(JSON.parse(raw)).toMatchObject({ type: "urn:scafo:reference-held" });
    expect(raw).not.toContain(THEIRS);
    /* The host that stands in the way is the caller's own business; who holds
       it is not. */
    expect(raw).toContain(HOST);
    expect(raw).toContain("another application");
  });

  it("refuses the wildcard while an outsider holds a host under it, naming that host", async () => {
    await claim(THEIRS, SUB, await asKey(ADMIN_ID, admin));

    const admins = await claim(MINE, HOST, await asKey(ADMIN_ID, admin), { wildcard: true });
    expect(admins.status).toBe(409);
    expect(((await admins.json()) as { detail?: string }).detail).toContain(THEIRS);

    const scoped = await claim(MINE, HOST, await asKey(WIDE_ID, wide), { wildcard: true });
    const raw = await scoped.text();
    expect(scoped.status).toBe(409);
    expect(raw).not.toContain(THEIRS);
    expect(raw).toContain(SUB);
  });

  describe("the certificate ask", () => {
    beforeEach(async () => {
      for (const name of [MINE, FAMILY]) {
        await createDeployment(clock.ctx, name, { version: "aaaa1111" });
        await recordRevision(clock.ctx, name, "aaaa1111");
      }
      await claim(MINE, HOST, await asKey(ADMIN_ID, admin), { wildcard: true });
    });

    it("approves the base and a subdomain naming a serving application, and nothing else", async () => {
      const asked = async (host: string): Promise<number> =>
        (await app.request(`/v1/ingress/ask?domain=${host}`)).status;

      /* Rule 1 and rule 2: names this installation can name. */
      expect(await asked(HOST)).toBe(200);
      expect(await asked(SUB)).toBe(200);
      /* Rule 3 is served from the holder's process and gets NO certificate of
         its own: issuance per unknown subdomain is how a stranger would burn
         the CA's weekly limit for somebody else's domain. */
      expect(await asked(`anything.${HOST}`)).toBe(404);
      /* And a wildcard covers one label, so a deeper name is nobody's. */
      expect(await asked(`a.b.${HOST}`)).toBe(404);
    });

    it("stops approving the subdomain once its application stops being served", async () => {
      expect((await app.request(`/v1/ingress/ask?domain=${SUB}`)).status).toBe(200);

      await block(FAMILY, await asKey(ADMIN_ID, admin));

      expect((await app.request(`/v1/ingress/ask?domain=${SUB}`)).status).toBe(404);
      expect((await app.request(`/v1/ingress/ask?domain=${HOST}`)).status).toBe(200);
    });
  });
});

describe("what a claim changes about what the fleet answers on", () => {
  /** A live node of the fixture, serving the application the claim is for. */
  const serving = (): NodeRecord => ({
    ...nodeRecord(NODE_ID, node.publicKey.x),
    heartbeatAt: new Date(clock.nowMs()).toISOString(),
    serving: { [MINE]: { port: 42_010 } },
  });

  beforeEach(async () => {
    await createDeployment(clock.ctx, MINE, { version: "aaaa1111" });
    await recordRevision(clock.ctx, MINE, "aaaa1111");
  });

  it("routes the host while it is claimed, and stops routing it once it is not", async () => {
    await claim(MINE, HOST, await asKey(ADMIN_ID, admin));

    const claimed = renderFleetRouting({
      platformDomains: [PLATFORM_DOMAIN],
      applications: [await getApplication(clock.ctx, MINE)],
      nodes: [serving()],
      now: new Date(clock.nowMs()),
    });
    /* The claimed host answers exactly where the platform host does: one
       application, one set of upstreams, two names. */
    expect(claimed.routes.map((route) => route.host)).toEqual([`${MINE}.${PLATFORM_DOMAIN}`, HOST]);
    expect(claimed.routes.map((route) => route.upstreams)).toEqual([
      [{ node: NODE_ID, address: "10.0.0.5:42010" }],
      [{ node: NODE_ID, address: "10.0.0.5:42010" }],
    ]);

    await release(MINE, HOST, await asKey(ADMIN_ID, admin));

    const released = renderFleetRouting({
      platformDomains: [PLATFORM_DOMAIN],
      applications: [await getApplication(clock.ctx, MINE)],
      nodes: [serving()],
      now: new Date(clock.nowMs()),
    });
    expect(released.routes.map((route) => route.host)).toEqual([`${MINE}.${PLATFORM_DOMAIN}`]);
  });

  it("says yes to the certificate ask while it is claimed, and no once it is released", async () => {
    const before = await app.request(`/v1/ingress/ask?domain=${HOST}`);
    expect(before.status).toBe(404);

    await claim(MINE, HOST, await asKey(ADMIN_ID, admin));
    const asked = await app.request(`/v1/ingress/ask?domain=${HOST}`);
    expect(asked.status).toBe(200);

    await release(MINE, HOST, await asKey(ADMIN_ID, admin));
    const after = await app.request(`/v1/ingress/ask?domain=${HOST}`);
    expect(after.status).toBe(404);
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

/** Claims `host` for an application, as whoever the headers name. */
async function claim(
  application: string,
  host: string,
  headers: Record<string, string>,
  opts?: { wildcard?: boolean },
): Promise<Response> {
  const query = opts?.wildcard === true ? "?wildcard=1" : "";
  return app.request(`/v1/applications/${application}/domains/${host}${query}`, {
    method: "POST",
    headers,
  });
}

/** The same host, released. */
async function release(
  application: string,
  host: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request(`/v1/applications/${application}/domains/${host}`, {
    method: "DELETE",
    headers,
  });
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
