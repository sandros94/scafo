/* `/v1/operators` administration requires an operator token, not a node token. */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createObservability, type Observability } from "../src/daemon/observe.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import {
  getOperator,
  listOperators,
  type OperatorRole,
  type TrustedOperator,
} from "../src/core/registry/operators.ts";
import { putJson } from "../src/core/registry/cas.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import { operatorKey } from "../src/core/registry/paths.ts";
import type { OperatorRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS } from "./_helpers.ts";

const NODE_ID = "node-a";
const OPERATOR_ID = "op-aaaa1111";
const SECOND_ID = "op-bbbb2222";
const THIRD_ID = "op-cccc3333";
const FOURTH_ID = "op-dddd4444";
/** The project every operator-tier key in this file is scoped to; see {@link scopedHalf}. */
const PROJECT = "acme";

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
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  });
  await trust(OPERATOR_ID, operator);

  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    versions: TEST_VERSIONS,
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
  const granted: Array<[OperatorRole, OperatorRole]> = [
    ["admin", "admin"],
    ["admin", "operator"],
    ["operator", "operator"],
  ];

  it.each(granted)("a %s registering a %s is answered 200", async (caller, wanted) => {
    const response = await grant(caller, wanted);

    expect(response.status).toBe(200);
    await expect(getOperator(clock.ctx, THIRD_ID)).resolves.toMatchObject({ role: wanted });
  });

  it("REFUSES an operator-tier key registering an admin, and files nothing", async () => {
    const response = await grant("operator", "admin");

    expect(response.status).toBe(403);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:auth-scope");
    expect(await getOperator(clock.ctx, THIRD_ID)).toBeNull();
  });

  it("defaults a registration to the operator tier, which is least privilege", async () => {
    await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify(scopedHalf(SECOND_ID, await generateJWK("EdDSA", { kid: SECOND_ID }))),
    });

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

  /** A `caller`-tier key registering a fresh key at the `wanted` tier. */
  async function grant(caller: OperatorRole, wanted: OperatorRole): Promise<Response> {
    const callerKeys = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, callerKeys, caller);
    const minted = await generateJWK("EdDSA", { kid: THIRD_ID });

    return app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asKey(SECOND_ID, callerKeys)), "content-type": "application/json" },
      body: JSON.stringify({
        ...(wanted === "operator" ? scopedHalf(THIRD_ID, minted) : publicHalf(THIRD_ID, minted)),
        role: wanted,
      }),
    });
  }
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

    expect(response.status).toBe(400);
    await expect(getOperator(clock.ctx, OPERATOR_ID)).resolves.toMatchObject({ role: "admin" });
  });
});

describe("the escalation this whole shape exists to stop", () => {
  it("a stolen operator key cannot lock the admins out", async () => {
    const stolen = await generateJWK("EdDSA", { kid: SECOND_ID });
    await trustAs(SECOND_ID, stolen, "operator");
    const colleague = await generateJWK("EdDSA", { kid: THIRD_ID });
    await trustAs(THIRD_ID, colleague, "operator");
    const headers = (): Promise<Record<string, string>> => asKey(SECOND_ID, stolen);

    const escalated = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await headers()), "content-type": "application/json" },
      body: JSON.stringify({
        ...publicHalf(FOURTH_ID, await generateJWK("EdDSA", { kid: FOURTH_ID })),
        role: "admin",
      }),
    });
    expect(escalated.status).toBe(403);

    const againstAdmin = await app.request(`/v1/operators/${OPERATOR_ID}`, {
      method: "DELETE",
      headers: await headers(),
    });
    expect(againstAdmin.status).toBe(403);

    const againstPeer = await app.request(`/v1/operators/${THIRD_ID}`, {
      method: "DELETE",
      headers: await headers(),
    });
    expect(againstPeer.status).toBe(403);

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

    expect(auditEvents()).toEqual([]);
  });
});

