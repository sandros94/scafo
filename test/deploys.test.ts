/*
 * Deploy intake: who may upload an artifact, what an upload must say, and the
 * states a deploy moves through once it has been accepted.
 *
 * Nothing is published for real — the runner is a stand-in and the reconcile
 * loop is a fixed report — but the artifact is a genuine `.tar.zst`, packed by
 * the same code the client uses, so raw streaming and file staging are exercised.
 */

import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { H3 } from "h3";
import type { JWK_RSA_Private, JWK_RSA_Public, JWKSet } from "unjwt/jwk";
import { generateJWK } from "unjwt/jwk";
import { sign as signJws } from "unjwt/jws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DaemonContext, createNodeApp } from "../src/daemon/app.ts";
import type { DaemonConfig } from "../src/daemon/config.ts";
import { createDeployService, type DeployStatus } from "../src/daemon/deploys.ts";
import { createCreditController } from "../src/daemon/_credit-controller.ts";
import {
  DEPLOY_METADATA_HEADER,
  DEPLOY_METADATA_MAX_BYTES,
  encodeDeployMetadata,
} from "../src/daemon/_intake.ts";
import type { Reconciler } from "../src/daemon/reconcile.ts";
import { OIDC_AUDIENCE, signNodeToken } from "../src/core/auth/index.ts";
import { ScafoError, type ProblemDetails } from "../src/core/error.ts";
import {
  blockProject,
  createEnvironment,
  createProject,
  envWakeKey,
  environmentKey,
  getBuild,
  getEnvironment,
  placementKey,
  pointerLockKey,
  readEnvironmentWake,
  registerNode,
  setTrustPolicy,
  unblockProject,
} from "../src/core/registry/index.ts";
import type {
  DeployRunInput,
  DeployRunResult,
  DeployRunner,
  StagedArtifact,
} from "../src/core/types/deploy.ts";
import type { NodeRecord } from "../src/core/types/registry.ts";
import type { CasStore } from "../src/core/types/store.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { packDirectory } from "../src/drivers/archive/tar-zst.ts";
import { createFileArtifactStager } from "../src/drivers/artifact/file.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, type ManualClock } from "./_helpers.ts";

const OPERATOR = "op-1234abcd";
/** A second node of the same installation, and where its daemon answers. */
const NODE_B = "node-b1b1b1b1";
const PEER_HOST = "node-b.test";
const PEER_PORT = 7401;
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
let artifact: StagedArtifact;
let artifactBytes: Uint8Array;

let clock: ManualClock;
let daemon: DaemonContext;
let app: H3;
let runs: DeployRunInput[];
let receivedArtifacts: Uint8Array[];
let publish: () => Promise<DeployRunResult>;
let running: RuntimeProcess[];
let issuerCalls: string[];

beforeAll(async () => {
  issuerKeys = await generateJWK("RS256", { kid: KID });
  operatorKeys = await generateJWK("EdDSA", { kid: OPERATOR });

  const dir = await mkdtemp(join(tmpdir(), "scafo-artifact-"));
  await writeFile(join(dir, "wrangler.jsonc"), '{ "name": "shop" /* the app */ }');
  await writeFile(join(dir, "index.mjs"), "export default { fetch: () => new Response('hi') };");
  artifact = await packDirectory(dir);
  artifactBytes = new Uint8Array(await new Response(artifact.open()).arrayBuffer());
});

