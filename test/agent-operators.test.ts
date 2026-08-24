/*
 * `/v1/operators`: the surface an operator administers a fleet's trusted keys
 * through, and the only routes of the API that a NODE's own token cannot reach.
 *
 * Everything else authenticated accepts any key the registry holds, because a
 * node calling a peer and an operator calling a node are the same kind of caller
 * there. Key administration is not: a node agent that has been taken over must
 * not be able to add an operator to the installation that runs it, so these
 * routes ask what the verified id IS as well as that it signed. A node's token
 * authenticates and is then refused — `auth-scope`, which is authorization —
 * while a workload's OIDC token is not a node token at all and never reaches
 * that question.
 *
 * The app is invoked through its fetch interface, so nothing binds a socket.
 */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { beforeEach, describe, expect, it } from "vitest";
import { createAgentApp } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { createObservability, type Observability } from "../src/agent/observe.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  getOperator,
  listOperators,
  type OperatorRole,
  type TrustedOperator,
} from "../src/core/registry/operators.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const OPERATOR_ID = "op-aaaa1111";
const SECOND_ID = "op-bbbb2222";
const THIRD_ID = "op-cccc3333";
const FOURTH_ID = "op-dddd4444";
const VERSION = "0.0.0-test";

/** Every problem body a caller that did not authenticate may see. */
const AUTH_INVALID_PROBLEM = {
  type: "urn:scafo:auth-invalid",
  title: "Authentication failed",
  status: 401,
};

type Keypair = { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };

let clock: ManualClock;
let node: Keypair;
let operator: Keypair;
let observed: Observability;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  operator = await generateJWK("EdDSA", { kid: OPERATOR_ID });
  observed = createObservability({ enabled: true, now: () => new Date(clock.nowMs()) });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: node.publicKey.x },
    addresses: { internal: "10.0.0.4", agentPort: 7400 },
  });
  /* Role-LESS on purpose: it is what every key an older installation trusts
     looks like, and it must read as an admin. The tiered cases below file
     their own keys explicitly. */
  await trust(OPERATOR_ID, operator);

  app = createAgentApp({
    config: agentConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
    observability: observed,
  });
});

describe("GET /v1/operators", () => {
  it("answers every key the fleet trusts, in id order", async () => {
    await trust(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }));

    const response = await app.request("/v1/operators", { headers: await asOperator() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { operators: TrustedOperator[] };
    expect(body.operators.map((entry) => entry.id)).toEqual([OPERATOR_ID, SECOND_ID]);
    /* The public half is read back, so a caller can tell WHICH key landed rather
       than only that an id is trusted. */
    expect(body.operators[0]?.publicKey.x).toBe(operator.publicKey.x);
  });
});

describe("the tier a listing shows", () => {
  it("names each key's role, the compat one included", async () => {
    await trustAs(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }), "operator");

    const body = (await listing(await asOperator())) as { operators: TrustedOperator[] };

    expect(body.operators.map((entry) => [entry.id, entry.role])).toEqual([
      [OPERATOR_ID, "admin"],
      [SECOND_ID, "operator"],
    ]);
  });

  it("lets an operator-tier caller list, because rotation's confirm step needs it", async () => {
    const junior = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, junior, "operator");

    const response = await app.request("/v1/operators", {
      headers: await asKey(SECOND_ID, junior),
    });

    expect(response.status).toBe(200);
  });
});

