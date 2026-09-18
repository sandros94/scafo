/*
 * Deploy intake: who may upload an artifact, what an upload must say, and the states a deploy
 * moves through once it has been accepted.
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
import {
  createDeployService,
  deployId,
  parseDeployId,
  type DeployStatus,
} from "../src/daemon/deploys.ts";
import {
  DEPLOY_METADATA_HEADER,
  DEPLOY_METADATA_MAX_BYTES,
  encodeDeployMetadata,
  type DeployMetadata,
} from "../src/daemon/_intake.ts";
import type { Reconciler } from "../src/daemon/reconcile.ts";
import { OIDC_AUDIENCE, signNodeToken } from "../src/core/auth/index.ts";
import { applicationKey, deploysPrefix } from "../src/core/registry/paths.ts";
import { ScafoError, type ProblemDetails } from "../src/core/error.ts";
import { NODE_LIVENESS_WINDOW_MS } from "../src/core/registry/nodes.ts";
import {
  blockApplication,
  createApplication,
  findApplication,
  freezeDeploys,
  getApplication,
  getDeployment,
  getDeployRecord,
  registerNode,
  setApplicationLabels,
  setTrustPolicy,
  trustOperator,
  unblockApplication,
  unfreezeDeploys,
} from "../src/core/registry/index.ts";
import type {
  DeployRunInput,
  DeployRunResult,
  DeployRunner,
  StagedArtifact,
} from "../src/core/types/deploy.ts";
import type { DeploymentSource, DeployRecord, NodeRecord } from "../src/core/types/registry.ts";
import type { RuntimeProcess } from "../src/core/types/runtime.ts";
import type { CasStore } from "../src/core/types/store.ts";
import type { Supervisor } from "../src/core/types/supervisor.ts";
import { packDirectory } from "../src/drivers/archive/tar-zst.ts";
import { createFileArtifactStager } from "../src/drivers/artifact/file.ts";
import { MemoryCasStore } from "../src/drivers/store/memory.ts";
import { ctxWith, FaultStore, type ManualClock, rejectsWith } from "./_helpers.ts";

const OPERATOR = "op-1234abcd";
/** A trusted key scoped to another application than the one being deployed. */
const SCOPED = "op-scoped11";
const APPLICATION = "shop";
const RIVAL = "rival";
const VERSION_ID = "abc123def456";
/** Another node of this installation, and where it says it is reached. */
const PEER = "node-b";
const PEER_ADDRESS = { internal: "10.0.0.2", apiPort: 7400 };
/** The Celld this node booted with; what every other node's is compared against. */
const CELLD_VERSION = "0.5.0";
/** What a pipeline says about the commit it is deploying. */
const SOURCE: DeploymentSource = {
  provider: "github",
  repo: "acme/shop",
  ref: "refs/heads/main",
  commit: "c0ffeec0ffeec0ffee",
};
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
let scopedKeys: Awaited<ReturnType<typeof generateJWK<"EdDSA">>>;
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
  scopedKeys = await generateJWK("EdDSA", { kid: SCOPED });

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
  await trustOperator(clock.ctx, {
    id: SCOPED,
    publicKey: { kty: "OKP", crv: "Ed25519", x: scopedKeys.publicKey.x },
    role: "operator",
    applications: [RIVAL],
  });

  for (const name of [APPLICATION, RIVAL]) await createApplication(clock.ctx, { name });
  /* Only one application trusts the issuer; the other is what a cross-application
     attempt is aimed at. */
  await setTrustPolicy(clock.ctx, APPLICATION, {
    v: 1,
    issuers: [{ iss: ISS, aud: OIDC_AUDIENCE, subjects: ["repo:acme/*"] }],
  });

  daemon = {
    config: daemonConfig(),
    nodeId: OPERATOR,
    registry: clock.ctx,
    supervisor: fakeSupervisor(),
    versions: { scafo: "0.0.0-test", celld: CELLD_VERSION },
    reconciler: fakeReconciler(),
  };
  daemon.deploys = createDeployService(daemon, fakeRunner());
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
      APPLICATION,
      {},
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
      APPLICATION,
      {},
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(401);
    expect(reads).toBe(0);
  });

  it("never reads a trust-mismatched workload's artifact body", async () => {
    let reads = 0;
    const response = await streamedUpload(
      await workloadToken({ sub: "repo:evil/app" }),
      APPLICATION,
      {},
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
    expect(status).toMatchObject({ application: APPLICATION, state: "accepted" });
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
        applicationActiveTasks: 1,
        queuedTasks: 0,
        applicationQueuedTasks: 0,
        stagedBytes: 100,
        applicationStagedBytes: 100,
        receiveTimeoutMs: 600_000,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 300_000,
      },
    });
    let reads = 0;

    const response = await streamedUpload(
      await operatorToken(),
      APPLICATION,
      {},
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
        applicationActiveTasks: 1,
        queuedTasks: 1,
        applicationQueuedTasks: 1,
        stagedBytes: 100,
        applicationStagedBytes: 100,
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

    const response = await streamedUpload(await operatorToken(), APPLICATION, {}, body);

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
        applicationActiveTasks: 1,
        queuedTasks: 1,
        applicationQueuedTasks: 1,
        stagedBytes: cap,
        applicationStagedBytes: cap,
        receiveTimeoutMs: 600_000,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 300_000,
      },
    });
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

  it("keeps pre-handoff accounting charged when staged-artifact disposal fails", async () => {
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
        applicationActiveTasks: 1,
        queuedTasks: 1,
        applicationQueuedTasks: 1,
        stagedBytes: 100,
        applicationStagedBytes: 100,
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

  it("accepts a workload token the application's trust policy admits", async () => {
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

  it("refuses a workload token trusted for one application the run of another", async () => {
    /* The token is genuine and its own application would admit it. Deploying into
       an application that does not name its issuer is authorization, and is said
       so. */
    const response = await upload(await workloadToken(), {}, RIVAL);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
    expect(runs).toEqual([]);
  });

  it("refuses a subject its own application's policy does not name", async () => {
    const response = await upload(await workloadToken({ sub: "repo:evil/app" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:trust-mismatch" });
    expect(runs).toEqual([]);
  });

  it("keeps pre-verification failures byte-identical and never fetches an untrusted issuer", async () => {
    const valid = await workloadToken();
    const [, payload, signature] = valid.split(".");
    const noPolicy = await upload(valid, {}, RIVAL);
    const wrongIssuer = await upload(await workloadToken({ iss: "https://untrusted.test" }));
    const badSignature = await upload(`${valid.split(".")[0]}.${payload}.${signature}x`);

    const bodies = await Promise.all([noPolicy.text(), wrongIssuer.text(), badSignature.text()]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[1]).toBe(bodies[2]);
    expect(issuerCalls).toEqual([DISCOVERY_URL, JWKS_URL]);
  });

  it("persists only the verified workload actor beside self-asserted source metadata", async () => {
    const response = await upload(await workloadToken(), {
      source: {
        provider: "forge",
        repo: "acme/shop",
        ref: "refs/heads/main",
        commit: "abc123",
      },
    });

    const status = await settled((await responseId(response)) as string);
    const deployment = await getDeployment(clock.ctx, APPLICATION, status.deployment as string);
    expect(deployment.source).toEqual({
      provider: "forge",
      repo: "acme/shop",
      ref: "refs/heads/main",
      commit: "abc123",
    });
    expect(deployment.oidc).toEqual({ issuer: ISS, subject: SUBJECT });
  });

  it("rejects caller-supplied OIDC provenance and leaves node deploys without it", async () => {
    const rejected = await upload(await operatorToken(), {
      oidc: { issuer: "https://spoofed.test", subject: "spoof" },
    });
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({ type: "urn:scafo:invalid-input" });

    const legacy = await upload(await operatorToken(), {
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
    expect(
      (await getDeployment(clock.ctx, APPLICATION, status.deployment as string)).oidc,
    ).toBeUndefined();
  });
});

describe("an application an admin has blocked", () => {
  it("refuses the deploy before a byte is published, and names the block", async () => {
    await blockApplication(clock.ctx, APPLICATION);

    const response = await upload(await operatorToken());

    /*
     * named plainly, because the caller reaches this application: a scoped
     * operator whose own application has been stopped is owed the reason, or
     * their only signal is a deploy that fails for no stated cause. What is
     * never named is a block on an application the caller does not reach — that
     * refusal is the ordinary out-of-scope one and says nothing about the
     * application at all.
     */
    expect(response.status).toBe(409);
    const problem = await problemOf(response);
    expect(problem.type).toBe("urn:scafo:application-blocked");
    expect(problem.detail).toContain(APPLICATION);

    /* Refused at intake rather than inside the status a caller has to poll for,
       so nothing was bundled, uploaded or pointed at. */
    expect(runs).toEqual([]);
  });

  it("leaves the block itself standing, a deploy owning no part of the record", async () => {
    await blockApplication(clock.ctx, APPLICATION);

    await upload(await operatorToken(), { replicas: 3 });

    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({ blocked: true });
    /* And not even the placement the refused upload asked for was written. */
    expect((await getApplication(clock.ctx, APPLICATION)).replicas).toBeUndefined();
  });

  it("refuses a workload's deploy for it too", async () => {
    await blockApplication(clock.ctx, APPLICATION);

    const response = await upload(await workloadToken());

    expect(response.status).toBe(409);
    expect(runs).toEqual([]);
  });

  it("accepts one again once the block is lifted", async () => {
    await blockApplication(clock.ctx, APPLICATION);
    await unblockApplication(clock.ctx, APPLICATION);

    const response = await upload(await operatorToken());

    expect(response.status).toBe(202);
  });

  it("leaves an unblocked application alone", async () => {
    await blockApplication(clock.ctx, RIVAL);

    const response = await upload(await operatorToken());

    expect(response.status).toBe(202);
  });
});

describe("a fleet whose deploys an admin has frozen", () => {
  /* An application this registry has never held, so "nothing was created" is a
     thing the bucket can be asked about rather than a thing the fixture already
     did. */
  const FRESH = "not-yet-an-app";
  const ADMIN = "op-admin1111";
  const REASON = "celld 0.5.0 upgrade";

  it("refuses the deploy before ANYTHING is created, and says what it is waiting on", async () => {
    const { freeze } = await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });

    const response = await upload(await operatorToken(), {}, FRESH);

    expect(response.status).toBe(409);
    const problem = await problemOf(response);
    expect(problem.type).toBe("urn:scafo:deploys-frozen");
    /*
     * The whole of what the caller has to act on. Nothing is wrong with this
     * deploy or with its key — an admin stopped intake for the installation —
     * so its only other signal would be a deploy that fails for no stated cause.
     */
    expect(problem.detail).toContain(ADMIN);
    expect(problem.detail).toContain(freeze.frozenAt);
    expect(problem.detail).toContain(REASON);
    expect(problem.detail).toContain("scafo fleet unfreeze");

    /* Refused ahead of every write: a first deploy creates the application on
       the way in, and it would have outlived the refusal. */
    await expect(clock.ctx.store.get(applicationKey(FRESH))).resolves.toBeNull();
    await expect(clock.ctx.store.list(deploysPrefix(FRESH))).resolves.toEqual([]);
    expect(runs).toEqual([]);
  });

  it("refuses an application that is already there too, and records no deploy of it", async () => {
    await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });

    const response = await upload(await operatorToken());

    expect(response.status).toBe(409);
    expect((await problemOf(response)).type).toBe("urn:scafo:deploys-frozen");
    await expect(clock.ctx.store.list(deploysPrefix(APPLICATION))).resolves.toEqual([]);
    expect(runs).toEqual([]);
  });

  it("accepts the same upload, unchanged, once the freeze is lifted", async () => {
    await freezeDeploys(clock.ctx, { by: ADMIN, reason: REASON });
    expect((await upload(await operatorToken())).status).toBe(409);

    await unfreezeDeploys(clock.ctx);

    expect((await upload(await operatorToken())).status).toBe(202);
  });
});

describe("an application another node serves on a different Celld", () => {
  it("refuses the deploy before a byte is received, and names who holds it", async () => {
    await servedElsewhere("0.4.1");

    const response = await upload(await operatorToken());

    /* A fleet cannot be served by two Celld versions, and the caller is the one
       who can stop the other node: name it and the binary it runs. */
    expect(response.status).toBe(409);
    const problem = await problemOf(response);
    expect(problem.type).toBe("urn:scafo:version-skew");
    expect(problem.detail).toContain("node-b");
    expect(problem.detail).toContain("0.4.1");
    expect(problem.detail).toContain(APPLICATION);

    expect(runs).toEqual([]);
  });

  it("names a node that reports no versions at all", async () => {
    await servedElsewhere(undefined);

    const problem = await problemOf(await upload(await operatorToken()));

    expect(problem.type).toBe("urn:scafo:version-skew");
    expect(problem.detail).toContain("unreported");
  });

  it("accepts the deploy when that node runs the same Celld", async () => {
    await servedElsewhere(CELLD_VERSION);

    expect((await upload(await operatorToken())).status).toBe(202);
  });

  it("accepts the deploy when that node is no longer answering", async () => {
    await servedElsewhere("0.4.1");
    clock.tick(NODE_LIVENESS_WINDOW_MS + 1);

    expect((await upload(await operatorToken())).status).toBe(202);
  });

  it("leaves a deploy of another application alone", async () => {
    await servedElsewhere("0.4.1", RIVAL);

    expect((await upload(await operatorToken())).status).toBe(202);
  });
});

describe("what an upload must carry", () => {
  it("takes the artifact at the application's own deploy path", async () => {
    const response = await app.request(`/v1/applications/${APPLICATION}/deploys`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await operatorToken()}`,
        "content-type": "application/octet-stream",
        [DEPLOY_METADATA_HEADER]: encodeDeployMetadata({}),
      },
      body: artifact.open(),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ application: APPLICATION });
  });

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

  it.each(["", "%%%", "eyJiIjoyLCJhIjoxfQ"])(
    "refuses absent, malformed, or non-canonical metadata before reading the body: %s",
    async (header) => {
      let reads = 0;
      const response = await streamedUpload(
        await operatorToken(),
        APPLICATION,
        header,
        unreadBody(() => reads++),
      );

      expect(response.status).toBe(400);
      expect(reads).toBe(0);
    },
  );

  it("refuses an application named in the metadata before reading the body", async () => {
    /* The path says which application is being deployed into, and it is what the
       caller was authenticated against. A second answer in the header could
       disagree with it, so there is no second answer. */
    let reads = 0;
    const response = await streamedUpload(
      await operatorToken(),
      APPLICATION,
      { application: APPLICATION },
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
      APPLICATION,
      "A".repeat(DEPLOY_METADATA_MAX_BYTES + 1),
      unreadBody(() => reads++),
    );

    expect(response.status).toBe(400);
    expect(reads).toBe(0);
  });

  it("refuses a raw body without metadata", async () => {
    const response = await app.request(`/v1/applications/${APPLICATION}/deploys`, {
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
    const response = await app.request(`/v1/applications/${APPLICATION}/deploys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await operatorToken()}`,
        [DEPLOY_METADATA_HEADER]: encodeDeployMetadata({}),
      },
    });

    const problem = await problemOf(response);
    expect(problem.status).toBe(400);
    expect(problem.detail).toContain("artifact body");
  });

  it("refuses a path naming something the registry could not address", async () => {
    const response = await upload(await operatorToken(), {}, "UPPER");

    expect(response.status).toBe(400);
    expect(runs).toEqual([]);
  });

  it("refuses placement the registry could not hold", async () => {
    const bad = [
      { replicas: 0 },
      { replicas: "every" },
      { nodeSelector: "tier=fast" },
      { nodeSelector: {} },
      { nodeSelector: { Tier: "fast" } },
    ];

    for (const patch of bad) {
      const response = await upload(await operatorToken(), patch);

      expect(response.status, `for ${JSON.stringify(patch)}`).toBe(400);
    }
    expect(runs).toEqual([]);
  });
});

describe("what happens to an accepted deploy", () => {
  it("ignores metadata fields it has no setting for, as it always has", async () => {
    /* Artifact-shaping settings live in the artifact's own config now. A client
       built against an older node still deploys: intake reads the fields it
       knows and says nothing about the rest. */
    const id = (await responseId(
      await upload(await operatorToken(), {
        script: "worker",
        noBundle: true,
      } as never),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty("script");
    expect(runs[0]).not.toHaveProperty("noBundle");
  });

  it("publishes the artifact, records the deployment and makes it current", async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;

    await expect(settled(id)).resolves.toMatchObject({
      state: "deployed",
      deployment: VERSION_ID,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      application: APPLICATION,
      target: { prefix: `${PREFIX}/fleets/${APPLICATION}`, bucket: "registry" },
    });
    /* The bytes the client packed arrive intact through the raw body. */
    expect(receivedArtifacts[0]).toEqual(artifactBytes);

    const deployment = await getDeployment(clock.ctx, APPLICATION, VERSION_ID);
    expect(deployment).toMatchObject({ version: VERSION_ID });

    const application = await getApplication(clock.ctx, APPLICATION);
    expect(application.deployment?.revision).toBe(1);
  });

  it("deploys into an application somebody else created", async () => {
    /*
     * A deploy only needs the application to exist — it expresses no opinion
     * about how it was set up — so it must not be refused for disagreeing with
     * settings it never named.
     */
    await createApplication(clock.ctx, { name: "preview" });

    const id = (await responseId(await upload(await operatorToken(), {}, "preview"))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    /* And it is still the application it was: the deploy created nothing. */
    await expect(getApplication(clock.ctx, "preview")).resolves.toMatchObject({ name: "preview" });
  });

  it("creates the application with the replica count the upload asked for", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), { replicas: 1 }, "fresh"),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, "fresh")).resolves.toMatchObject({ replicas: 1 });
  });

  it("restates the replica count of an application that already exists", async () => {
    await createApplication(clock.ctx, { name: "scaled", replicas: 3 });

    const id = (await responseId(
      await upload(await operatorToken(), { replicas: "all" }, "scaled"),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, "scaled")).resolves.toMatchObject({ replicas: "all" });
  });

  it("leaves the replica count alone when the upload names none", async () => {
    /* How many nodes serve an application is an operational decision. A deploy
       that silently rewrote it would move an application off nodes because
       somebody re-ran a pipeline that never mentioned placement. */
    await createApplication(clock.ctx, { name: "scaled", replicas: 2 });

    const id = (await responseId(await upload(await operatorToken(), {}, "scaled"))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, "scaled")).resolves.toMatchObject({ replicas: 2 });
  });

  it("creates the application with the node selector the upload asked for", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), { nodeSelector: { tier: "fast" } }, "targeted"),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, "targeted")).resolves.toMatchObject({
      nodeSelector: { tier: "fast" },
    });
  });

  it("restates the node selector of an application that already exists", async () => {
    await createApplication(clock.ctx, { name: "targeted", nodeSelector: { tier: "slow" } });

    const id = (await responseId(
      await upload(await operatorToken(), { nodeSelector: { tier: "fast" } }, "targeted"),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, "targeted")).resolves.toMatchObject({
      nodeSelector: { tier: "fast" },
    });
  });

  it("leaves the node selector alone when the upload names none", async () => {
    /* Where an application runs is an operational decision. A deploy that
       silently lifted a constraint would spread it across a fleet because
       somebody re-ran a pipeline that never mentioned placement — and lifting
       one is `scafo app selector --clear`, which says so out loud. */
    await createApplication(clock.ctx, { name: "targeted", nodeSelector: { tier: "fast" } });

    const id = (await responseId(await upload(await operatorToken(), {}, "targeted"))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, "targeted")).resolves.toMatchObject({
      nodeSelector: { tier: "fast" },
    });
  });

  it("files the deployment under the runtime's version, whatever the upload asks", async () => {
    /* A version is the digest of what was published, so it is the runtime's to
       assign: an upload that names one must not be able to file a deployment
       under an id of its own choosing. */
    const id = (await responseId(
      await upload(await operatorToken(), { deployment: "0f0f0f0f" }),
    )) as string;

    await expect(settled(id)).resolves.toMatchObject({ deployment: VERSION_ID });
    await rejectsWith(() => getDeployment(clock.ctx, APPLICATION, "0f0f0f0f"), "not-found");
  });

  it("reports a publish that threw as failed, and says why", async () => {
    publish = () => Promise.reject(new Error("celld exited with code 1"));

    const id = (await responseId(await upload(await operatorToken()))) as string;

    const status = await settled(id);
    expect(status.state).toBe("failed");
    expect(status.detail).toContain("celld exited with code 1");
    expect(status.deployment).toBeUndefined();
    /* Whatever the runner threw carried no code of ours, so it is the node's
       own unexpected failure and is recorded as one: a poll that had to guess
       would guess at the caller. */
    expect(status.code).toBe("internal");
    await expect(getDeployRecord(clock.ctx, APPLICATION, id)).resolves.toMatchObject({
      code: "internal",
    });
  });

  it("keeps the code of what failed after celld had published", async () => {
    /* A version id no registry key can be built from: the publish happened, and
       the refusal that follows it is the one a pipeline has to act on. */
    publish = () => Promise.resolve({ celldVersionId: "not a version" });

    const id = (await responseId(await upload(await operatorToken()))) as string;

    const status = await settled(id);
    expect(status.state).toBe("failed");
    expect(status.code).toBe("invalid-slug");
    expect(status.detail).toContain('celld published version "not a version"');
    await expect(getDeployRecord(clock.ctx, APPLICATION, id)).resolves.toMatchObject({
      code: "invalid-slug",
    });
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
      code: "resource-limit",
      detail:
        "Artifact expands too large: the archive exceeded the 1024-byte expanded-artifact limit",
    });
  });

  it("keeps a deploy the cancellation only caught after its commit point", async () => {
    /*
     * Writing the deployment revision is the commit point: past it the
     * application IS serving the deployment, and no abort undoes that. The task
     * deadline elapses here while the revision's own write is in flight, so the
     * write lands and the signal is aborted by the time it returns — which used
     * to be reported to the operator as a deploy that failed.
     */
    const recordKey = applicationKey(APPLICATION);
    const faulted = new FaultStore(clock.ctx.store);
    let committing = false;
    faulted.onBeforePut = async (key): Promise<void> => {
      if (key === recordKey && committing) await new Promise((wake) => setTimeout(wake, 300));
    };
    publish = (): Promise<DeployRunResult> => {
      committing = true;
      return Promise.resolve({ celldVersionId: VERSION_ID });
    };

    daemon.registry = { ...clock.ctx, store: faulted };
    daemon.deploys = createDeployService(daemon, fakeRunner(), {
      scheduler: {
        artifactBytes: 10_000_000,
        activeTasks: 1,
        applicationActiveTasks: 1,
        queuedTasks: 4,
        applicationQueuedTasks: 2,
        stagedBytes: 10_000_000,
        applicationStagedBytes: 10_000_000,
        receiveTimeoutMs: 600_000,
        queueTimeoutMs: 600_000,
        taskTimeoutMs: 50,
      },
    });

    const id = (await responseId(await upload(await operatorToken()))) as string;

    await expect(settled(id)).resolves.toMatchObject({
      state: "deployed",
      deployment: VERSION_ID,
    });
    /* And the abort the scheduler reports afterwards does not rewrite it. */
    await new Promise((wake) => setTimeout(wake, 50));
    expect(daemon.deploys?.get(id)).toMatchObject({ state: "deployed" });
    const application = await getApplication(clock.ctx, APPLICATION);
    expect(application.deployment?.revision).toBe(1);
  });

  it("disposes the staged artifact after background publishing is cancelled", async () => {
    publish = () => Promise.reject(new DOMException("publish cancelled", "AbortError"));
    const dispose = vi.fn(() => Promise.resolve());
    const admission = await daemon.deploys?.admit({ application: APPLICATION });
    const status = await admission?.start(
      {
        byteLength: artifactBytes.byteLength,
        open: () => new Blob([artifactBytes as BlobPart]).stream(),
        dispose,
      },
      daemon.deploys!.reserve(APPLICATION),
    );

    await settled(status?.id as string);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("the application a deploy addresses", () => {
  const FIRST = "brand-new";

  it("is created by the first deploy, there being no create route at all", async () => {
    await expect(findApplication(clock.ctx, FIRST)).resolves.toBeNull();
    const created = await app.request("/v1/applications", {
      method: "POST",
      headers: {
        "authorization": `Bearer ${await operatorToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: FIRST }),
    });
    expect(created.status).toBe(404);

    const id = (await responseId(await upload(await operatorToken(), {}, FIRST))) as string;

    await expect(settled(id)).resolves.toMatchObject({ state: "deployed" });
    await expect(getApplication(clock.ctx, FIRST)).resolves.toMatchObject({
      v: 1,
      name: FIRST,
      deployment: { revision: 1 },
    });
  });

  it("keeps the deploy inside the application its path named", async () => {
    const id = (await responseId(await upload(await operatorToken(), {}, FIRST))) as string;
    await settled(id);

    expect(id.startsWith(`${FIRST}.`)).toBe(true);
    await expect(getDeployRecord(clock.ctx, FIRST, id)).resolves.toMatchObject({
      application: FIRST,
    });
    /* And nothing of it landed in the application the fixture deploys to. */
    await expect(clock.ctx.store.list(deploysPrefix(APPLICATION))).resolves.toEqual([]);
  });

  it("never drops the labels an admin put on it", async () => {
    /* Labels are the fleet's own, and a deploy owns the deployment revision and
       the placement it named. A write that replaced the record wholesale would
       take an admin's labels off because a pipeline ran. */
    await setApplicationLabels(clock.ctx, APPLICATION, { tier: "gold", team: "payments" });

    const id = (await responseId(
      await upload(await operatorToken(), { replicas: 2, nodeSelector: { tier: "fast" } }),
    )) as string;
    await settled(id);

    await expect(getApplication(clock.ctx, APPLICATION)).resolves.toMatchObject({
      labels: { tier: "gold", team: "payments" },
      replicas: 2,
      nodeSelector: { tier: "fast" },
      deployment: { revision: 1 },
    });
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

describe("what a deploy id names", () => {
  it("carries the application it belongs to, so any node can authenticate a poll", async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;

    expect(id).toMatch(new RegExp(`^${APPLICATION}\\.[a-f\\d]{16}$`));
    expect(parseDeployId(id)).toEqual({
      application: APPLICATION,
      token: id.slice(APPLICATION.length + 1),
    });
  });

  it("parses back to the application that minted it, whatever the slug looks like", () => {
    for (const application of ["a", APPLICATION, "acme-shop-2", "s".repeat(63)]) {
      const id = deployId(application);
      expect(parseDeployId(id)).toEqual({ application, token: id.slice(application.length + 1) });
    }
  });

  it("mints an unguessable token for every deploy", () => {
    const minted = new Set(Array.from({ length: 64 }, () => deployId(APPLICATION)));

    expect(minted.size).toBe(64);
    for (const id of minted) expect(id.split(".")[1]).toMatch(/^[a-f\d]{16}$/);
  });

  it.each([
    ["empty", ""],
    ["an application with no token", APPLICATION],
    ["a token with no application", "a1b2c3d4e5f60718"],
    ["a short token", `${APPLICATION}.a1b2c3d4e5f607`],
    ["a long token", `${APPLICATION}.a1b2c3d4e5f607189`],
    ["an uppercase token", `${APPLICATION}.A1B2C3D4E5F60718`],
    ["an application outside the slug charset", "not_a_slug.a1b2c3d4e5f60718"],
    ["an application the registry could not hold", `${"s".repeat(64)}.a1b2c3d4e5f60718`],
    ["a path in place of an application", "../trust.a1b2c3d4e5f60718"],
  ])("refuses %s", (_what, id) => {
    expect(parseDeployId(id)).toBeNull();
  });
});

describe("the record a deploy leaves in the registry", () => {
  /** Every state written to a deploy record, in the order the writes landed. */
  let states: string[];

  beforeEach(() => {
    states = [];
    daemon.registry = { ...clock.ctx, store: watchingDeployRecords(clock.ctx.store, states) };
    daemon.deploys = createDeployService(daemon, fakeRunner());
    app = createNodeApp(daemon);
  });

  it("records the deploy as accepted, then uploading, then deployed", async () => {
    const id = (await responseId(
      await upload(await operatorToken(), { source: SOURCE }),
    )) as string;
    await settled(id);

    expect(states).toEqual(["accepted", "uploading", "deployed"]);
    const record = await getDeployRecord(clock.ctx, APPLICATION, id);
    expect(record).toMatchObject({
      v: 1,
      id,
      application: APPLICATION,
      node: OPERATOR,
      state: "deployed",
      deployment: VERSION_ID,
      /* The audit trail a failed deploy would otherwise leave nowhere. */
      source: SOURCE,
    });
    expect(Date.parse(record.updatedAt)).toBeGreaterThanOrEqual(Date.parse(record.acceptedAt));
  });

  it("records the workload identity that started the deploy", async () => {
    const id = (await responseId(await upload(await workloadToken()))) as string;
    await settled(id);

    await expect(getDeployRecord(clock.ctx, APPLICATION, id)).resolves.toMatchObject({
      state: "deployed",
      oidc: { issuer: ISS, subject: SUBJECT },
    });
  });

  it("records why a deploy failed, and stops there", async () => {
    publish = () => Promise.reject(new Error("celld exited with code 1"));

    const id = (await responseId(await upload(await operatorToken()))) as string;
    await settled(id);

    expect(states).toEqual(["accepted", "uploading", "failed"]);
    const record = await getDeployRecord(clock.ctx, APPLICATION, id);
    expect(record.state).toBe("failed");
    expect(record.detail).toContain("celld exited with code 1");
    expect(record.deployment).toBeUndefined();
  });

  it("refuses the deploy outright when its record cannot be written", async () => {
    /* The id is the caller's only handle on the deploy, and a handle nothing is
       recorded under is one no node could ever answer for. */
    const faulted = new FaultStore(clock.ctx.store);
    faulted.onBeforePut = (key): void => {
      if (!key.startsWith(deploysPrefix(APPLICATION))) return;
      throw new ScafoError("draining", "Injected fault", { detail: "no record could be written" });
    };
    daemon.registry = { ...clock.ctx, store: faulted };
    daemon.deploys = createDeployService(daemon, fakeRunner());
    app = createNodeApp(daemon);

    const response = await upload(await operatorToken());

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(runs).toEqual([]);
  });
});

describe("polling a deploy on another node of the fleet", () => {
  /** A second daemon of the same installation, which accepted nothing. */
  let other: H3;

  beforeEach(() => {
    other = createNodeApp({
      config: daemonConfig(),
      nodeId: PEER,
      registry: clock.ctx,
      supervisor: fakeSupervisor(),
      versions: { scafo: "0.0.0-test", celld: CELLD_VERSION },
      reconciler: fakeReconciler(),
    });
  });

  it("answers an operator from the record, having accepted nothing itself", async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;
    await settled(id);

    const response = await poll(other, id, await operatorToken());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id,
      application: APPLICATION,
      state: "deployed",
      deployment: VERSION_ID,
    });
  });

  it("carries the code of a failure across, so a poll from memory and one from the record agree", async () => {
    publish = () =>
      Promise.reject(new ScafoError("version-skew", "Two Celld versions over one fleet"));
    const id = (await responseId(await upload(await operatorToken()))) as string;
    const remembered = await settled(id);

    const response = await poll(other, id, await operatorToken());

    expect(remembered.code).toBe("version-skew");
    await expect(response.json()).resolves.toMatchObject({ state: "failed", code: "version-skew" });
  });

  it("answers the workload token that started the deploy, which is the CI case", async () => {
    /* The poll behind a shared apex lands wherever the ingress sends it, and the
       application in the id is what lets this node verify the token against that
       application's trust policy. */
    const id = (await responseId(await upload(await workloadToken()))) as string;
    await settled(id);

    const response = await poll(other, id, await workloadToken());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id, state: "deployed" });
  });

  it("answers a deploy that is still running with where it has got to", async () => {
    const builder = Promise.withResolvers<DeployRunResult>();
    publish = () => builder.promise;
    const id = (await responseId(await upload(await operatorToken()))) as string;
    await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 5000, interval: 5 });

    const response = await poll(other, id, await operatorToken());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id, state: "uploading" });
    builder.resolve({ celldVersionId: VERSION_ID });
    await settled(id);
  });

  it("refuses a scoped-out operator before it reads anything", async () => {
    /* No deploy exists under this id at all: a 404 would mean the scope was
       applied to what the read found, rather than to the application asked for. */
    const response = await poll(other, `${APPLICATION}.a1b2c3d4e5f60718`, await scopedToken());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ type: "urn:scafo:auth-scope" });
  });

  it("answers an id of an application that never deployed as a miss", async () => {
    const response = await poll(other, `${APPLICATION}.a1b2c3d4e5f60718`, await operatorToken());

    const problem = await problemOf(response);
    expect(problem.status).toBe(404);
    expect(problem.detail).toContain(APPLICATION);
  });

  it("answers an id that is no id of ours as a miss, without naming an application", async () => {
    const response = await poll(other, "0000000000000000", await operatorToken());

    const problem = await problemOf(response);
    expect(problem.status).toBe(404);
    expect(problem.detail).toContain("0000000000000000");
  });

  it("answers a record filed under an application its id does not claim as a miss", async () => {
    /* A document written by hand, or by a build that filed it elsewhere: the id
       is what the caller was authenticated against, and a record that disagrees
       with it is not the one the caller asked for. */
    const id = `${APPLICATION}.a1b2c3d4e5f60718`;
    await clock.ctx.store.put(
      `${deploysPrefix(APPLICATION)}${id}.json`,
      JSON.stringify({
        v: 1,
        id,
        application: RIVAL,
        state: "deployed",
        node: PEER,
        acceptedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } satisfies DeployRecord),
    );

    const response = await poll(other, id, await operatorToken());

    expect(response.status).toBe(404);
  });

  it("tells a caller without a token nothing, wherever the deploy lives", async () => {
    const id = (await responseId(await upload(await operatorToken()))) as string;
    await settled(id);

    const response = await poll(other, id, undefined);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(AUTH_INVALID_PROBLEM);
  });
});

