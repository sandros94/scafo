/*
 * Deleting an environment from whichever node the operator happened to ask.
 *
 * Only the coordinator may carry the deletion out, so every other node forwards
 * the request to it. What matters here is what crosses that hop: a token this
 * node signed for itself and never the caller's, exactly one hop, and the
 * coordinator's own answer handed back unchanged.
 *
 * The app is driven through its fetch interface and the hop is a stub, so
 * nothing binds a socket and no second daemon is started.
 */

import type { H3 } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it } from "vitest";
import { recordDeployment } from "../src/core/registry/_deployment.ts";
import { type DaemonContext, type DaemonState, createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { type Coordinator, createCoordinator } from "../src/daemon/coordinator.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import {
  acquireLease,
  createBuild,
  createEnvironment,
  createProject,
  getEnvironment,
  readJson,
  registerNode,
} from "../src/core/registry/index.ts";
import { coordinatorKey, environmentKey } from "../src/core/registry/paths.ts";
import type { CoordinatorLease, NodeRecord } from "../src/core/types/registry.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, rejectsWith } from "./_helpers.ts";

const SELF = "node-a";
const OTHER = "node-b";
const OPERATOR = "operator-1";
const PROJECT = "app";
const ENVIRONMENT = "preview";
const BUILD = "b1b1b1b1";
const TTL_MS = 15_000;

/** Where node-b says it is reached; what a forwarded request must be addressed to. */
const OTHER_ADDRESS = { internal: "10.0.0.5", apiPort: 7500 };

const DELETE_PATH = `/v1/environments/${PROJECT}/${ENVIRONMENT}`;

/** One forwarded request, as the stub recorded it. */
interface Forwarded {
  url: string;
  method: string;
  authorization: string;
  proxied: string | null;
}

let clock: ManualClock;
let selfKeys: { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };
let operatorKeys: { privateKey: JWK_OKP_Private<"EdDSA">; publicKey: JWK_OKP_Public<"EdDSA"> };
let forwarded: Forwarded[];
let answerWith: Response;

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  forwarded = [];
  answerWith = jsonResponse(200, { deleted: [environmentKey(PROJECT, ENVIRONMENT)] });

  selfKeys = await generateJWK("EdDSA", { kid: SELF });
  operatorKeys = await generateJWK("EdDSA", { kid: OPERATOR });
  await registerNode(clock.ctx, nodeRecord(SELF, selfKeys.publicKey.x, OTHER_ADDRESS));
  await registerNode(clock.ctx, nodeRecord(OTHER, "b".repeat(43), OTHER_ADDRESS));
  await registerNode(clock.ctx, nodeRecord(OPERATOR, operatorKeys.publicKey.x, OTHER_ADDRESS));

  await createProject(clock.ctx, { slug: PROJECT });
  await createEnvironment(clock.ctx, PROJECT, {
    name: ENVIRONMENT,
    ephemeral: true,
    idleTtlS: 900,
  });
  await createBuild(clock.ctx, PROJECT, { id: BUILD });
  await recordDeployment(clock.ctx, PROJECT, ENVIRONMENT, BUILD);
});

