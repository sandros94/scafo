/*
 * Deploy intake: who may upload an artifact, what an upload must say, and the
 * states a deploy moves through once it has been accepted.
 *
 * Nothing is published for real — the runner is a stand-in and the reconcile
 * loop is a fixed report — but the artifact is a genuine `.tar.zst`, packed by
 * the same code the client uses, so the whole multipart path is exercised.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3 } from "h3";
import type { JWK_RSA_Private, JWK_RSA_Public, JWKSet } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentContext, type AliasResult, createAgentApp } from "../src/agent/app.ts";
import type { AgentConfig } from "../src/agent/config.ts";
import { createDeployService, type DeployStatus } from "../src/agent/deploys.ts";
import type { Reconciler } from "../src/agent/reconcile.ts";
import { OIDC_AUDIENCE, signNodeToken } from "../src/core/auth/index.ts";
import type { ProblemDetails } from "../src/core/error.ts";
import {
  createEnvironment,
  createProject,
  envWakeKey,
  getBuild,
  getEnvironment,
  readEnvironmentWake,
  registerNode,
  setTrustPolicy,
} from "../src/core/registry/index.ts";
import type { DeployRunInput, DeployRunResult, DeployRunner } from "../src/core/types/deploy.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { CasStore } from "../src/core/types/store.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { packDirectory } from "../src/drivers/archive/tar-zst.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const OPERATOR = "op-1234abcd";
const PROJECT = "shop";
const RIVAL = "rival";
const ENVIRONMENT = "production";
const VERSION_ID = "abc123def456";
const PREFIX = "installations/one";

const ISS = "https://issuer.test";
const DISCOVERY_URL = `${ISS}/.well-known/openid-configuration`;
const JWKS_URL = `${ISS}/keys.json`;
const KID = "issuer-key-1";
const SUBJECT = "repo:acme/shop:ref:refs/heads/main";

/** Every problem body a rejected caller may see, whatever was wrong with its token. */
const AUTH_INVALID_PROBLEM = {
  type: "urn:scafo:auth-invalid",
  title: "Authentication failed",
  status: 401,
};

let issuerKeys: { privateKey: JWK_RSA_Private<"RS256">; publicKey: JWK_RSA_Public<"RS256"> };
let operatorKeys: Awaited<ReturnType<typeof generateJWK<"EdDSA">>>;
let artifact: Uint8Array;

let clock: ManualClock;
let agent: AgentContext;
let app: H3;
let runs: DeployRunInput[];
let publish: () => Promise<DeployRunResult>;
let running: RuntimeProcess[];