describe("retired deployment-selection endpoints", () => {
  it.each([
    ["alias", `/v1/applications/${APPLICATION}/alias`],
    ["split", `/v1/applications/${APPLICATION}/split`],
  ])("keeps the removed %s mutation unavailable", async (_name, path) => {
    const response = await post(path, await operatorToken(), { deployment: VERSION_ID });
    expect(response.status).toBe(404);
  });
});

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
      bindHost: "127.0.0.1",
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
    forget: () => {},
    onExit: () => {},
  };
}

/** Reports whatever the test has decided is running; nothing else. */
function fakeReconciler(processes: () => RuntimeProcess[] = () => running): Reconciler {
  return {
    runOnce: () => Promise.resolve([]),
    kick: () => {},
    start: () => {},
    shutdown: () => Promise.resolve(),
    stop: () => {},
    /* A pass has finished and the fleet answers on nothing — not the absence of
       one, which no route under test reads. */
    fleetRouting: () => ({ v: 1, routes: [] }),
    status: () => ({
      lastRunAt: null,
      running: false,
      lastActions: [],
      failures: [],
      processes: processes(),
      placements: [],
    }),
  };
}

/** Another live machine telling the fleet it already serves `application` on `celld`. */
async function servedElsewhere(
  celld: string | undefined,
  application: string = APPLICATION,
): Promise<void> {
  await registerNode(clock.ctx, {
    v: 1,
    id: PEER,
    publicKey: { kty: "OKP", crv: "Ed25519", x: PEER },
    addresses: PEER_ADDRESS,
    heartbeatAt: new Date(clock.nowMs()).toISOString(),
    ...(celld === undefined ? {} : { versions: { scafo: "0.0.0-test", celld } }),
    serving: { [application]: { port: 42_000 } },
  });
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

/** Uploads the artifact to `target`, with `metadata` as the whole of its meta part. */
async function upload(
  token: string | undefined,
  metadata: Record<string, unknown> = {},
  target: string = APPLICATION,
): Promise<Response> {
  return await app.request(`/v1/applications/${target}/deploys`, {
    method: "POST",
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      "content-type": "application/octet-stream",
      [DEPLOY_METADATA_HEADER]: encodeDeployMetadata(metadata as DeployMetadata),
    },
    body: artifact.open(),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function streamedUpload(
  token: string | undefined,
  application: string,
  metadata: Record<string, unknown> | string,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const encoded =
    typeof metadata === "string" ? metadata : encodeDeployMetadata(metadata as DeployMetadata);
  return await app.request(`/v1/applications/${application}/deploys`, {
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

async function get(path: string, token: string | undefined): Promise<Response> {
  return app.request(path, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

/** Polls `app` for one deploy, as an operator or a workload behind the apex does. */
async function poll(node: H3, id: string, token: string | undefined): Promise<Response> {
  return node.request(`/v1/deploys/${id}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

/**
 * Wraps a store so every state written to a deploy record is remembered in
 * order: what a deploy's record went through is as much the contract as where
 * it ended up.
 */
function watchingDeployRecords(inner: CasStore, states: string[]): CasStore {
  return {
    get: (key) => inner.get(key),
    getBytes: (key, opts) => inner.getBytes(key, opts),
    put: (key, body, cas) => {
      if (key.startsWith(deploysPrefix(APPLICATION)) && typeof body === "string") {
        states.push((JSON.parse(body) as DeployRecord).state);
      }
      return inner.put(key, body, cas);
    },
    del: (key) => inner.del(key),
    list: (prefix) => inner.list(prefix),
    listEntries: (prefix) => inner.listEntries(prefix),
  };
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

/** A token this node's registered operator key verifies, good for one request. */
function operatorToken(): Promise<string> {
  return signNodeToken(operatorKeys.privateKey, OPERATOR);
}

/** A token of the trusted key that reaches every application but this one. */
function scopedToken(): Promise<string> {
  return signNodeToken(scopedKeys.privateKey, SCOPED);
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
