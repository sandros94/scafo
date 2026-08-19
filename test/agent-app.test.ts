/*
 * The agent HTTP API: which routes need a token, what a rejected caller is told
 * about why, and how the state route reports the node it runs on.
 *
 * The app is invoked through its fetch interface, so nothing binds a socket. The
 * registry is a memory store and the supervisor is a stand-in with a fixed
 * inventory — no process is started here.
 */

import { H3, HTTPError } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentState, createAgentApp } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { renderProblem } from "../src/agent/middleware.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import { ScaloError } from "../src/core/error.ts";
import { acquireLease, registerNode } from "../src/core/registry/index.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const NODE_ID = "node-a";
const VERSION = "0.0.0-test";

/** What the stand-in supervisor reports; the state route must pass it through. */
const PROCESSES: ProcessStatus[] = [
  { id: "cell-alpha", state: "running", pid: 4321, startedAt: "2026-01-01T00:00:00.000Z" },
  { id: "cell-beta", state: "exited", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z" },
];

/** Every problem body a rejected caller may see, whatever was wrong with the token. */
const AUTH_INVALID_PROBLEM = {
  type: "urn:scalo:auth-invalid",
  title: "Authentication failed",
  status: 401,
};

let clock: ManualClock;
let keys: { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };
let record: NodeRecord;
let app: H3;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  keys = await generateJWK("EdDSA", { kid: NODE_ID });
  record = {
    v: 1,
    id: NODE_ID,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: "10.0.0.4", agentPort: 7400 },
  };
  await registerNode(clock.ctx, record);

  app = createAgentApp({
    config: agentConfig(),
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: VERSION,
  });
});

describe("GET /v1/health", () => {
  it("answers without a token, naming the build and the node", async () => {
    const response = await app.request("/v1/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: VERSION,
      node: NODE_ID,
    });
  });
});

