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
import { signNodeToken } from "../src/core/auth/index.ts";
import { listOperators, type TrustedOperator } from "../src/core/registry/operators.ts";
import { registerNode } from "../src/core/registry/nodes.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const OPERATOR_ID = "op-aaaa1111";
const SECOND_ID = "op-bbbb2222";
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
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  node = await generateJWK("EdDSA", { kid: NODE_ID });
  operator = await generateJWK("EdDSA", { kid: OPERATOR_ID });

  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: node.publicKey.x },
    addresses: { internal: "10.0.0.4", agentPort: 7400 },
  });
  await trust(OPERATOR_ID, operator);

  app = createAgentApp({
    config: agentConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: VERSION,
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

/** The public half of a keypair, as the trust route is given one. */
function publicHalf(id: string, keys: Keypair): TrustedOperator {
  return { id, publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x } };
}

/** Files a key as an operator's, straight into the registry. */
async function trust(id: string, keys: Keypair): Promise<void> {
  await registerNode(clock.ctx, {
    v: 1,
    id,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: "operator", agentPort: 0 },
  });
}

/** A header carrying a token good for exactly one request. */
async function asOperator(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await signNodeToken(operator.privateKey, OPERATOR_ID)}` };
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