describe("DELETE /v1/environments/:project/:env", () => {
  it("deletes on the spot when this node is the coordinator", async () => {
    const { app, coordinator } = await nodeApp();
    await coordinator.runOnce();
    expect(coordinator.status().holding).toBe(true);

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: await operatorBearer(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: [environmentKey(PROJECT, ENVIRONMENT)],
    });
    /* Nothing was forwarded: the node the operator asked was the right one. */
    expect(forwarded).toEqual([]);
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, ENVIRONMENT), "not-found");
  });

  it("takes the lease and does the work when nobody is coordinating yet", async () => {
    const { app } = await nodeApp();
    expect(await readJson<CoordinatorLease>(clock.ctx, coordinatorKey())).toBeNull();

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: await operatorBearer(),
    });

    /* A fresh installation has no coordinator until something needs one; being
       told to come back later would be an answer nobody could act on. */
    expect(response.status).toBe(200);
    expect(forwarded).toEqual([]);
    const lease = await readJson<CoordinatorLease>(clock.ctx, coordinatorKey());
    expect(lease?.value.node).toBe(SELF);
    await rejectsWith(() => getEnvironment(clock.ctx, PROJECT, ENVIRONMENT), "not-found");
  });

  it("forwards to the coordinator with a token it signed itself", async () => {
    const { app } = await nodeApp();
    await givenCoordinatorIs(OTHER);
    const callerToken = await operatorToken();

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: { authorization: `Bearer ${callerToken}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: [environmentKey(PROJECT, ENVIRONMENT)],
    });

    expect(forwarded).toHaveLength(1);
    const hop = forwarded[0];
    expect(hop.method).toBe("DELETE");
    expect(hop.url).toBe(
      `http://${OTHER_ADDRESS.internal}:${String(OTHER_ADDRESS.apiPort)}${DELETE_PATH}`,
    );
    expect(hop.proxied).toBe("1");

    /*
     * The token that crossed the hop is this node's own, never the caller's: a
     * node token is single-use and the caller's was spent verifying it here, so
     * forwarding it would be both a replay and one caller's credential handed to
     * another node.
     */
    const sent = hop.authorization.replace(/^Bearer /, "");
    expect(sent).not.toBe(callerToken);
    expect(claimsOf(sent).sub).toBe(SELF);
    expect(claimsOf(sent).sub).not.toBe(claimsOf(callerToken).sub);
    expect(claimsOf(sent).jti).not.toBe(claimsOf(callerToken).jti);

    /* The environment is the coordinator's to delete; this node touched nothing. */
    await expect(getEnvironment(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toMatchObject({
      name: ENVIRONMENT,
    });
  });

  it("relays the coordinator's refusal as the coordinator wrote it", async () => {
    const { app } = await nodeApp();
    await givenCoordinatorIs(OTHER);
    const problem: ProblemDetails = {
      type: "urn:scafo:invalid-input",
      title: "Environment is not ephemeral",
      status: 409,
      detail: "the coordinator's own words",
    };
    answerWith = jsonResponse(409, problem, "application/problem+json");

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: await operatorBearer(),
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toEqual(problem);
  });

  it("refuses a forwarded request rather than forwarding it a second time", async () => {
    const { app } = await nodeApp();
    await givenCoordinatorIs(OTHER);

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: { ...(await operatorBearer()), "x-scafo-proxied": "1" },
    });
    const problem = (await response.json()) as ProblemDetails;

    /* The hop was decided against a lease that moved. Answering keeps the
       request from circling a mesh of nodes each forwarding to the next. */
    expect(response.status).toBe(503);
    expect(problem.type).toBe("urn:scafo:draining");
    expect(forwarded).toEqual([]);
  });

  it("refuses when nobody coordinates and this node runs no coordinator", async () => {
    const { app } = await nodeApp({ coordinator: false });

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: await operatorBearer(),
    });
    const problem = (await response.json()) as ProblemDetails;

    /* Refusal over silence: there is nowhere to carry this out right now, and
       the caller is told so instead of getting a 200 that deleted nothing. */
    expect(response.status).toBe(503);
    expect(problem.type).toBe("urn:scafo:draining");
    await expect(getEnvironment(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toMatchObject({
      name: ENVIRONMENT,
    });
  });

  it("refuses to forward when it holds no key to speak with", async () => {
    const { app } = await nodeApp({ signingKey: false });
    await givenCoordinatorIs(OTHER);

    const response = await app.request(DELETE_PATH, {
      method: "DELETE",
      headers: await operatorBearer(),
    });
    const problem = (await response.json()) as ProblemDetails;

    expect(response.status).toBe(409);
    expect(problem.type).toBe("urn:scafo:capability-missing");
    expect(forwarded).toEqual([]);
  });

  it("needs a token like every other route that commands a node", async () => {
    const { app } = await nodeApp();

    const response = await app.request(DELETE_PATH, { method: "DELETE" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      type: "urn:scafo:auth-invalid",
      title: "Authentication failed",
      status: 401,
    });
  });
});