describe("what tier a POST may grant", () => {
  const grants: Array<[OperatorRole, OperatorRole, number]> = [
    ["admin", "admin", 200],
    ["admin", "operator", 200],
    ["operator", "operator", 200],
    ["operator", "admin", 403],
  ];

  it.each(grants)("a %s registering a %s is answered %i", async (caller, wanted, status) => {
    const callerKeys = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, callerKeys, caller);
    const minted = await generateJWK("EdDSA", { kid: THIRD_ID });

    const response = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asKey(SECOND_ID, callerKeys)), "content-type": "application/json" },
      body: JSON.stringify({ ...publicHalf(THIRD_ID, minted), role: wanted }),
    });

    expect(response.status).toBe(status);
    if (status === 200) {
      await expect(getOperator(clock.ctx, THIRD_ID)).resolves.toMatchObject({ role: wanted });
    } else {
      /* Authorization, not authentication: the caller proved which key it holds,
         so there is nothing left to withhold and the refusal names the rule. */
      const problem = (await response.json()) as { type: string; detail?: string };
      expect(problem.type).toBe("urn:scafo:auth-scope");
      expect(await getOperator(clock.ctx, THIRD_ID)).toBeNull();
    }
  });

  it("defaults a registration to the operator tier, which is least privilege", async () => {
    await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify(publicHalf(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }))),
    });

    /* Even from an admin: a key is added at the lowest tier unless the caller
       said otherwise, so an extra deploy key is never a second administrator. */
    await expect(getOperator(clock.ctx, SECOND_ID)).resolves.toMatchObject({ role: "operator" });
  });

  it("gives a key that supersedes the caller the CALLER's tier, which is what a rotation needs", async () => {
    const junior = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, junior, "operator");

    await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asKey(SECOND_ID, junior)), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(THIRD_ID, await generateJWK("EdDSA", { kid: THIRD_ID })),
        supersedes: SECOND_ID,
      }),
    });

    /* A replacement inherits what it replaces — never more, because the caller's
       own tier is the ceiling either way. */
    await expect(getOperator(clock.ctx, THIRD_ID)).resolves.toMatchObject({
      role: "operator",
      supersedes: SECOND_ID,
    });
  });

  it("REFUSES a lineage naming anyone but the caller", async () => {
    const junior = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, junior, "operator");

    const response = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asKey(SECOND_ID, junior)), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(THIRD_ID, await generateJWK("EdDSA", { kid: THIRD_ID })),
        supersedes: OPERATOR_ID,
      }),
    });

    /* Otherwise lineage would be an escalation: a key claiming to supersede an
       admin would be authorized to revoke that admin. */
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    expect(await getOperator(clock.ctx, THIRD_ID)).toBeNull();
  });

  it("refuses a role that is not one of the two tiers", async () => {
    const response = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID })),
        role: "root",
      }),
    });

    expect(response.status).toBe(400);
  });
});

describe("who a DELETE may take away", () => {
  it("lets an admin revoke another operator's key", async () => {
    await trustAs(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }), "operator");

    const response = await app.request(`/v1/operators/${SECOND_ID}`, {
      method: "DELETE",
      headers: await asOperator(),
    });

    expect(response.status).toBe(200);
    expect(await getOperator(clock.ctx, SECOND_ID)).toBeNull();
  });

  it("lets an operator-tier key revoke the one its own record supersedes", async () => {
    await trustAs(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }), "operator");
    const heir = await generateJWK("EdDSA", { kid: THIRD_ID });
    await trustAs(THIRD_ID, heir, "operator", SECOND_ID);

    const response = await app.request(`/v1/operators/${SECOND_ID}`, {
      method: "DELETE",
      headers: await asKey(THIRD_ID, heir),
    });

    /* The contract half of a rotation, and the only removal an operator-tier
       key is ever authorized to make. */
    expect(response.status).toBe(200);
    expect(await getOperator(clock.ctx, SECOND_ID)).toBeNull();
  });

  it("REFUSES an operator-tier key revoking one it does not supersede", async () => {
    const junior = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, junior, "operator");
    await trustAs(THIRD_ID, await generateJWK("EdDSA", { kid: THIRD_ID }), "operator");

    const response = await app.request(`/v1/operators/${THIRD_ID}`, {
      method: "DELETE",
      headers: await asKey(SECOND_ID, junior),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
    await expect(getOperator(clock.ctx, THIRD_ID)).resolves.toBeDefined();
  });

  it("REFUSES a lineage whose removal would leave the fleet with no admin at all", async () => {
    /*
     * The one way an authorized removal could still strand a fleet: the only
     * admin deliberately registers an operator-tier successor, which is then
     * entitled by lineage to revoke it. Allowed by the tier rules, refused by
     * the registry — nothing would be able to grant an admin afterwards.
     */
    const heir = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, heir, "operator", OPERATOR_ID);

    const response = await app.request(`/v1/operators/${OPERATOR_ID}`, {
      method: "DELETE",
      headers: await asKey(SECOND_ID, heir),
    });

    expect(response.status).toBe(409);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:reference-held");
    expect(problem.detail).toContain("admin");
    await expect(getOperator(clock.ctx, OPERATOR_ID)).resolves.toMatchObject({ role: "admin" });
  });

  it("refuses an admin revoking its own key before it ever asks about tiers", async () => {
    await trustAs(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }), "operator");

    const response = await app.request(`/v1/operators/${OPERATOR_ID}`, {
      method: "DELETE",
      headers: await asOperator(),
    });

    /* Self-revocation is the one removal nothing could verify afterwards, so it
       is refused whatever the caller's tier — and it is checked first, which is
       why this is a 400 rather than the registry's last-admin 409. */
    expect(response.status).toBe(400);
    await expect(getOperator(clock.ctx, OPERATOR_ID)).resolves.toMatchObject({ role: "admin" });
  });
});

