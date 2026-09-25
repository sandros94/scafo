/*
 * The node API: which routes need a token, what a rejected caller is told about why, and how the
 * state route reports the node it runs on.
 */

import { H3, HTTPError } from "h3";
import type { JWK_OKP_Private, JWK_OKP_Public } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordRevision } from "../src/core/registry/_revision.ts";
import { type DaemonState, createNodeApp, type ApplicationResult } from "../src/daemon/app.ts";
import type { AssignmentFailure } from "../src/daemon/_assign.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import type { ReconcileStatus } from "../src/daemon/reconcile.ts";
import { renderProblem } from "../src/daemon/middleware.ts";
import { signNodeToken } from "../src/core/auth/index.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import { ScafoError } from "../src/core/error.ts";
import {
  acquireLease,
  applicationKey,
  claimDomain,
  createApplication,
  createDeployment,
  deleteKey,
  getApplication,
  registerNode,
  retireApplication,
} from "../src/core/registry/index.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { ProcessStatus, Supervisor } from "../src/core/types/supervisor.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock, TEST_VERSIONS } from "./_helpers.ts";

const NODE_ID = "node-a";
const APPLICATION = "shop";
/** A second application of the same fleet, for what must stay apart from the first. */
const OTHER_APPLICATION = "blog";
const CUSTOM_DOMAIN = "shop.example.com";
/** The one platform domain this node serves; its bare apex is the fleet's API. */
const PLATFORM_DOMAIN = "apps.test";
const VERSION = "aaaa1111";

/**
 * What the stand-in supervisor reports; the state route must pass it through.
 * A process is named for the application it serves, which is the id it carries.
 * The route answers them in NAME ORDER, so a document read twice reads the same
 * and a process the supervisor has forgotten still lands beside its neighbours.
 */
const PROCESSES: ProcessStatus[] = [
  { id: APPLICATION, state: "running", pid: 4321, startedAt: "2026-01-01T00:00:00.000Z" },
  { id: OTHER_APPLICATION, state: "exited", exitCode: 0, startedAt: "2026-01-01T00:00:00.000Z" },
];

/** The same processes as the route orders them. */
const ORDERED_PROCESSES: ProcessStatus[] = [...PROCESSES].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
);

/** Every problem body a rejected caller may see, whatever was wrong with the token. */
const AUTH_INVALID_PROBLEM = {
  type: "urn:scafo:auth-invalid",
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
    addresses: { internal: "10.0.0.4", apiPort: 7400 },
  };
  await registerNode(clock.ctx, record);

  app = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    versions: TEST_VERSIONS,
  });
});

describe("GET /.well-known/scafo/health", () => {
  it("answers without a token, naming the build and the node", async () => {
    const response = await app.request("/.well-known/scafo/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      version: TEST_VERSIONS.scafo,
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
      lease: null,
      coordinator: null,
      processes: ORDERED_PROCESSES,
      placements: [],
    });
  });

  it("reports the lease once a node holds one, whoever that node is", async () => {
    const handle = await acquireLease(clock.ctx, "node-elsewhere");
    expect(handle).not.toBeNull();

    const response = await app.request("/v1/state", { headers: await bearer() });
    const state = (await response.json()) as DaemonState;

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
    const token = await mint();
    const other = createNodeApp({
      config: daemonConfig(),
      nodeId: NODE_ID,
      registry: clock.ctx,
      supervisor: fakeSupervisor(),
      versions: TEST_VERSIONS,
    });

    const spent = await app.request("/v1/state", { headers: { authorization: `Bearer ${token}` } });
    const elsewhere = await other.request("/v1/state", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(spent.status).toBe(200);
    expect(elsewhere.status).toBe(200);
  });
});