describe("GET /v1/state", () => {
  it("names the coordinator and says it is this node when it is", async () => {
    const { app, coordinator } = await nodeApp();
    await coordinator.runOnce();

    const state = (await (
      await app.request("/v1/state", { headers: await operatorBearer() })
    ).json()) as DaemonState;

    expect(state.coordinator).toEqual({ node: SELF, fence: 1, self: true });
  });

  it("names another node's coordinator without claiming it", async () => {
    const { app } = await nodeApp();
    await givenCoordinatorIs(OTHER);

    const state = (await (
      await app.request("/v1/state", { headers: await operatorBearer() })
    ).json()) as DaemonState;

    expect(state.coordinator).toEqual({ node: OTHER, fence: 1, self: false });
    expect(state.lease?.node).toBe(OTHER);
  });

  it("reports nobody coordinating once a lease has gone stale", async () => {
    const { app } = await nodeApp();
    await givenCoordinatorIs(OTHER);
    clock.tick(TTL_MS * 10);

    const state = (await (
      await app.request("/v1/state", { headers: await operatorBearer() })
    ).json()) as DaemonState;

    /* The record is still there and still names node-b; what it no longer says
       is that node-b is coordinating. */
    expect(state.lease?.node).toBe(OTHER);
    expect(state.coordinator).toBeNull();
  });
});

/* ------------------------------------------------------------------ helpers */

interface DaemonUnderTest {
  app: H3;
  coordinator: Coordinator;
}

/**
 * This node, with a coordinator loop it drives itself and a stub in place of the
 * hop to its peer. `coordinator: false` builds a node that runs no loop at all.
 */
async function nodeApp(opts?: {
  coordinator?: boolean;
  signingKey?: boolean;
}): Promise<DaemonUnderTest> {
  const daemon: DaemonContext = {
    config: daemonConfig(),
    nodeId: SELF,
    registry: clock.ctx,
    supervisor: idleSupervisor(),
    version: "0.0.0-test",
    fetchFn: stubFetch,
  };
  if (opts?.signingKey !== false) daemon.signingKey = selfKeys.privateKey;

  const coordinator = createCoordinator(daemon, { ttlMs: TTL_MS, reapIntervalMs: 0 });
  if (opts?.coordinator !== false) daemon.coordinator = coordinator;

  return { app: createNodeApp(daemon), coordinator };
}

/** Records the hop and answers with whatever the test staged. */
const stubFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  forwarded.push({
    url: input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
    method: init?.method ?? "GET",
    authorization: headers.get("authorization") ?? "",
    proxied: headers.get("x-scafo-proxied"),
  });
  return Promise.resolve(answerWith.clone());
};

/** Puts the lease in another node's hands, the way that node itself would. */
async function givenCoordinatorIs(nodeId: string): Promise<void> {
  const taken = await acquireLease(clock.ctx, nodeId, { ttlMs: TTL_MS });
  if (taken === null) throw new Error(`"${nodeId}" could not take the lease`);
}

function jsonResponse(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

/** The claims a compact JWS carries, read without verifying it. */
function claimsOf(token: string): { sub: string; jti: string } {
  const payload = token.split(".")[1] ?? "";
  const json = new TextDecoder().decode(
    Uint8Array.from(
      atob(payload.replaceAll("-", "+").replaceAll("_", "/")),
      (c) => c.codePointAt(0) as number,
    ),
  );
  return JSON.parse(json) as { sub: string; jti: string };
}

function nodeRecord(
  id: string,
  x: string,
  addresses: { internal: string; apiPort: number },
): NodeRecord {
  return { v: 1, id, publicKey: { kty: "OKP", crv: "Ed25519", x }, addresses };
}

/** A fresh single-use operator token; a spent one is refused as a replay. */
function operatorToken(): Promise<string> {
  return signNodeToken(operatorKeys.privateKey, OPERATOR);
}

async function operatorBearer(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await operatorToken()}` };
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
    node: { id: SELF, listen: "127.0.0.1:7400" },
    platformDomains: ["apps.test"],
    runtime: {
      binPath: "celld",
      portRangeStart: 42_000,
      bindHost: "127.0.0.1",
      durability: "bucket",
      cellIdleEvictS: 900,
    },
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
  };
}

/** Runs nothing: no route under test starts a process. */
function idleSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}