describe("GET /v1/state", () => {
  it("reports the node's own record, the coordinator lease and its processes", async () => {
    const response = await app.request("/v1/state", { headers: await bearer() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      node: record,
      /* Nobody has taken the lease yet, and that is not an error to report. */
      lease: null,
      processes: PROCESSES,
    });
  });

  it("reports the lease once a node holds one, whoever that node is", async () => {
    const handle = await acquireLease(clock.ctx, "node-elsewhere");
    expect(handle).not.toBeNull();

    const response = await app.request("/v1/state", { headers: await bearer() });
    const state = (await response.json()) as AgentState;

    expect(response.status).toBe(200);
    expect(state.lease).toEqual(handle?.lease);
    expect(state.lease?.node).toBe("node-elsewhere");
  });

  it("refuses a caller without a token, telling it nothing beyond the status", async () => {
    const response = await app.request("/v1/state");
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(problem).toEqual(AUTH_INVALID_PROBLEM);
    /* A detail would separate "no header" from "bad signature" for an attacker. */
    expect(Object.hasOwn(problem, "detail")).toBe(false);
  });

  it("answers every rejected token with a byte-identical problem document", async () => {
    const stranger = await generateJWK("EdDSA", { kid: NODE_ID });
    const rejected = [
      "",
      "Bearer",
      "Bearer not-a-token",
      "Bearer a.b.c",
      "Basic dXNlcjpwYXNz",
      `Bearer ${await signNodeToken(stranger.privateKey, NODE_ID)}`,
      `Bearer ${await signNodeToken(keys.privateKey, "node-unregistered")}`,
    ];
    const baseline = await app.request("/v1/state");
    const expected = await baseline.text();

    expect(baseline.status).toBe(401);
    expect(JSON.parse(expected)).toEqual(AUTH_INVALID_PROBLEM);

    for (const authorization of rejected) {
      const response = await app.request("/v1/state", { headers: { authorization } });

      expect(response.status, `for ${JSON.stringify(authorization)}`).toBe(401);
      expect(await response.text(), `for ${JSON.stringify(authorization)}`).toBe(expected);
    }
  });

  it("spends a token on the request that presents it, refusing the replay", async () => {
    const token = await mint();

    const first = await app.request("/v1/state", { headers: { authorization: `Bearer ${token}` } });
    const replay = await app.request("/v1/state", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
  });

  it("bounds single use to the app that spent the token", async () => {
    /*
     * The verifier, and with it the record of spent tokens, belongs to one app
     * instance: a second agent has never seen this token and accepts it. Single
     * use is a per-node guarantee, not a registry-wide one.
     */
    const token = await mint();
    const other = createAgentApp({
      config: agentConfig(),
      registry: clock.ctx,
      supervisor: fakeSupervisor(),
      version: VERSION,
    });

    const spent = await app.request("/v1/state", { headers: { authorization: `Bearer ${token}` } });
    const elsewhere = await other.request("/v1/state", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(spent.status).toBe(200);
    expect(elsewhere.status).toBe(200);
  });
});

describe("routes that do not exist", () => {
  it("answers as a problem document, without pretending it is an auth failure", async () => {
    for (const path of ["/v1/nope", "/", "/v1/state/extra"]) {
      const response = await app.request(path);
      const problem = (await response.json()) as ProblemDetails;

      expect(response.status, `for ${path}`).toBe(404);
      expect(response.headers.get("content-type"), `for ${path}`).toBe("application/problem+json");
      expect(problem.type, `for ${path}`).toBe("about:blank");
      expect(problem.status, `for ${path}`).toBe(404);
      expect(problem.title.length, `for ${path}`).toBeGreaterThan(0);
    }
  });

  it("answers a known path asked with the wrong method the same way", async () => {
    const response = await app.request("/v1/health", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ type: "about:blank", status: 404 });
  });
});

describe("renderProblem", () => {
  it("answers a scalo failure with that error's own problem document", async () => {
    const thrown = new ScaloError("cas-conflict", "Conditional write failed", {
      detail: "the object changed under the write",
    });

    const response = renderProblem(asHandlerThrew(thrown));

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "urn:scalo:cas-conflict",
      title: "Conditional write failed",
      status: 409,
      detail: "the object changed under the write",
    });
  });

  it("keeps the status and the reason of a failure raised by the HTTP layer itself", async () => {
    /* How a request for a path with no route arrives: a status and a message,
       no cause of its own, and nothing flagging it as unexpected. */
    const response = renderProblem(
      new HTTPError({ status: 404, message: "Cannot find any route matching [GET] /v1/nope" }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Cannot find any route matching [GET] /v1/nope",
      status: 404,
    });
  });

  it("prefers a status text to the message when the HTTP layer supplies one", async () => {
    const response = renderProblem(
      new HTTPError({ status: 413, message: "body was 40MB", statusText: "Payload Too Large" }),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ title: "Payload Too Large" });
  });

  it("gives an unexpected failure to the operator and only a status to the client", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = new Error("connect ECONNREFUSED 10.0.0.9:5432");

    const response = renderProblem(asHandlerThrew(secret));

    expect(response.status).toBe(500);
    /* Nothing else: not the message, not a detail, not the address it leaked. */
    await expect(response.json()).resolves.toEqual({
      type: "urn:scalo:internal",
      title: "Internal Server Error",
      status: 500,
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });
});

/**
 * The error the HTTP layer hands its `onError` hook once a route handler has
 * thrown: the original wrapped, kept as `cause`, and flagged as unexpected —
 * which the layer does for every thrown error, a deliberate scalo failure included.
 */
function asHandlerThrew(thrown: Error): HTTPError {
  const wrapped = new HTTPError(thrown);
  return Object.assign(wrapped, { unhandled: true });
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
  };
}

/** Reports a fixed inventory; nothing it is asked to run would run. */
function fakeSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => PROCESSES.map((status) => ({ ...status })),
    onExit: () => {},
  };
}

/** A token this node's registered key verifies, good for exactly one request. */
function mint(): Promise<string> {
  return signNodeToken(keys.privateKey, NODE_ID);
}

async function bearer(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await mint()}` };
}