beforeEach(async () => {
  clock = ctxWith(new MemoryCasStore());
  runs = [];
  receivedArtifacts = [];
  issuerCalls = [];
  running = [];
  publish = () => Promise.resolve({ celldVersionId: VERSION_ID });

  const record: NodeRecord = {
    v: 1,
    id: OPERATOR,
    publicKey: { kty: "OKP", crv: "Ed25519", x: operatorKeys.publicKey.x },
    addresses: { internal: "operator", apiPort: 0 },
  };
  await registerNode(clock.ctx, record);

  for (const project of [PROJECT, RIVAL]) await createProject(clock.ctx, { slug: project });
  /* Only one project trusts the issuer; the other is what a cross-project
     attempt is aimed at. */
  await setTrustPolicy(clock.ctx, PROJECT, {
    v: 1,
    issuers: [{ iss: ISS, aud: OIDC_AUDIENCE, subjects: ["repo:acme/*"] }],
  });

  daemon = {
    config: daemonConfig(),
    nodeId: OPERATOR,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: "0.0.0-test",
    reconciler: fakeReconciler(),
    credits: createCreditController({ allocatableMb: 10_000, surgeMb: 512 }),
  };
  daemon.deploys = createDeployService(daemon, fakeRunner(), {
    routedTimeoutMs: 300,
    pollMs: 5,
  });
  daemon.artifactStager = createFileArtifactStager();
  app = createNodeApp(daemon);

  vi.stubGlobal("fetch", issuerFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await artifact.dispose();
});

describe("who may deploy", () => {
  it("never reads an invalid node token's artifact body", async () => {
    const stranger = await generateJWK("EdDSA", { kid: OPERATOR });
    let reads = 0;
    const response = await streamedUpload(
      await signNodeToken(stranger.privateKey, OPERATOR),
      PROJECT,
      meta(),
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });

  it("never reads an invalid workload token's artifact body", async () => {
    const valid = await workloadToken();
    const [header, payload, signature] = valid.split(".") as [string, string, string];
    const forged = `${header}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    let reads = 0;
    const response = await streamedUpload(
      forged,
      PROJECT,
      meta(),
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });

  it("never reads a trust-mismatched workload's artifact body", async () => {
    let reads = 0;
    const response = await streamedUpload(
      await workloadToken({ sub: "repo:evil/app" }),
      PROJECT,
      { runtimeConfigurable: false },
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:trust-mismatch" });
    expect(reads).toBe(0);
  });

  it("accepts an operator's token, answering at once with where to watch", async () => {
    const response = await upload(await operatorToken());
    const status = (await response.json()) as DeployStatus;

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(`/v1/deploys/${status.id}`);
    expect(status).toMatchObject({ project: PROJECT, state: "accepted", warnings: [] });
  });

  it("answers 202 without awaiting builder completion", async () => {
    const builder = Promise.withResolvers<DeployRunResult>();
    publish = () => builder.promise;

    const response = await upload(await operatorToken());
    const status = (await response.json()) as DeployStatus;

    expect(response.status).toBe(202);
    expect(status.state).toBe("accepted");
    expect(daemon.deploys?.get(status.id)?.state).toMatch(/accepted|uploading/);
    builder.resolve({ celldVersionId: VERSION_ID });
    await settled(status.id);
  });

  it("refuses overload before reading the artifact body", async () => {
    daemon.deploys = createDeployService(daemon, fakeRunner(), {
      scheduler: {
        artifactBytes: 100,
        activeTasks: 1,
        projectActiveTasks: 1,
        queuedTasks: 0,
        projectQueuedTasks: 0,
        stagedBytes: 100,
        projectStagedBytes: 100,
        receiveTimeoutMs: 600_000,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 300_000,
      },
    });
    let reads = 0;

    const response = await streamedUpload(
      await operatorToken(),
      PROJECT,
      { runtimeConfigurable: false },
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
    expect(reads).toBe(0);
  });

  it("times out a partial receive without a status or staged file", async () => {
    const staging = await mkdtemp(join(tmpdir(), "scafo-receive-timeout-"));
    daemon.artifactStager = createFileArtifactStager({ stagingDir: staging });
    daemon.deploys = createDeployService(daemon, fakeRunner(), {
      scheduler: {
        artifactBytes: 100,
        activeTasks: 1,
        projectActiveTasks: 1,
        queuedTasks: 1,
        projectQueuedTasks: 1,
        stagedBytes: 100,
        projectStagedBytes: 100,
        receiveTimeoutMs: 10,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 300_000,
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(stream): void {
        stream.enqueue(new Uint8Array([1]));
      },
      pull: () => new Promise<void>(() => {}),
    });

    const response = await streamedUpload(
      await operatorToken(),
      PROJECT,
      { runtimeConfigurable: false },
      body,
    );

    expect(response.status).toBe(408);
    expect(response.headers.get("location")).toBeNull();
    expect(runs).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("disposes a staged artifact when enqueue refuses before ownership transfer", async () => {
    const cap = artifactBytes.byteLength;
    daemon.deploys = createDeployService(daemon, fakeRunner(), {
      history: 1,
      scheduler: {
        artifactBytes: cap,
        activeTasks: 1,
        projectActiveTasks: 1,
        queuedTasks: 1,
        projectQueuedTasks: 1,
        stagedBytes: cap,
        projectStagedBytes: cap,
        receiveTimeoutMs: 600_000,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 300_000,
      },
    });
    running = [readyProcess(VERSION_ID)];
    const retained = (await responseId(await upload(await operatorToken()))) as string;
    await settled(retained);
    runs = [];
    const dispose = vi.fn(() => Promise.resolve());
    daemon.artifactStager = {
      stage: () =>
        Promise.resolve({
          byteLength: cap + 1,
          open: () => new Blob([new Uint8Array([1])]).stream(),
          dispose,
        }),
    };

    const response = await upload(await operatorToken());

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(runs).toEqual([]);
    expect(daemon.deploys.get(retained)).not.toBeNull();
  });

  it("keeps pre-handoff capacity charged when staged-artifact disposal fails", async () => {
    let disposals = 0;
    daemon.artifactStager = {
      stage: () =>
        Promise.resolve({
          byteLength: 101,
          open: () => new Blob([new Uint8Array([1])]).stream(),
          dispose: () => {
            disposals += 1;
            return disposals === 1 ? Promise.reject(new Error("disk busy")) : Promise.resolve();
          },
        }),
    };
    daemon.deploys = createDeployService(daemon, fakeRunner(), {
      scheduler: {
        artifactBytes: 100,
        activeTasks: 1,
        projectActiveTasks: 1,
        queuedTasks: 1,
        projectQueuedTasks: 1,
        stagedBytes: 100,
        projectStagedBytes: 100,
        receiveTimeoutMs: 600_000,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 300_000,
      },
    });

    expect((await upload(await operatorToken())).status).toBe(500);
    expect((await upload(await operatorToken())).status).toBe(429);
    expect(disposals).toBe(1);

    await daemon.deploys.stop(new Error("node stopping"));
    expect(disposals).toBe(2);
  });

  it("makes shutdown join disposal at the completed-stage handoff", async () => {
    const stageCalled = Promise.withResolvers<void>();
    const stagedArtifact = Promise.withResolvers<StagedArtifact>();
    const disposal = Promise.withResolvers<void>();
    const dispose = vi.fn(async (): Promise<void> => disposal.promise);
    daemon.artifactStager = {
      stage: () => {
        stageCalled.resolve();
        return stagedArtifact.promise;
      },
    };

    const uploading = upload(await operatorToken());
    await stageCalled.promise;
    stagedArtifact.resolve({
      byteLength: artifactBytes.byteLength,
      open: () => new Blob([artifactBytes as BlobPart]).stream(),
      dispose,
    });
    let stopped = false;
    const stopping = daemon.deploys!.stop(new Error("node stopping")).then(() => {
      stopped = true;
    });

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(stopped).toBe(false);
    expect(runs).toEqual([]);

    disposal.resolve();
    await stopping;
    const response = await uploading;
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(stopped).toBe(true);
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

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
    expect(runs).toEqual([]);
  });

  it("refuses a subject its own project's policy does not name", async () => {
    const response = await upload(await workloadToken({ sub: "repo:evil/app" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:trust-mismatch" });
    expect(runs).toEqual([]);
  });

  it("keeps pre-verification failures byte-identical and never fetches an untrusted issuer", async () => {
    const valid = await workloadToken();
    const [, payload, signature] = valid.split(".");
    const noPolicy = await upload(valid, { ...meta(), project: RIVAL });
    const wrongIssuer = await upload(await workloadToken({ iss: "https://untrusted.test" }));
    const badSignature = await upload(`${valid.split(".")[0]}.${payload}.${signature}x`);

    const bodies = await Promise.all([noPolicy.text(), wrongIssuer.text(), badSignature.text()]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
    expect(issuerCalls).toEqual([DISCOVERY_URL, JWKS_URL]);
  });

  it("persists only the verified workload actor beside self-asserted source metadata", async () => {
    const response = await upload(await workloadToken(), {
      ...meta(),
      source: {
        provider: "forge",
        repo: "acme/shop",
        ref: "refs/heads/main",
        commit: "abc123",
      },
    });

    const status = await settled((await responseId(response)) as string);
    const build = await getBuild(clock.ctx, PROJECT, status.build as string);
    expect(build.source).toEqual({
      provider: "forge",
      repo: "acme/shop",
      ref: "refs/heads/main",
      commit: "abc123",
    });
    expect(build.oidc).toEqual({ issuer: ISS, subject: SUBJECT });
  });

  it("rejects caller-supplied OIDC provenance and leaves node deploys without it", async () => {
    const rejected = await upload(await operatorToken(), {
      ...meta(),
      oidc: { issuer: "https://spoofed.test", subject: "spoof" },
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ type: "urn:scafo:invalid-input" });

    const legacy = await upload(await operatorToken(), {
      ...meta(),
      source: {
        provider: "forge",
        repo: "acme/shop",
        ref: "main",
        commit: "abc",
        oidcSub: "spoof",
      },
    });
    expect(legacy.status).toBe(400);
    await expect(legacy.json()).resolves.toMatchObject({ type: "urn:scafo:invalid-input" });

    const accepted = await upload(await operatorToken());
    const status = await settled((await responseId(accepted)) as string);
    expect((await getBuild(clock.ctx, PROJECT, status.build as string)).oidc).toBeUndefined();
  });
});

describe("a project an admin has blocked", () => {
  it("refuses the deploy before a byte is published, and names the block", async () => {
    await blockProject(clock.ctx, PROJECT);

    const response = await upload(await operatorToken());

    /*
     * NAMED PLAINLY, because the caller reaches this project: a scoped operator
     * whose own project has been stopped is owed the reason, or their only
     * signal is a deploy that fails for no stated cause. What is never named is
     * a block on a project the caller does NOT reach — that refusal is the
     * ordinary out-of-scope one and says nothing about the project at all.
     */
    expect(response.status).toBe(409);
    const problem = await problemOf(response);
    expect(problem.type).toBe("urn:scafo:project-blocked");
    expect(problem.detail).toContain(PROJECT);

    /* Refused at intake rather than inside the status a caller has to poll for,
       so nothing was bundled, uploaded or pointed at. */
    expect(runs).toEqual([]);
  });

  it("refuses a workload's deploy for it too", async () => {
    await blockProject(clock.ctx, PROJECT);

    const response = await upload(await workloadToken());

    expect(response.status).toBe(409);
    expect(runs).toEqual([]);
  });

  it("accepts one again once the block is lifted", async () => {
    await blockProject(clock.ctx, PROJECT);
    await unblockProject(clock.ctx, PROJECT);

    const response = await upload(await operatorToken());

    expect(response.status).toBe(202);
  });

  it("leaves an unblocked project alone", async () => {
    await blockProject(clock.ctx, RIVAL);

    const response = await upload(await operatorToken());

    expect(response.status).toBe(202);
  });
});

describe("what an upload must carry", () => {
  it("does not retain the legacy body-selected deploy route", async () => {
    const response = await app.request("/v1/deploys", {
      method: "POST",
      headers: { authorization: `Bearer ${await operatorToken()}` },
      body: artifact.open(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(response.status).toBe(404);
  });

  it("refuses a chunked body over the receive cap without a status, file, or runner call", async () => {
    const staging = await mkdtemp(join(tmpdir(), "scafo-receive-route-"));
    daemon.artifactStager = createFileArtifactStager({ stagingDir: staging });
    daemon.config.deploy = {
      ...daemon.config.deploy!,
      artifactBytes: artifactBytes.byteLength - 1,
    };

    const response = await upload(await operatorToken());

    expect(response.status).toBe(413);
    expect(response.headers.get("location")).toBeNull();
    expect(runs).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
  });

  it("accepts a chunked body at the exact receive cap", async () => {
    daemon.config.deploy = {
      ...daemon.config.deploy!,
      artifactBytes: artifactBytes.byteLength,
    };

    const response = await upload(await operatorToken());
    expect(response.status).toBe(202);
  });

  it.each(["", "%%%", "e30", "eyJiIjoyLCJhIjoxfQ"])(
    "refuses absent, malformed, or non-canonical metadata before reading the body: %s",
    async (header) => {
      let reads = 0;
      const response = await streamedUpload(
        await operatorToken(),
        PROJECT,
        header,
        unreadBody(() => reads++),
      );

      expect(response.status).toBe(400);
      expect(reads).toBe(0);
    },
  );

  it("refuses a project duplicated in metadata before reading the body", async () => {
    let reads = 0;
    const response = await streamedUpload(
      await operatorToken(),
      PROJECT,
      { project: PROJECT, runtimeConfigurable: false },
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(400);
    await expect(problemOf(response)).resolves.toMatchObject({
      detail: expect.stringContaining("request path"),
    });
    expect(reads).toBe(0);
  });

  it("refuses oversized metadata before reading the body", async () => {
    let reads = 0;
    const response = await streamedUpload(
      await operatorToken(),
      PROJECT,
      "A".repeat(DEPLOY_METADATA_MAX_BYTES + 1),
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(400);
    expect(reads).toBe(0);
  });

  it("refuses a raw body without metadata", async () => {
    const response = await app.request(`/v1/projects/${PROJECT}/deploys`, {
      method: "POST",
      headers: { "authorization": `Bearer ${await operatorToken()}`, "content-type": "text/plain" },
      body: "just some bytes",
    });

    await expect(problemOf(response)).resolves.toMatchObject({
      type: "urn:scafo:invalid-input",
      status: 400,
    });
  });

  it("refuses an upload without an artifact body", async () => {
    const response = await app.request(`/v1/projects/${PROJECT}/deploys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await operatorToken()}`,
        [DEPLOY_METADATA_HEADER]: encodeDeployMetadata({ runtimeConfigurable: false }),
      },
    });

    const problem = await problemOf(response);
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("artifact body");
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
  it("publishes the artifact, records the build and makes it current", async () => {
    running = [readyProcess(VERSION_ID)];
    const id = (await responseId(await upload(await operatorToken()))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "routed", build: VERSION_ID });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      project: PROJECT,
      environment: ENVIRONMENT,
      /* Defaulted from the project when the upload named no script. */
      script: PROJECT,
      target: { prefix: `${PREFIX}/fleets/${PROJECT}/${ENVIRONMENT}`, bucket: "registry" },
    });
    /* The bytes the client packed arrive intact through the raw body. */
    expect(receivedArtifacts[0]).toEqual(artifactBytes);

    const build = await getBuild(clock.ctx, PROJECT, VERSION_ID);
    expect(build).toMatchObject({ celldVersionId: VERSION_ID, runtimeConfigurable: false });

    const environment = await getEnvironment(clock.ctx, PROJECT, ENVIRONMENT);
    expect(environment.alias?.build).toBe(VERSION_ID);
  });

  it("serializes Celld publication and the current marker across concurrent deploys", async () => {
    const buildA = "aaaa1111";
    const buildB = "bbbb2222";
    const markerStarted = Promise.withResolvers<void>();
    const releaseMarker = Promise.withResolvers<void>();
    const inner = clock.ctx.store;
    clock.ctx.store = {
      get: (key) => inner.get(key),
      getBytes: (key) => inner.getBytes(key),
      put: async (key, body, cas) => {
        if (
          key === environmentKey(PROJECT, ENVIRONMENT) &&
          typeof body === "string" &&
          (JSON.parse(body) as { alias?: { build?: string } }).alias?.build === buildA
        ) {
          markerStarted.resolve();
          await releaseMarker.promise;
        }
        return inner.put(key, body, cas);
      },
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
    };

    const versions = [buildA, buildB];
    publish = () => Promise.resolve({ celldVersionId: versions.shift() as string });
    running = [readyProcess(buildA), readyProcess(buildB)];
    daemon.deploys = createDeployService(daemon, fakeRunner(), {
      scheduler: {
        artifactBytes: artifactBytes.byteLength,
        activeTasks: 2,
        projectActiveTasks: 2,
        queuedTasks: 2,
        projectQueuedTasks: 2,
        stagedBytes: artifactBytes.byteLength * 2,
        projectStagedBytes: artifactBytes.byteLength * 2,
        receiveTimeoutMs: 60_000,
        queueTimeoutMs: 60_000,
        taskTimeoutMs: 60_000,
      },
      routedTimeoutMs: 100,
      pollMs: 1,
    });

    const first = (await responseId(await upload(await operatorToken()))) as string;
    await markerStarted.promise;
    const second = (await responseId(await upload(await operatorToken()))) as string;
    await Promise.resolve();

    /* The second Celld publish cannot begin while the first one's registry
       marker is held: both effects are one serialized current-build change. */
    expect(runs).toHaveLength(1);

    releaseMarker.resolve();
    await expect(settled(first)).resolves.toMatchObject({ state: "routed", build: buildA });
    await expect(settled(second)).resolves.toMatchObject({ state: "routed", build: buildB });
    await expect(getEnvironment(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toMatchObject({
      alias: { build: buildB },
    });
  });

  it("reports possible publication when cancellation races with releasing the pointer lock", async () => {
    const releaseReadStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const inner = clock.ctx.store;
    const lockKey = pointerLockKey(PROJECT, ENVIRONMENT);
    let markerLanded = false;
    clock.ctx.store = {
      get: async (key) => {
        if (key === lockKey && markerLanded) {
          releaseReadStarted.resolve();
          await releaseRead.promise;
        }
        return inner.get(key);
      },
      getBytes: (key) => inner.getBytes(key),
      put: async (key, body, cas) => {
        const result = await inner.put(key, body, cas);
        if (
          key === environmentKey(PROJECT, ENVIRONMENT) &&
          typeof body === "string" &&
          (JSON.parse(body) as { alias?: { build?: string } }).alias?.build === VERSION_ID
        ) {
          markerLanded = true;
        }
        return result;
      },
      del: (key) => inner.del(key),
      list: (prefix) => inner.list(prefix),
    };

    const service = daemon.deploys!;
    const id = (await responseId(await upload(await operatorToken()))) as string;
    await releaseReadStarted.promise;
    const stopping = service.stop(new Error("node stopping"));
    releaseRead.resolve();
    await stopping;

    expect(service.get(id)).toMatchObject({
      state: "failed",
      build: VERSION_ID,
      detail: expect.stringContaining(`celld published version "${VERSION_ID}"`),
    });
    expect(service.get(id)?.detail).toContain("could not confirm or finish recording");
    await expect(getEnvironment(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toMatchObject({
      alias: { build: VERSION_ID },
    });
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

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "routed", build: VERSION_ID });
    const environment = await getEnvironment(clock.ctx, PROJECT, ENVIRONMENT);
    expect(environment.alias?.build).toBe(VERSION_ID);
  });

  it("stops at deployed with a warning when nothing becomes ready in time", async () => {
    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    const status = await settled(id);
    /* Never an error: the build exists and the alias points at it, so the loop
       goes on trying long after the deploy stopped watching. */
    expect(status.state).toBe("deployed");
    expect(status.warnings.map((warning) => warning.code)).toEqual(["deploy-not-routed"]);
  });

  it("carries current-build warnings through to the status", async () => {
    running = [readyProcess(VERSION_ID)];
    await createEnvironment(clock.ctx, PROJECT, { name: ENVIRONMENT, varset: "a1b2c3d4" });

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

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

  it("caps every retained background failure detail on a UTF-8 boundary", async () => {
    publish = () => Promise.reject(new Error(`failed-${"€".repeat(10_000)}`));

    const id = (await responseId(await upload(await operatorToken()))) as string;
    const detail = (await settled(id)).detail ?? "";

    expect(new TextEncoder().encode(detail).byteLength).toBeLessThanOrEqual(4096);
    expect(detail).not.toContain("�");
  });

  it("records a background archive limit as a precise failed status, not an HTTP 413", async () => {
    publish = () =>
      Promise.reject(
        new ScafoError("resource-limit", "Artifact expands too large", {
          detail: "the archive exceeded the 1024-byte expanded-artifact limit",
        }),
      );

    const response = await upload(await operatorToken());
    const id = (await responseId(response)) as string;

    expect(response.status).toBe(202);
    await expect(settled(id)).resolves.toMatchObject({
      state: "failed",
      detail:
        "Artifact expands too large: the archive exceeded the 1024-byte expanded-artifact limit",
    });
  });

  it("disposes the staged artifact after background publishing is cancelled", async () => {
    publish = () => Promise.reject(new DOMException("publish cancelled", "AbortError"));
    const dispose = vi.fn(() => Promise.resolve());
    const admission = await daemon.deploys?.admit({
      project: PROJECT,
      environment: ENVIRONMENT,
      script: PROJECT,
      runtimeConfigurable: false,
    });
    const status = admission?.start(
      {
        byteLength: artifactBytes.byteLength,
        open: () => new Blob([artifactBytes as BlobPart]).stream(),
        dispose,
      },
      daemon.deploys!.reserve(PROJECT),
    );

    await settled(status?.id as string);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("watching a build the coordinator placed somewhere else", () => {
  /*
   * A deploy is accepted by whichever node the caller reached, and WHICH nodes
   * serve the environment is decided afterwards, by the coordinator. So the node
   * holding the deploy open is routinely not the node that starts the build —
   * and asking only its own processes made the answer depend on which door the
   * deploy went through, which is exactly what a client cannot know.
   */

  it("reaches routed through a node that runs nothing for the build itself", async () => {
    const peer = await standUpPeer();
    peer.processes.push(readyProcess(VERSION_ID));
    await placeOn(NODE_B);

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    /* This node's own reconcile loop reports nothing at all, and the deploy is
       routed all the same, because the node the placement named does. */
    expect(running).toEqual([]);
    await expect(settled(id)).resolves.toMatchObject({ state: "routed", build: VERSION_ID });
  });

  it("names the node it was watching when the build never came up there", async () => {
    await standUpPeer();
    await placeOn(NODE_B);

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    const status = await settled(id);
    expect(status.state).toBe("deployed");
    /* The one case where "nothing was ready" is not about the node answering. */
    expect(status.warnings[0].detail).toContain(NODE_B);
  });

  it("asks nobody while the placement names this node", async () => {
    const peer = await standUpPeer();
    running = [readyProcess(VERSION_ID)];
    await placeOn(OPERATOR);

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "routed" });
    /* The local processes are the whole answer, so the hop is never made. */
    expect(peer.asked).toEqual([]);
  });

  it("keeps looking rather than failing the deploy when the peer cannot be reached", async () => {
    await standUpPeer();
    await placeOn(NODE_B);
    daemon.fetchFn = () => Promise.reject(new Error("connect ECONNREFUSED"));

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    const status = await settled(id);
    /* The build exists and the alias points at it; an unreachable peer says
       nothing about either, and a deploy is never failed over one. */
    expect(status.state).toBe("deployed");
    expect(status.warnings.map((warning) => warning.code)).toEqual(["deploy-not-routed"]);
  });

  it("asks nobody about a node the placement names that is no longer live", async () => {
    const peer = await standUpPeer({ heartbeatAgoMs: 10 * 60_000 });
    peer.processes.push(readyProcess(VERSION_ID));
    await placeOn(NODE_B);

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    /* A decision outlives the node it names; a node that stopped beating is
       counted out here exactly as it is everywhere else. */
    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    expect(peer.asked).toEqual([]);
  });
});

describe("the wake a deploy is", () => {
  it("stamps the environment awake once the new build is serving traffic", async () => {
    running = [readyProcess(VERSION_ID)];
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toBeNull();

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

    /* A deploy IS a wake: what has just been brought into service must not park
       for having had no request of its own yet. */
    await expect(settled(id)).resolves.toMatchObject({ state: "routed" });
    await expect(readEnvironmentWake(clock.ctx, PROJECT, ENVIRONMENT)).resolves.toEqual(
      new Date(clock.nowMs()),
    );
  });

  it("stamps it awake when it becomes current", async () => {
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
    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

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
    daemon.registry = { ...clock.ctx, store: refusingWakeStamps(clock.ctx.store) };

    const id = (await responseId(await upload(await operatorToken(), meta()))) as string;

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

describe("removed deployment-selection routes", () => {
  it.each([
    ["alias", aliasPath()],
    ["split", `/v1/environments/${PROJECT}/${ENVIRONMENT}/split`],
  ])("answers %s changes with an ordinary 404", async (_name, path) => {
    const response = await post(path, await operatorToken(), { build: VERSION_ID });
    expect(response.status).toBe(404);
  });
});

/* ---- fixtures ---- */

function daemonConfig(): DaemonConfig {
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
    observability: { enabled: false },
    api: { public: true, jsonBytes: 65_536 },
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
function fakeReconciler(processes: () => RuntimeProcess[] = () => running): Reconciler {
  return {
    runOnce: () => Promise.resolve([]),
    kick: () => {},
    parkedRecords: () => [],
    start: () => {},
    shutdown: () => Promise.resolve(),
    stop: () => {},
    status: () => ({
      lastRunAt: null,
      running: false,
      lastActions: [],
      failures: [],
      processes: processes(),
      placements: [],
      parked: [],
    }),
  };
}

/* ---- a second node of the same installation ---- */

/** A second node, its own daemon, and what this one asked it. */
interface Peer {
  /** Processes it reports as running; push a ready one to make it serve. */
  processes: RuntimeProcess[];
  /** Paths this node's daemon has called on it, in order. */
  asked: string[];
}

/**
 * Registers a second node, stands its daemon up in this process, and points this
 * node's peer hop at it.
 *
 * Live by default, because that is what the placement's answer is only useful
 * for; `heartbeatAgoMs` is how one is made stale.
 */
async function standUpPeer(opts: { heartbeatAgoMs?: number } = {}): Promise<Peer> {
  const keys = await generateJWK("EdDSA", { kid: NODE_B });
  await registerNode(clock.ctx, {
    v: 1,
    id: NODE_B,
    publicKey: { kty: "OKP", crv: "Ed25519", x: keys.publicKey.x },
    addresses: { internal: PEER_HOST, apiPort: PEER_PORT },
    heartbeatAt: new Date(clock.nowMs() - (opts.heartbeatAgoMs ?? 0)).toISOString(),
  });

  const processes: RuntimeProcess[] = [];
  const asked: string[] = [];
  const peer = createNodeApp({
    config: daemonConfig(),
    nodeId: NODE_B,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    version: "0.0.0-test",
    reconciler: fakeReconciler(() => processes),
  });

  /* Node tokens are verified against the registry, so the hop is authenticated
     for real here rather than waved through. */
  daemon.signingKey = operatorKeys.privateKey;
  daemon.fetchFn = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    const url = new URL(href);
    if (url.host !== `${PEER_HOST}:${String(PEER_PORT)}`) {
      return Promise.reject(new Error(`nothing answers at ${href}`));
    }
    asked.push(url.pathname);
    return Promise.resolve(peer.request(url.pathname, init));
  }) as typeof fetch;

  return { processes, asked };
}

/** Records the coordinator's decision for this environment, as it would stand. */
async function placeOn(...nodes: string[]): Promise<void> {
  await clock.ctx.store.put(
    placementKey(PROJECT, ENVIRONMENT),
    JSON.stringify({
      v: 1,
      nodes,
      decidedAt: new Date(clock.nowMs()).toISOString(),
      fence: 1,
    }),
  );
}

function fakeRunner(): DeployRunner {
  return {
    async run(input) {
      runs.push(input);
      receivedArtifacts.push(
        new Uint8Array(await new Response(input.artifact.open()).arrayBuffer()),
      );
      return publish();
    },
  };
}

/** A store that refuses the wake stamp alone, and answers every other write. */
function refusingWakeStamps(inner: CasStore): CasStore {
  const stamp = envWakeKey(PROJECT, ENVIRONMENT);
  return {
    get: (key) => inner.get(key),
    getBytes: (key) => inner.getBytes(key),
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
  return { project: PROJECT, environment: ENVIRONMENT, runtimeConfigurable: false };
}

/* ---- driving the app ---- */

/** Uploads the artifact with `sent` as the whole of its meta part. */
async function upload(
  token: string | undefined,
  sent: Record<string, unknown> = meta(),
): Promise<Response> {
  const { project: target = PROJECT, ...metadata } = sent;
  return await app.request(`/v1/projects/${String(target)}/deploys`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/octet-stream",
      [DEPLOY_METADATA_HEADER]: encodeDeployMetadata(metadata as { runtimeConfigurable: boolean }),
    },
    body: artifact.open(),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function streamedUpload(
  token: string | undefined,
  project: string,
  metadata: Record<string, unknown> | string,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const encoded =
    typeof metadata === "string"
      ? metadata
      : encodeDeployMetadata(metadata as { runtimeConfigurable: boolean });
  return await app.request(`/v1/projects/${project}/deploys`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      [DEPLOY_METADATA_HEADER]: encoded,
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function unreadBody(read: () => void): ReadableStream<Uint8Array> {
  let primed = false;
  return new ReadableStream<Uint8Array>({
    pull(stream): void {
      if (!primed) {
        primed = true;
        stream.enqueue(new Uint8Array([1]));
        return;
      }
      read();
      throw new Error("sentinel artifact body was read");
    },
  });
}

async function post(
  path: string,
  token: string | undefined,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function aliasPath(project: string = PROJECT): string {
  return `/v1/projects/${project}/environments/${ENVIRONMENT}/alias`;
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
      const status = daemon.deploys?.get(id) ?? null;
      expect(status?.state).not.toBe("accepted");
      expect(status?.state).not.toBe("uploading");
      return status as DeployStatus;
    },
    { timeout: 5000, interval: 5 },
  );
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
  issuerCalls.push(url);
  const body =
    url === DISCOVERY_URL
      ? { issuer: ISS, jwks_uri: JWKS_URL }
      : url === JWKS_URL
        ? ({ keys: [issuerKeys.publicKey] } satisfies JWKSet)
        : null;

  if (body === null) return Promise.resolve(new Response("no such document", { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify(body)));
}