describe("the escalation this whole shape exists to stop", () => {
  it("a stolen operator key cannot lock the admins out", async () => {
    /*
     * The state before this wave: every trusted key was equal, so ONE stolen
     * deploy key could revoke every other operator and own the fleet. What the
     * tiers buy is that the same theft now reaches nothing above itself.
     */
    const stolen = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, stolen, "operator");
    const colleague = await generateJWK("EdDSA", { kid: THIRD_ID });
    await trustAs(THIRD_ID, colleague, "operator");
    const headers = (): Promise<Record<string, string>> => asKey(SECOND_ID, stolen);

    /* It can add keys — but only at its own tier. */
    const escalated = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await headers()), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(FOURTH_ID, await generateJWK("EdDSA", { kid: FOURTH_ID })),
        role: "admin",
      }),
    });
    expect(escalated.status).toBe(403);

    /* It cannot revoke the admin that could revoke IT. */
    const againstAdmin = await app.request(`/v1/operators/${OPERATOR_ID}`, {
      method: "DELETE",
      headers: await headers(),
    });
    expect(againstAdmin.status).toBe(403);

    /* Nor an unrelated operator, so no colleague is locked out either. */
    const againstPeer = await app.request(`/v1/operators/${THIRD_ID}`, {
      method: "DELETE",
      headers: await headers(),
    });
    expect(againstPeer.status).toBe(403);

    /* Everything it could not touch is exactly where it was, so the admin's
       revocation of the stolen key is still available. */
    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toEqual([
      OPERATOR_ID,
      SECOND_ID,
      THIRD_ID,
    ]);
  });
});

describe("what the fleet records about its own keys", () => {
  it("records operator.trusted with the actor, the subject and the tier", async () => {
    await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID })),
        role: "admin",
      }),
    });

    expect(auditEvents()).toEqual([
      { type: "operator.trusted", actor: OPERATOR_ID, subject: SECOND_ID, role: "admin" },
    ]);
  });

  it("records operator.revoked with the tier the key had when it went", async () => {
    await trustAs(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }), "operator");

    await app.request(`/v1/operators/${SECOND_ID}`, {
      method: "DELETE",
      headers: await asOperator(),
    });

    expect(auditEvents()).toEqual([
      { type: "operator.revoked", actor: OPERATOR_ID, subject: SECOND_ID, role: "operator" },
    ]);
  });

  it("records NOTHING for a call it refused", async () => {
    const junior = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, junior, "operator");

    await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asKey(SECOND_ID, junior)), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(THIRD_ID, await generateJWK("EdDSA", { kid: THIRD_ID })),
        role: "admin",
      }),
    });

    /* An audit line says a key WAS trusted; a refusal changed nothing. */
    expect(auditEvents()).toEqual([]);
  });
});

describe("POST /v1/operators", () => {
  it("trusts a key, and the fleet then accepts the tokens it signs", async () => {
    const minted = await generateJWK("EdDSA", { kid: SECOND_ID });

    const added = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify(publicHalf(SECOND_ID, minted)),
    });

    expect(added.status).toBe(200);
    /* The point of the route: a key registered through it is a key that works. */
    const probe = await app.request("/v1/operators", {
      headers: { authorization: `Bearer ${await signNodeToken(minted.privateKey, SECOND_ID)}` },
    });
    expect(probe.status).toBe(200);
  });

  it("is idempotent, so a rerun of an interrupted rotation costs nothing", async () => {
    const minted = await generateJWK("EdDSA", { kid: SECOND_ID });
    const body = JSON.stringify(publicHalf(SECOND_ID, minted));

    for (const _ of [0, 1]) {
      const response = await app.request("/v1/operators", {
        method: "POST",
        headers: { ...(await asOperator()), "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
    }

    expect(await listOperators(clock.ctx)).toHaveLength(2);
  });

  it("relays the registry's refusal of an id a node already holds", async () => {
    const response = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify(publicHalf(NODE_ID, await generateJWK("EdDSA", { kid: NODE_ID }))),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      type: "urn:scafo:reference-held",
    });
  });

  it("refuses a body that carries no key at all", async () => {
    const response = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });
});

describe("DELETE /v1/operators/:id", () => {
  it("removes another operator's key, authenticated by the caller's own", async () => {
    await trust(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }));

    const response = await app.request(`/v1/operators/${SECOND_ID}`, {
      method: "DELETE",
      headers: await asOperator(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ removed: SECOND_ID });
    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toEqual([OPERATOR_ID]);
  });

  it("REFUSES the caller's own key, and says rotation is how one replaces it", async () => {
    await trust(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }));

    const response = await app.request(`/v1/operators/${OPERATOR_ID}`, {
      method: "DELETE",
      headers: await asOperator(),
    });

    /* Self-revocation is the one removal that cannot be verified afterwards: the
       caller would have to prove the fleet still works with a key it just threw
       away. Rotation proves the new key first, which is the whole ordering. */
    expect(response.status).toBe(400);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:invalid-input");
    expect(problem.detail).toContain("rotate");
    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toContain(OPERATOR_ID);
  });

  it("CANNOT empty the trusted set at all, because the last key is always the caller's", async () => {
    /* The caller is by definition one of the trusted keys, so the self-refusal
       above is also what makes a fleet with zero operators unreachable through
       this route. The registry's own last-key guard still stands underneath it,
       for the bucket-side path that has no caller to compare against. */
    const response = await app.request(`/v1/operators/${OPERATOR_ID}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${await signNodeToken(operator.privateKey, OPERATOR_ID)}` },
    });

    expect(response.status).toBe(400);
    expect(await listOperators(clock.ctx)).toHaveLength(1);
  });

  it("answers an id nothing is trusted under as a miss", async () => {
    await trust(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }));

    const response = await app.request("/v1/operators/op-ffff9999", {
      method: "DELETE",
      headers: await asOperator(),
    });

    expect(response.status).toBe(404);
  });
});