describe("GET /v1/state, which names applications throughout", () => {
  /** What the loop reports; every entry of it is about one application. */
  const STATUS: ReconcileStatus = {
    lastRunAt: "2026-01-01T00:00:05.000Z",
    running: false,
    lastActions: [
      { type: "start", application: APPLICATION },
      { type: "stop", application: OTHER_APPLICATION, reason: "no longer placed here" },
    ],
    failures: [
      {
        at: "2026-01-01T00:00:05.000Z",
        action: "stop",
        subject: OTHER_APPLICATION,
        detail: "the supervisor would not stop it",
      },
    ],
    processes: [{ application: APPLICATION, port: 42_000, internalPort: 42_001 }],
    placements: [
      { application: APPLICATION, nodes: [NODE_ID], self: true },
      { application: OTHER_APPLICATION, nodes: ["node-b"], self: false },
    ],
  };

  it("names a process, a placement, an action and a failure by its application", async () => {
    const reconciling = appReconciling(STATUS);

    const state = (await (
      await reconciling.request("/v1/state", { headers: await bearer() })
    ).json()) as DaemonState;

    /* A process id IS the application it serves: the supervisor and the state
       route agree on one name for it, with nothing to parse out of either. */
    expect(state.processes.map((process) => process.id)).toEqual(
      ORDERED_PROCESSES.map((process) => process.id),
    );
    expect(state.placements).toEqual(STATUS.placements);
    expect(state.reconcile).toEqual(STATUS);
  });

  it("reports the loop's placements rather than an empty list of its own", async () => {
    const reconciling = appReconciling({ ...STATUS, placements: [] });

    const state = (await (
      await reconciling.request("/v1/state", { headers: await bearer() })
    ).json()) as DaemonState;

    expect(state.placements).toEqual([]);
    expect(state.reconcile?.lastActions).toEqual(STATUS.lastActions);
  });
});