beforeAll(async () => {
  issuerKeys = await generateJWK("RS256", { kid: KID });
  operatorKeys = await generateJWK("EdDSA", { kid: OPERATOR });

  const dir = await mkdtemp(join(tmpdir(), "scafo-artifact-"));
  await writeFile(join(dir, "wrangler.jsonc"), '{ "name": "shop" /* the app */ }');
  await writeFile(join(dir, "index.mjs"), "export default { fetch: () => new Response('hi') };");
  artifact = await packDirectory(dir);
});

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  runs = [];
  running = [];
  publish = () => Promise.resolve({ celldVersionId: VERSION_ID });

  const record: NodeRecord = {
    v: 1,
    id: OPERATOR,
    publicKey: { kty: "OKP", crv: "Ed25519", x: operatorKeys.publicKey.x },
    addresses: { internal: "operator", agentPort: 0 },
  };
  await registerNode(clock.ctx, record);

  for (const project of [PROJECT, RIVAL]) await createProject(clock.ctx, { slug: project });
  /* Only one project trusts the issuer; the other is what a cross-project
     attempt is aimed at. */
  await setTrustPolicy(clock.ctx, PROJECT, {
    v: 1,
    issuers: [{ iss: ISS, aud: OIDC_AUDIENCE, subjects: ["repo:acme/*"] }],
  });

  agent = {
    config: agentConfig(),
    nodeId: OPERATOR,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: "0.0.0-test",
    reconciler: fakeReconciler(),
  };
  agent.deploys = createDeployService(agent, fakeRunner(), {
    routedTimeoutMs: 300,
    pollMs: 5,
  });
  app = createAgentApp(agent);

  vi.stubGlobal("fetch", issuerFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("who may deploy", () => {
  it("accepts an operator's token, answering at once with where to watch", async () => {
    const response = await upload(await operatorToken());
    const status = (await response.json()) as DeployStatus;

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/v1/deploys/${status.id}`);
    expect(status).toMatchObject({ project: PROJECT, state: "accepted", warnings: [] });
  });

  it("accepts a workload token the project's trust policy admits", async () => {
    const response = await upload(await workloadToken());

    expect(response.status).toBe(202);
    await expect(settled((await responseId(response)) as string)).resolves.toMatchObject({
      state: "deployed",
    });
  });

  it("refuses every bad token with one problem document, whatever was wrong", async () => {
    const stranger = await generateJWK("EdDSA", { kid: OPERATOR });
    const expiredAt = Math.floor(Date.now() / 1000) - 3600;
    const rejected = [
      undefined,
      "not-a-token",
      "a.b.c",
      await signNodeToken(stranger.privateKey, OPERATOR),
      await signNodeToken(operatorKeys.privateKey, "op-deadbeef"),
      /* A workload token the policy would admit, had it not run out. */
      await workloadToken({ iat: expiredAt - 3600, exp: expiredAt }),
    ];

    const baseline = await (await upload(undefined)).text();
    expect(JSON.parse(baseline)).toEqual(AUTH_INVALID_PROBLEM);

    for (const token of rejected) {
      const response = await upload(token);

      expect(response.status, `for ${String(token)}`).toBe(401);
      expect(await response.text(), `for ${String(token)}`).toBe(baseline);
    }
  });

  it("refuses a workload token trusted for one project the run of another", async () => {
    /* The token is genuine and its own project would admit it. Deploying into a
       project that does not name its issuer is authorization, and is said so. */
    const response = await upload(await workloadToken(), { ...meta(), project: RIVAL });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:trust-mismatch" });
    expect(runs).toEqual([]);
  });

  it("refuses a subject its own project's policy does not name", async () => {
    const response = await upload(await workloadToken({ sub: "repo:evil/app" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:trust-mismatch" });
    expect(runs).toEqual([]);
  });
});

describe("what an upload must carry", () => {
  it("refuses a body that is not a form at all", async () => {
    const response = await app.request("/v1/deploys", {
      method: "POST",
      headers: { "authorization": `Bearer ${await operatorToken()}`, "content-type": "text/plain" },
      body: "just some bytes",
    });

    await expect(problemOf(response)).resolves.toMatchObject({
      type: "urn:scafo:invalid-input",
      status: 400,
    });
  });

  it("refuses a form that is missing either part", async () => {
    const withoutMeta = new FormData();
    withoutMeta.set("artifact", blob());
    const withoutArtifact = new FormData();
    withoutArtifact.set("meta", JSON.stringify(meta()));

    for (const [what, body] of [
      ["meta", withoutMeta],
      ["artifact", withoutArtifact],
    ] as const) {
      const response = await post("/v1/deploys", await operatorToken(), body);
      const problem = await problemOf(response);

      expect(problem.status, `without ${what}`).toBe(400);
      expect(problem.detail, `without ${what}`).toContain(what);
    }
  });

  it("refuses meta that does not say whether the build reads its config at runtime", async () => {
    const { runtimeConfigurable: _dropped, ...rest } = meta();

    const response = await upload(await operatorToken(), rest);

    await expect(problemOf(response)).resolves.toMatchObject({
      status: 400,
      detail: expect.stringContaining("runtimeConfigurable"),
    });
  });

  it("refuses names the registry could not address", async () => {
    const bad = [
      { project: "Not A Slug" },
      { environment: "UPPER" },
      { buildId: "nothex" },
      { flip: "yes" },
      { replicas: 0 },
      { replicas: "every" },
      { nodeSelector: "tier=fast" },
      { nodeSelector: {} },
      { nodeSelector: { Tier: "fast" } },
    ];

    for (const patch of bad) {
      const response = await upload(await operatorToken(), { ...meta(), ...patch });

      expect(response.status, `for ${JSON.stringify(patch)}`).toBe(400);
    }
    expect(runs).toEqual([]);
  });
});

describe("what happens to an accepted deploy", () => {
  it("publishes the artifact into the environment's fleet and records the build", async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed", build: VERSION_ID });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      project: PROJECT,
      environment: ENVIRONMENT,
      /* Defaulted from the project when the upload named no script. */
      script: PROJECT,
      target: { prefix: `${PREFIX}/fleets/${PROJECT}/${ENVIRONMENT}`, bucket: "registry" },
    });
    /* The bytes the client packed arrive intact through the multipart body. */
    expect(runs[0]?.artifact).toEqual(artifact);

    const build = await getBuild(clock.ctx, PROJECT, VERSION_ID);
    expect(build).toMatchObject({ celldVersionId: VERSION_ID, runtimeConfigurable: false });

    /* Nothing was flipped: this upload did not ask for it. */
    const environment = await getEnvironment(clock.ctx, PROJECT, ENVIRONMENT);
    expect(environment.alias).toBeNull();
  });

  it("deploys into an ephemeral environment somebody else created", async () => {
    /*
     * A preview environment is created ephemeral, with an idle window that
     * eventually reaps it. A deploy only needs that environment to exist — it
     * expresses no opinion about how it was set up — so it must not be refused
     * for disagreeing with settings it never named.
     */
    await createEnvironment(clock.ctx, PROJECT, {
      name: "preview",
      ephemeral: true,
      idleTtlS: 900,
    });

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), environment: "preview" }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    /* And it is still the environment it was: the deploy created nothing. */
    await expect(getEnvironment(clock.ctx, PROJECT, "preview")).resolves.toMatchObject({
      ephemeral: true,
      idleTtlS: 900,
    });
  });

  it("creates the environment with the replica count the upload asked for", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), environment: "fresh", replicas: 1 }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getEnvironment(clock.ctx, PROJECT, "fresh")).resolves.toMatchObject({
      replicas: 1,
    });
  });

  it("restates the replica count of an environment that already exists", async () => {
    await createEnvironment(clock.ctx, PROJECT, { name: "scaled", replicas: 3 });

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), environment: "scaled", replicas: "all" }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getEnvironment(clock.ctx, PROJECT, "scaled")).resolves.toMatchObject({
      replicas: "all",
    });
  });

  it("leaves the replica count alone when the upload names none", async () => {
    /* How many nodes serve an environment is an operational decision. A deploy
       that silently rewrote it would move an application off nodes because
       somebody re-ran a pipeline that never mentioned placement. */
    await createEnvironment(clock.ctx, PROJECT, { name: "scaled", replicas: 2 });

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), environment: "scaled" }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getEnvironment(clock.ctx, PROJECT, "scaled")).resolves.toMatchObject({
      replicas: 2,
    });
  });

  it("creates the environment with the node selector the upload asked for", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), {
        ...meta(),
        environment: "targeted",
        nodeSelector: { tier: "fast" },
      }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getEnvironment(clock.ctx, PROJECT, "targeted")).resolves.toMatchObject({
      nodeSelector: { tier: "fast" },
    });
  });

  it("restates the node selector of an environment that already exists", async () => {
    await createEnvironment(clock.ctx, PROJECT, {
      name: "targeted",
      nodeSelector: { tier: "slow" },
    });

    const id = (await responseId(
      await upload(await operatorToken(), {
        ...meta(),
        environment: "targeted",
        nodeSelector: { tier: "fast" },
      }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getEnvironment(clock.ctx, PROJECT, "targeted")).resolves.toMatchObject({
      nodeSelector: { tier: "fast" },
    });
  });

  it("leaves the node selector alone when the upload names none", async () => {
    /* Where an application runs is an operational decision. A deploy that
       silently lifted a constraint would spread it across a fleet because
       somebody re-ran a pipeline that never mentioned placement — and lifting
       one is `scafo env selector --clear`, which says so out loud. */
    await createEnvironment(clock.ctx, PROJECT, {
      name: "targeted",
      nodeSelector: { tier: "fast" },
    });

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), environment: "targeted" }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getEnvironment(clock.ctx, PROJECT, "targeted")).resolves.toMatchObject({
      nodeSelector: { tier: "fast" },
    });
  });

  it("records the build under the id the upload chose, when it chose one", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), buildId: "0f0f0f0f" }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ build: "0f0f0f0f" });
    await expect(getBuild(clock.ctx, PROJECT, "0f0f0f0f")).resolves.toMatchObject({
      celldVersionId: VERSION_ID,
    });
  });

  it("reaches routed once the reconcile loop reports the build serving traffic", async () => {
    running = [readyProcess(VERSION_ID)];

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), flip: true }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "routed", build: VERSION_ID });
    const environment = await getEnvironment(clock.ctx, PROJECT, ENVIRONMENT);
    expect(environment.alias?.build).toBe(VERSION_ID);
  });

  it("stops at deployed with a warning when nothing becomes ready in time", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), flip: true }),
    )) as string;

    const status = await settled(id);
    /* Never an error: the build exists and the alias points at it, so the loop
       goes on trying long after the deploy stopped watching. */
    expect(status.state).toBe("deployed");
    expect(status.warnings.map((warning) => warning.code)).toEqual(["deploy-not-routed"]);
  });

  it("carries a flip's own warnings through to the status", async () => {
    running = [readyProcess(VERSION_ID)];
    await createEnvironment(clock.ctx, PROJECT, { name: ENVIRONMENT, varset: "a1b2c3d4" });

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), flip: true }),
    )) as string;

    const status = await settled(id);
    expect(status.state).toBe("routed");
    expect(status.warnings.map((warning) => warning.code)).toEqual([
      "build-not-runtime-configurable",
    ]);
  });

  it("reports a publish that threw as failed, and says why", async () => {
    publish = () => Promise.reject(new Error("celld exited with code 1"));

    const id = (await responseId(await upload(await operatorToken()))) as string;

    const status = await settled(id);
    expect(status.state).toBe("failed");
    expect(status.detail).toContain("celld exited with code 1");
    expect(status.build).toBeUndefined();
  });
});

describe("the wake a deploy is", () => {
  it("stamps the environment awake once the new build is serving traffic", async () => {
    running = [readyProcess(VERSION_ID)];
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toBeNull();

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), flip: true }),
    )) as string;

    /* A deploy IS a wake: what has just been brought into service must not park
       for having had no request of its own yet. */
    await expect(settled(id)).resolves.toMatchObject({ state: "routed" });
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
  });

  it("stamps it awake when the deploy was not asked to flip either", async () => {
    /* The build exists and is startable, which is the whole of what this deploy
       asked for; the environment is no less freshly deployed for it. */
    const id = (await responseId(await upload(await operatorToken()))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
  });

  it("stamps it awake even when it gives up waiting for the routing", async () => {
    /* Missing the deadline is a warning and never a failure — the alias points
       at the build and the loop keeps trying — so the environment it is trying
       for must not park out from under it in the meantime. */
    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), flip: true }),
    )) as string;

    const status = await settled(id);
    expect(status.warnings.map((warning) => warning.code)).toEqual(["deploy-not-routed"]);
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
  });

  it("carries the deploy through a stamp the bucket refused", async () => {
    /*
     * The deploy succeeded: the build exists and the alias points at it. A stamp
     * only delays parking, and the next wake or the next deploy writes it again
     * — so failing the deploy over one would report a failure that did not
     * happen and send a pipeline into a retry that changes nothing.
     */
    running = [readyProcess(VERSION_ID)];
    agent.registry = { ...clock.ctx, store: refusingWakeStamps(clock.ctx.store) };

    const id = (await responseId(
      await upload(await operatorToken(), { ...meta(), flip: true }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "routed", build: VERSION_ID });
    await expect(getBuild(clock.ctx, PROJECT, VERSION_ID)).resolves.toMatchObject({
      id: VERSION_ID,
    });
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toBeNull();
  });
});

describe("polling a deploy", () => {
  it("hands an operator the status of a deploy it started", async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;
    await settled(id);

    const response = await get(`/v1/deploys/${id}`, await operatorToken());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id, state: "deployed" });
  });

  it("answers an id it has never heard of as a miss, to an operator", async () => {
    const response = await get("/v1/deploys/0000000000000000", await operatorToken());

    await expect(problemOf(response)).resolves.toMatchObject({
      type: "urn:scafo:not-found",
      status: 404,
    });
  });

  it("tells a caller without a token nothing, not even that the id is unknown", async () => {
    const response = await get("/v1/deploys/0000000000000000", undefined);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
  });
});

describe("moving an environment's alias", () => {
  beforeEach(async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;
    await settled(id);
  });

  it("flips to a build and reports the environment as it now stands", async () => {
    const response = await post("/v1/aliases", await operatorToken(), {
      project: PROJECT,
      environment: ENVIRONMENT,
      build: VERSION_ID,
    });
    const result = (await response.json()) as AliasResult;

    expect(response.status).toBe(200);
    expect(result.environment.alias?.build).toBe(VERSION_ID);
    expect(result.warnings).toEqual([]);
  });

  it("rolls back to the build the environment served before", async () => {
    await createBuildViaDeploy("0f0f0f0f");
    for (const build of [VERSION_ID, "0f0f0f0f"]) {
      await post("/v1/aliases", await operatorToken(), {
        project: PROJECT,
        environment: ENVIRONMENT,
        build,
      });
    }

    const response = await post("/v1/aliases", await operatorToken(), {
      project: PROJECT,
      environment: ENVIRONMENT,
      rollback: true,
    });
    const result = (await response.json()) as AliasResult;

    expect(response.status).toBe(200);
    expect(result.environment.alias).toMatchObject({ build: VERSION_ID, previous: "0f0f0f0f" });
  });

  it("refuses a workload token from a project that is not the one being flipped", async () => {
    await createEnvironment(clock.ctx, RIVAL, { name: ENVIRONMENT });

    const response = await post("/v1/aliases", await workloadToken(), {
      project: RIVAL,
      environment: ENVIRONMENT,
      build: VERSION_ID,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:trust-mismatch" });
  });

  it("refuses a flip that names no build", async () => {
    const response = await post("/v1/aliases", await operatorToken(), {
      project: PROJECT,
      environment: ENVIRONMENT,
    });

    await expect(problemOf(response)).resolves.toMatchObject({ status: 400 });
  });
});

/* ---- fixtures ---- */

function agentConfig(): AgentConfig {
  return {
    bucket: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      prefix: PREFIX,
      accessKey: "key",
      secretKey: "secret",
    },
    node: { id: OPERATOR, listen: "127.0.0.1:7400" },
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
  };
}

function fakeSupervisor(): Supervisor {
  return {
    start: (spec) => Promise.reject(new Error(`unexpected start of "${spec.id}"`)),
    stop: () => Promise.resolve(),
    status: () => null,
    list: () => [],
    onExit: () => {},
  };
}

/** Reports whatever the test has decided is running; nothing else. */
function fakeReconciler(): Reconciler {
  return {
    runOnce: () => Promise.resolve([]),
    kick: () => {},
    parkedRecords: () => [],
    start: () => {},
    stop: () => {},
    status: () => ({
      lastRunAt: null,
      running: false,
      lastActions: [],
      failures: [],
      processes: running,
      placements: [],
      parked: [],
    }),
  };
}

function fakeRunner(): DeployRunner {
  return {
    run(input) {
      runs.push(input);
      return publish();
    },
  };
}

/** A store that refuses the wake stamp alone, and answers every other write. */
function refusingWakeStamps(inner: CasStore): CasStore {
  const stamp = envWakeKey(PROJECT, ENVIRONMENT);
  return {
    get: (key) => inner.get(key),
    put: (key, body, cas) =>
      key === stamp
        ? Promise.reject(new Error("the bucket refused the stamp"))
        : inner.put(key, body, cas),
    del: (key) => inner.del(key),
    list: (prefix) => inner.list(prefix),
  };
}

function readyProcess(build: string): RuntimeProcess {
  return {
    processId: `${PROJECT}--${ENVIRONMENT}--${build}`,
    project: PROJECT,
    env: ENVIRONMENT,
    build,
    port: 42_000,
    internalPort: 42_001,
    ready: true,
  };
}

function meta(): Record<string, unknown> {
  return { project: PROJECT, runtimeConfigurable: false };
}

function blob(): Blob {
  return new Blob([artifact as BlobPart]);
}

/* ---- driving the app ---- */

/** Uploads the artifact with `sent` as the whole of its meta part. */
function upload(
  token: string | undefined,
  sent: Record<string, unknown> = meta(),
): Promise<Response> {
  const body = new FormData();
  body.set("meta", JSON.stringify(sent));
  body.set("artifact", blob(), "artifact.tar.zst");
  return post("/v1/deploys", token, body);
}

async function post(
  path: string,
  token: string | undefined,
  body: FormData | Record<string, unknown>,
): Promise<Response> {
  const isForm = body instanceof FormData;
  return app.request(path, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(isForm ? {} : { "content-type": "application/json" }),
    },
    body: isForm ? body : JSON.stringify(body),
  });
}

async function get(path: string, token: string | undefined): Promise<Response> {
  return app.request(path, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

async function responseId(response: Response): Promise<string | undefined> {
  expect(response.status).toBe(202);
  return ((await response.json()) as DeployStatus).id;
}

/** Waits for a deploy to stop moving, and hands back where it stopped. */
async function settled(id: string): Promise<DeployStatus> {
  return vi.waitFor(
    () => {
      const status = agent.deploys?.get(id) ?? null;
      expect(status?.state).not.toBe("accepted");
      expect(status?.state).not.toBe("uploading");
      return status as DeployStatus;
    },
    { timeout: 5000, interval: 5 },
  );
}

/** Records a second build, so a rollback has somewhere to go. */
async function createBuildViaDeploy(buildId: string): Promise<void> {
  const id = (await responseId(
    await upload(await operatorToken(), { ...meta(), buildId }),
  )) as string;
  await settled(id);
}

async function problemOf(response: Response): Promise<ProblemDetails> {
  expect(response.headers.get("content-type")).toBe("application/problem+json");
  return (await response.json()) as ProblemDetails;
}

/* ---- tokens ---- */

/** A token this node's registered operator key verifies, good for one request. */
function operatorToken(): Promise<string> {
  return signNodeToken(operatorKeys.privateKey, OPERATOR);
}

/**
 * A workload token, minted against the wall clock: the app builds its own OIDC
 * verifier, which reads the real one, so a token dated by the test's manual
 * clock would arrive expired.
 */
function workloadToken(overrides?: Record<string, unknown>): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return signJws(
    { iss: ISS, aud: OIDC_AUDIENCE, sub: SUBJECT, iat, exp: iat + 3600, ...overrides },
    issuerKeys.privateKey,
    { alg: "RS256", protectedHeader: { kid: KID } },
  );
}

/** Serves the issuer's discovery document and key set, and nothing else. */
function issuerFetch(input: RequestInfo | URL): Promise<Response> {
  const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
  const body =
    url === DISCOVERY_URL
      ? { issuer: ISS, jwks_uri: JWKS_URL }
      : url === JWKS_URL
        ? ({ keys: [issuerKeys.publicKey] } satisfies JWKSet)
        : null;

  if (body === null) return Promise.resolve(new Response("no such document", { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify(body)));
}