describe("who may reach /v1/operators at all", () => {
  const calls: Array<[string, string, RequestInit]> = [
    ["GET", "/v1/operators", {}],
    ["POST", "/v1/operators", { method: "POST", body: "{}" }],
    ["DELETE", `/v1/operators/${SECOND_ID}`, { method: "DELETE" }],
  ];

  it.each(calls)("refuses a caller with no token at all: %s %s", async (_method, path, init) => {
    const response = await app.request(path, init);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
  });

  it.each(calls)("REFUSES a NODE's own token: %s %s", async (_method, path, init) => {
    const response = await app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${await signNodeToken(node.privateKey, NODE_ID)}` },
    });

    /* Authenticated and then refused: the node proved who it is, and who it is
       has no business administering the operators of the fleet it belongs to. */
    expect(response.status).toBe(403);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:auth-scope");
    expect(problem.detail).toContain(NODE_ID);
  });

  it.each(calls)("refuses a workload's OIDC token: %s %s", async (_method, path, init) => {
    /* A CI token is an RS256 JWS from an issuer, and these routes never consult
       the OIDC verifier at all — so it is simply not a node token, and lands in
       the same rejection a forged one does. */
    const response = await app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${await workloadToken()}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
  });

  it("refuses a token signed by a key this installation has never filed", async () => {
    const stranger = await generateJWK("EdDSA", { kid: "op-cccc3333" });

    const response = await app.request("/v1/operators", {
      headers: {
        authorization: `Bearer ${await signNodeToken(stranger.privateKey, "op-cccc3333")}`,
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
  });
});

/* ------------------------------------------------------------------ helpers */

/**
 * The public half of a keypair, as the trust route is given one — with NO role,
 * which is the ordinary body and the one that takes the route's own default.
 */
function publicHalf(id: string, keys: Keypair): Omit<TrustedOperator, "role"> {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x } };
}

/**
 * Files a key as an operator's, straight into the registry and WITHOUT a role —
 * which is the record every installation older than this wave holds, and which
 * reads as an admin.
 */
async function trust(id: string, keys: Keypair): Promise<void> {
  await registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: "operator", agentPort: 0 },
  });
}

/** The same, at a stated tier and with the lineage a rotation would have left. */
async function trustAs(
  id: string,
  keys: Keypair,
  role: OperatorRole,
  supersedes?: string,
): Promise<void> {
  await registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: "operator", agentPort: 0 },
    operator: { role, ...(supersedes === undefined ? {} : { supersedes }) },
  });
}

/** A header carrying a token good for exactly one request. */
async function asOperator(): Promise<Record<string, string>> {
  return asKey(OPERATOR_ID, operator);
}

/** The same, signed by any keypair this test filed. */
async function asKey(id: string, keys: Keypair): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signNodeToken(keys.privateKey, id)}` };
}

/** The listing as a caller reads it back. */
async function listing(headers: Record<string, string>): Promise<unknown> {
  return (await app.request("/v1/operators", { headers })).json();
}

/** The audit lines the node recorded, stripped of what every event carries. */
function auditEvents(): Array<Record<string, unknown>> {
  return observed
    .snapshot()
    .events.filter((entry) => entry.type.startsWith("operator."))
    .map(({ at: _at, ...rest }) => rest);
}

/** An RS256 JWS shaped like the token a CI workload presents. */
async function workloadToken(): Promise<string> {
  const { privateKey } = await generateJWK("RS256", { kid: "issuer-key-1" });
  const nowS = Math.floor(clock.nowMs() / 1000);

  return signJws(
    {
      iss: "https://issuer.test",
      sub: "repo:acme/app:ref:refs/heads/main",
      iat: nowS,
      exp: nowS + 300,
    },
    privateKey,
    { alg: "RS256", protectedHeader: { kid: "issuer-key-1" } },
  );
}

function agentConfig(): AgentConfig {
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