describe("POST /v1/operators", () => {
  it("trusts a key, and the fleet then accepts the tokens it signs", async () => {
    const minted = await generateJWK("EdDSA", { kid: SECOND_ID });

    const added = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify(scopedHalf(SECOND_ID, minted)),
    });

    expect(added.status).toBe(200);
    const probe = await app.request("/v1/operators", {
      headers: { authorization: `Bearer ${await signNodeToken(minted.privateKey, SECOND_ID)}` },
    });
    expect(probe.status).toBe(200);
  });

  it("is idempotent, so a rerun of an interrupted rotation costs nothing", async () => {
    const minted = await generateJWK("EdDSA", { kid: SECOND_ID });
    const body = JSON.stringify(scopedHalf(SECOND_ID, minted));

    const first = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(200);
    const stored = await clock.ctx.store.getBytes(operatorKey(SECOND_ID));

    const retried = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body,
    });
    expect(retried.status).toBe(200);

    expect(await clock.ctx.store.getBytes(operatorKey(SECOND_ID))).toEqual(stored);
    expect(await listOperators(clock.ctx)).toHaveLength(2);
  });

  it("refuses changed POST data for existing admin, peer and caller ids without rewriting them", async () => {
    const peer = await generateJWK("EdDSA", { kid: SECOND_ID });
    const caller = await generateJWK("EdDSA", { kid: THIRD_ID });
    await trustAs(SECOND_ID, peer, "admin");
    await trustAs(THIRD_ID, caller, "admin");

    const originals = new Map<string, Uint8Array>();
    for (const id of [OPERATOR_ID, SECOND_ID, THIRD_ID]) {
      originals.set(id, (await clock.ctx.store.getBytes(operatorKey(id))) as Uint8Array);
    }

    for (const [id, headers] of [
      [OPERATOR_ID, await asOperator()],
      [SECOND_ID, await asOperator()],
      [THIRD_ID, await asKey(THIRD_ID, caller)],
    ] as const) {
      const response = await app.request("/v1/operators", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          ...publicHalf(id, await generateJWK("EdDSA", { kid: id })),
          role: "admin",
        }),
      });
      expect(response.status).toBe(409);
      expect(await clock.ctx.store.getBytes(operatorKey(id))).toEqual(originals.get(id));
    }
  });

  it("relays the registry's refusal of an id a node already holds", async () => {
    const response = await app.request("/v1/operators", {
      method: "POST",
      headers: { ...(await asOperator()), "content-type": "application/json" },
      body: JSON.stringify(scopedHalf(NODE_ID, await generateJWK("EdDSA", { kid: NODE_ID }))),
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

    expect(response.status).toBe(400);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:invalid-input");
    expect(problem.detail).toContain("rotate");
    expect((await listOperators(clock.ctx)).map((entry) => entry.id)).toContain(OPERATOR_ID);
  });

  it("CANNOT empty the trusted set at all, because the last key is always the caller's", async () => {
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

    expect(response.status).toBe(403);
    const problem = (await response.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("urn:scafo:auth-scope");
    expect(problem.detail).toContain(NODE_ID);
  });

  it.each(calls)("refuses a workload's OIDC token: %s %s", async (_method, path, init) => {
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

/**
 * The public half of a keypair, as the trust route is given one — with no role,
 * which is the ordinary body and the one that takes the route's own default.
 */
function publicHalf(id: string, keys: Keypair): Omit<TrustedOperator, "role"> {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x } };
}

/**
 * The same, naming a SCOPE — which an operator-tier registration must, since a
 * key that names no projects reaches none of them.
 *
 * Used wherever the tier a body lands at is `operator`, and left off wherever it
 * is `admin`, which is never scoped. What that refusal looks like on its own is
 * `test/operator-tenancy.test.ts`; these cases are about the tiers.
 */
function scopedHalf(id: string, keys: Keypair): Omit<TrustedOperator, "role"> {
  return { ...publicHalf(id, keys), projects: [PROJECT] };
}

/**
 * Files a key as an operator's, straight into the registry and WITHOUT a role —
 * a shape nothing writes any more, and which reads as an admin.
 */
async function trust(id: string, keys: Keypair): Promise<void> {
  await putJson<OperatorRecord>(clock.ctx, operatorKey(id), {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
  });
}

/**
 * The same, at a stated tier and with the lineage a rotation would have left.
 *
 * An operator-tier key is given a SCOPE, because one that names no projects is
 * a shape nothing grants: it reaches nothing, and a fixture carrying it would be
 * testing the broken record rather than the tier rules these cases are about.
 * `test/operator-tenancy.test.ts` is where the scope-less record is exercised.
 */
async function trustAs(
  id: string,
  keys: Keypair,
  role: OperatorRole,
  supersedes?: string,
): Promise<void> {
  await putJson<OperatorRecord>(clock.ctx, operatorKey(id), {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    role,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(role === "operator" ? { projects: [PROJECT] } : {}),
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
      bindHost: "127.0.0.1",
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
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