describe("POST /v1/applications/:name/retire", () => {
  it("retires the application and answers with it, without any lease at all", async () => {
    await deployable();

    const response = await app.request(`/v1/applications/${APPLICATION}/retire`, {
      method: "POST",
      headers: await bearer(),
    });
    const body = (await response.json()) as ApplicationResult;

    expect(response.status).toBe(200);
    expect(body.application.retiredAt).toBe(new Date(clock.nowMs()).toISOString());
    expect(await getApplication(clock.ctx, APPLICATION)).toEqual(body.application);
  });

  it("takes it back through the matching route", async () => {
    await deployable();
    await retireApplication(clock.ctx, APPLICATION);

    const response = await app.request(`/v1/applications/${APPLICATION}/unretire`, {
      method: "POST",
      headers: await bearer(),
    });
    const body = (await response.json()) as ApplicationResult;

    expect(response.status).toBe(200);
    expect(body.application.retiredAt).toBeUndefined();
  });

  it("answers a missing application as a miss rather than as a retirement", async () => {
    const response = await app.request("/v1/applications/ghost/retire", {
      method: "POST",
      headers: await bearer(),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:not-found" });
  });

  it("refuses both routes to a caller with no token", async () => {
    await deployable();

    for (const suffix of ["retire", "unretire"]) {
      const response = await app.request(`/v1/applications/${APPLICATION}/${suffix}`, {
        method: "POST",
      });

      expect(response.status, suffix).toBe(401);
      await expect(response.json(), suffix).resolves.toEqual(AUTH_INVALID_PROBLEM);
    }
    expect((await getApplication(clock.ctx, APPLICATION)).retiredAt).toBeUndefined();
  });
});

describe("POST /v1/applications/:name/selector", () => {
  it("chooses which nodes may serve it, without any lease at all", async () => {
    await deployable();

    const body = await selectorBody({ selector: { tier: "fast" } });

    expect(body.application.nodeSelector).toEqual({ tier: "fast" });
    expect(await getApplication(clock.ctx, APPLICATION)).toEqual(body.application);
  });

  it("lifts the constraint when the body says null", async () => {
    await deployable();
    await selectorBody({ selector: { tier: "fast" } });

    const body = await selectorBody({ selector: null });

    expect("nodeSelector" in body.application).toBe(false);
  });

  it("accepts a selector no node satisfies, because that is the coordinator's to report", async () => {
    await deployable();

    const body = await selectorBody({ selector: { gpu: "a100" } });

    expect(body.application.nodeSelector).toEqual({ gpu: "a100" });
  });

  it("refuses a body that says nothing about the selector", async () => {
    await deployable();

    const response = await selectorRequest({});

    expect(response.status).toBe(400);
    expect((await response.json()).detail).toContain("null to clear it");
  });

  it.each([{ selector: {} }, { selector: { Tier: "fast" } }, { selector: "tier=fast" }])(
    "refuses %p",
    async (sent) => {
      await deployable();

      const response = await selectorRequest(sent);

      expect(response.status).toBe(400);
      expect((await getApplication(clock.ctx, APPLICATION)).nodeSelector).toBeUndefined();
    },
  );

  it("answers a missing application as a miss rather than as a selector", async () => {
    await deployable();

    const response = await app.request("/v1/applications/ghost/selector", {
      method: "POST",
      headers: { ...(await bearer()), "content-type": "application/json" },
      body: JSON.stringify({ selector: { tier: "fast" } }),
    });

    expect(response.status).toBe(404);
  });
});

describe("GET /v1/state, on the node that is coordinating", () => {
  const UNPLACED = {
    target: APPLICATION,
    reason: "placement-unavailable" as const,
    detail: `no live node carries every label of "gpu=a100"`,
  };

  it("reports what the last assignment pass could not place", async () => {
    const coordinating = await appCoordinating([UNPLACED]);

    const state = (await (
      await coordinating.request("/v1/state", { headers: await bearer() })
    ).json()) as DaemonState;

    expect(state.coordinator?.self).toBe(true);
    expect(state.coordinator?.unplaced).toEqual([UNPLACED]);
    state.coordinator!.unplaced![0]!.detail = "mutated";
    expect(UNPLACED.detail).toContain("gpu=a100");
  });

  it("says nothing at all when the pass placed everything", async () => {
    const coordinating = await appCoordinating([]);

    const state = (await (
      await coordinating.request("/v1/state", { headers: await bearer() })
    ).json()) as DaemonState;

    expect(state.coordinator?.self).toBe(true);
    expect("unplaced" in (state.coordinator as object)).toBe(false);
  });

  it("never reports another node's account of its own pass", async () => {
    await acquireLease(clock.ctx, "node-elsewhere");
    const foreign = createNodeApp({
      config: daemonConfig(),
      nodeId: NODE_ID,
      registry: clock.ctx,
      supervisor: fakeSupervisor(),
      versions: TEST_VERSIONS,
      coordinator: {
        start: () => {},
        stop: () => Promise.resolve(),
        runOnce: () => Promise.resolve(),
        handle: () => null,
        status: () => ({
          holding: false,
          lease: null,
          lastReapAt: null,
          lastReapFailure: null,
          lastAssignAt: new Date(clock.nowMs()).toISOString(),
          lastAssignment: {
            live: [NODE_ID],
            changed: [],
            removed: [],
            skipped: [],
            unplaced: [UNPLACED],
          },
          lastAssignFailure: null,
          skippedAssignments: 0,
        }),
      },
    });

    const state = (await (
      await foreign.request("/v1/state", { headers: await bearer() })
    ).json()) as DaemonState;

    expect(state.coordinator?.node).toBe("node-elsewhere");
    expect(state.coordinator?.self).toBe(false);
    expect(state.coordinator?.unplaced).toBeUndefined();
  });
});

describe("GET /v1/ingress/ask", () => {
  it("answers for a platform label only when something real is behind it", async () => {
    await deployedApplication();
    const real = await app.request(`/v1/ingress/ask?domain=${APPLICATION}.${PLATFORM_DOMAIN}`);
    expect(real.status).toBe(200);

    /* A label is an application name and nothing else: a deployment version
       under the same domain names no application, so it is served by none. */
    const direct = await app.request(`/v1/ingress/ask?domain=${VERSION}.${PLATFORM_DOMAIN}`);
    expect(direct.status).toBe(404);

    await createApplication(clock.ctx, { name: OTHER_APPLICATION });
    const undeployed = await app.request(
      `/v1/ingress/ask?domain=${OTHER_APPLICATION}.${PLATFORM_DOMAIN}`,
    );
    expect(undeployed.status).toBe(404);

    const junk = await app.request(`/v1/ingress/ask?domain=nothing.${PLATFORM_DOMAIN}`);
    expect(junk.status).toBe(404);
  });

  it("answers for a custom domain an application has claimed", async () => {
    await deployedApplication();
    await claimDomain(clock.ctx, CUSTOM_DOMAIN, APPLICATION);

    const response = await app.request(`/v1/ingress/ask?domain=${CUSTOM_DOMAIN}`);

    expect(response.status).toBe(200);
  });

  it("REFUSES a claim whose application has been retired", async () => {
    await deployedApplication();
    await claimDomain(clock.ctx, CUSTOM_DOMAIN, APPLICATION);
    await retireApplication(clock.ctx, APPLICATION);

    const response = await app.request(`/v1/ingress/ask?domain=${CUSTOM_DOMAIN}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:not-found" });
  });

  it("answers for it again once it is taken back", async () => {
    await deployedApplication();
    await claimDomain(clock.ctx, CUSTOM_DOMAIN, APPLICATION);

    const retired = await app.request(`/v1/applications/${APPLICATION}/retire`, {
      method: "POST",
      headers: await bearer(),
    });
    expect(retired.status).toBe(200);
    const taken = await app.request(`/v1/applications/${APPLICATION}/unretire`, {
      method: "POST",
      headers: await bearer(),
    });
    expect(taken.status).toBe(200);

    const response = await app.request(`/v1/ingress/ask?domain=${CUSTOM_DOMAIN}`);

    expect(response.status).toBe(200);
  });

  it("refuses a claim left behind by an application that is gone", async () => {
    await deployedApplication();
    await claimDomain(clock.ctx, CUSTOM_DOMAIN, APPLICATION);
    await deleteKey(clock.ctx, applicationKey(APPLICATION));

    const response = await app.request(`/v1/ingress/ask?domain=${CUSTOM_DOMAIN}`);

    expect(response.status).toBe(404);
  });

  it("refuses a domain nobody claimed, and anything that is not a host", async () => {
    for (const domain of ["unclaimed.example.com", "not a host", ""]) {
      const response = await app.request(`/v1/ingress/ask?domain=${encodeURIComponent(domain)}`);

      expect(response.status, domain).toBe(404);
    }
  });

  it("APPROVES the bare platform apex, which the wildcard does not cover", async () => {
    const response = await app.request(`/v1/ingress/ask?domain=${PLATFORM_DOMAIN}`);

    expect(response.status).toBe(200);
  });

  it("REFUSES it while the API is not published there", async () => {
    const closed = appWith({ api: { public: false, jsonBytes: 65_536 } });

    const response = await closed.request(`/v1/ingress/ask?domain=${PLATFORM_DOMAIN}`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:not-found" });
  });

  it("still refuses a label under the apex that names nothing, either way", async () => {
    for (const app_ of [app, appWith({ api: { public: false, jsonBytes: 65_536 } })]) {
      const response = await app_.request(`/v1/ingress/ask?domain=nothing.${PLATFORM_DOMAIN}`);

      expect(response.status).toBe(404);
    }
  });
});

describe("the fleet's API at the platform apex", () => {
  it("dispatches the bare apex to the API routes rather than to the host surface", async () => {
    const health = await app.request("/.well-known/scafo/health", {
      headers: { host: PLATFORM_DOMAIN },
    });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      version: TEST_VERSIONS.scafo,
      node: NODE_ID,
    });
  });

  it("answers a path it does not have there as the API's own miss", async () => {
    const response = await app.request("/v1/nope", { headers: { host: PLATFORM_DOMAIN } });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toMatchObject({ type: "about:blank", status: 404 });
  });

  it("keeps every route's own token gating, opening nothing", async () => {
    const state = await app.request("/v1/state", { headers: { host: PLATFORM_DOMAIN } });

    expect(state.status).toBe(401);
    await expect(state.json()).resolves.toMatchObject(AUTH_INVALID_PROBLEM);
  });
});

describe("routes that do not exist", () => {
  it("answers as a problem document, without pretending it is an auth failure", async () => {
    for (const path of ["/v1/nope", "/", "/v1/state/extra", "/v1/health"]) {
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
    const response = await app.request("/.well-known/scafo/health", { method: "POST" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ type: "about:blank", status: 404 });
  });
});

describe("renderProblem", () => {
  it("answers a scafo failure with that error's own problem document", async () => {
    const thrown = new ScafoError("cas-conflict", "Conditional write failed", {
      detail: "the object changed under the write",
    });

    const response = renderProblem(asHandlerThrew(thrown));

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    await expect(response.json()).resolves.toEqual({
      type: "urn:scafo:cas-conflict",
      title: "Conditional write failed",
      status: 409,
      detail: "the object changed under the write",
    });
  });

  it("keeps the status and the reason of a failure raised by the HTTP layer itself", async () => {
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
    await expect(response.json()).resolves.toEqual({
      type: "urn:scafo:internal",
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
 * which the layer does for every thrown error, a deliberate scafo failure included.
 */
function asHandlerThrew(thrown: Error): HTTPError {
  const wrapped = new HTTPError(thrown);
  return Object.assign(wrapped, { unhandled: true });
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

/** The same app again, with part of the configuration stated differently. */
function appWith(overrides: Partial<DaemonConfig>): H3 {
  return createNodeApp({
    config: { ...daemonConfig(), ...overrides },
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    versions: TEST_VERSIONS,
  });
}

/** The same app again, reporting `status` as the last pass of its reconcile loop. */
function appReconciling(status: ReconcileStatus): H3 {
  return createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    versions: TEST_VERSIONS,
    reconciler: {
      runOnce: () => Promise.resolve([]),
      kick: () => {},
      reload: (): Promise<void> => Promise.resolve(),
      start: () => {},
      shutdown: () => Promise.resolve(),
      stop: () => {},
      status: () => status,
      fleetRouting: () => undefined,
    },
  });
}

/** Reports a fixed inventory; nothing it is asked to run would run. */
function fakeSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => PROCESSES.map((status) => ({ ...status })),
    forget: () => {},
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

/** An application the routes that need something to act on can act on. */
async function deployable(): Promise<void> {
  await createApplication(clock.ctx, { name: APPLICATION });
}

/** The same application, with a deployment behind it, so it is publicly served. */
async function deployedApplication(): Promise<void> {
  await deployable();
  await createDeployment(clock.ctx, APPLICATION, { version: VERSION });
  await recordRevision(clock.ctx, APPLICATION, VERSION);
}

/** One call to the selector route with `sent` as the whole body. */
async function selectorRequest(sent: Record<string, unknown>): Promise<Response> {
  return app.request(`/v1/applications/${APPLICATION}/selector`, {
    method: "POST",
    headers: { ...(await bearer()), "content-type": "application/json" },
    body: JSON.stringify(sent),
  });
}

/** The same call, asserted to have succeeded, with its body read back. */
async function selectorBody(sent: Record<string, unknown>): Promise<ApplicationResult> {
  const response = await selectorRequest(sent);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ApplicationResult;
}

/**
 * A second app for this node, holding the lease and reporting `unplaced` as the
 * account of its last assignment pass. The lease is a real one, because that is
 * what the state route reads the election from.
 */
async function appCoordinating(unplaced: AssignmentFailure[]): Promise<H3> {
  const held = await acquireLease(clock.ctx, NODE_ID);
  if (held === null) throw new Error("the fixture could not take the lease");

  return createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_ID,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    versions: TEST_VERSIONS,
    coordinator: {
      start: () => {},
      stop: () => Promise.resolve(),
      runOnce: () => Promise.resolve(),
      handle: () => held,
      status: () => ({
        holding: true,
        lease: held.lease,
        lastReapAt: null,
        lastReapFailure: null,
        lastAssignAt: new Date(clock.nowMs()).toISOString(),
        lastAssignment: {
          live: [NODE_ID],
          changed: [],
          removed: [],
          skipped: [],
          unplaced,
        },
        lastAssignFailure: null,
        skippedAssignments: 0,
      }),
    },
  });
}
