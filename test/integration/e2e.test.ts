/*
 * End-to-end single-node Caddy deployment path. Caddy and daemon share a network
 * namespace; runtimes bind loopback.
 *
 * CADDY PULLS. Nothing here is written into Caddy: the fixture config names the
 * `scafo` dynamic-upstreams module, and Caddy asks the node where each host lives
 * every second. So an assertion after a deploy is a poll, not a one-shot — the
 * routing document has to be fetched before the new host resolves.
 *
 * TWO APPLICATIONS OUT OF ONE DIRECTORY. The fixture's config names `app`, and
 * that name is what the CLI deploys into when no `--name` is given. `--env ci`
 * on the same directory addresses `app-ci` instead, so the suite runs two
 * applications whose names share a prefix side by side — which is what makes the
 * deletion at the end worth making: `app-ci` has to leave without taking one
 * byte of `app` with it.
 */

import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonState } from "../../src/daemon/app.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  applicationKey,
  deployPrefix,
  fleetPrefix,
  getApplication,
  listDeployments,
  placementKey,
  readJson,
  readMeta,
  type RegistryContext,
  nodeKey,
  operatorKey as operatorRecordKey,
  trustKey,
} from "../../src/core/registry/index.ts";
import type { NodeRecord, OperatorRecord, TrustPolicy } from "../../src/core/types/registry.ts";
import {
  NODE_IMAGE,
  ADOPTION_BOUND_MS,
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  type BucketSettings,
  type CommandResult,
  DEADLINE_MS,
  deploymentOf,
  FIXTURES,
  type HttpAnswer,
  httpGet,
  registryAt,
  REPO_ROOT,
  runCli,
  SETUP_TIMEOUT_MS,
  stageApp as stageAppIn,
  type StartedStore,
  startStore,
  STEP_TIMEOUT_MS,
  storeEnv as storeEnvFor,
  until as untilPolled,
} from "./_harness.ts";
import { startStubIssuer, type StubIssuer } from "./_stub-issuer.ts";

const E2E = process.env.SCAFO_E2E === "1";

/**
 * Caddy with both `scafo` modules compiled in. The published image is the
 * default; point this at a locally built tag to run the suite against modules
 * that are not released yet.
 */
const CADDY_IMAGE: string =
  process.env.SCAFO_E2E_CADDY_IMAGE ?? "ghcr.io/sandros94/scafo-caddy:edge";

const CADDY_HTTP_PORT = 80;
/** Published on the Caddy container, because the daemon shares its namespace. */
const NODE_PORT = 7400;

/**
 * Supplied rather than minted: Caddy starts before the node and has to present
 * the token from its very first poll, so both sides are told the same one.
 */
const INGRESS_TOKEN = "e2e-caddy-ingress-token";

/** What the fixture's error route answers with, for a host or a path nothing serves. */
const NO_ROUTE = "scafo: no route";

const BUCKET = "scafo-e2e";
const KEY_PREFIX = "e2e";
const ACCESS_KEY = "scafo";
const SECRET_KEY = "scafo-secret";
const REGION = "us-east-1";

/** The same four settings the harness starts the store and the CLI with. */
const BUCKET_SETTINGS: BucketSettings = {
  bucket: BUCKET,
  prefix: KEY_PREFIX,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
  region: REGION,
};

const PLATFORM_DOMAIN = "scafo.test";
const OPERATOR_HOST = "operator.test";
/**
 * The application the fixture's `wrangler.jsonc` names, and therefore the one a
 * deploy of that directory addresses when it passes no `--name` at all.
 */
const APPLICATION = "app";
/** The Celld script name the fixture's `wrangler.jsonc` carries, and the first
    segment of every deployment Celld publishes for it. */
const SCRIPT_NAME = "app";
const NODE_ID = "node-e2e";

/** `--env` of the workload-deployed application; it exists nowhere until then. */
const CI_ENV = "ci";
/** The application that `--env` addresses: the fixture's own name, suffixed. */
const CI_APPLICATION = `${APPLICATION}-${CI_ENV}`;
/** `--env` of the `--var` deploy, so nothing else is disturbed by it. */
const VARS_ENV = "vars";
/** `--env` of the already-bundled artifact, published with no flag. */
const PREBUNDLED_ENV = "prebundled";

/** The subject pattern `app-ci` trusts, as an operator would write it. */
const CI_SUBJECT_GLOB = "repo:acme/shop:ref:refs/heads/*";
/** A workload the glob above admits. */
const CI_SUBJECT = "repo:acme/shop:ref:refs/heads/main";
/** The subject pattern `app` trusts, which is a different repository entirely. */
const APP_SUBJECT_GLOB = "repo:acme/storefront:ref:refs/heads/*";
/** A workload of a repository nothing in either policy names. */
const HOSTILE_SUBJECT = "repo:evil/other:ref:refs/heads/main";

let store: StartedStore;
let caddy: StartedTestContainer;
let daemon: StartedTestContainer;
/** Stands in for a CI provider; the daemon reaches it over the bridge by URL. */
let issuer: StubIssuer;

/** Endpoints of the one bucket, as the host and as the containers reach it. */
let storeFromHost: string;
let storeFromContainers: string;

let caddyHttpPort: number;
let apiPort: number;

let registry: RegistryContext;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let versionV1: string;
let versionV2: string;
let versionCi: string;

const tmpDirs: string[] = [];
/** Daemon output retained for failure context. */
const daemonLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the single-node product loop, end to end", () => {
  beforeAll(async () => {
    store = await startStore(BUCKET_SETTINGS);
    storeFromHost = store.fromHost;
    storeFromContainers = store.fromContainers;

    /* Started first, and deliberately before the node it will poll: a Caddy whose
       daemon is not up yet must come up anyway and start routing once it is. */
    caddy = await new GenericContainer(CADDY_IMAGE)
      .withCopyFilesToContainer([
        { source: join(FIXTURES, "caddy.json"), target: "/etc/caddy/config.json" },
      ])
      .withEnvironment({ SCAFO_INGRESS_TOKEN: INGRESS_TOKEN })
      .withCommand(["caddy", "run", "--config", "/etc/caddy/config.json"])
      .withExposedPorts(CADDY_HTTP_PORT, NODE_PORT)
      .withWaitStrategy(Wait.forLogMessage(/serving initial configuration/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    caddyHttpPort = caddy.getMappedPort(CADDY_HTTP_PORT);
    apiPort = caddy.getMappedPort(NODE_PORT);

    daemon = await new GenericContainer(NODE_IMAGE)
      .withNetworkMode(`container:${caddy.getId()}`)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "ro" }])
      .withWorkingDir("/work")
      .withEnvironment({
        SCAFO_S3_ENDPOINT: storeFromContainers,
        SCAFO_S3_BUCKET: BUCKET,
        SCAFO_S3_PREFIX: KEY_PREFIX,
        SCAFO_S3_ACCESS_KEY: ACCESS_KEY,
        SCAFO_S3_SECRET_KEY: SECRET_KEY,
        SCAFO_S3_REGION: REGION,
        SCAFO_NODE_ID: NODE_ID,
        SCAFO_TRANSPORT: "none",
        SCAFO_STATE_DIR: "/var/lib/scafo",
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
        SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
        CELLD_ESBUILD: "/usr/local/bin/esbuild",
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "sail",
        "--listen",
        `0.0.0.0:${String(NODE_PORT)}`,
      ])
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => daemonLog.push(String(chunk)));
        stream.on("err", (chunk) => daemonLog.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    registry = registryAt(storeFromHost, BUCKET_SETTINGS);

    issuer = await startStubIssuer({
      network: BRIDGE_NETWORK,
      startupTimeoutMs: BOOT_DEADLINE_MS,
    });
    observed.issuer = issuer.iss;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await caddy?.stop().catch(() => {});
    await issuer?.stop();
    await store?.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "answers its health endpoint and has bootstrapped the registry in the bucket",
    async () => {
      const health = await until(
        "the daemon to answer /.well-known/scafo/health",
        BOOT_DEADLINE_MS,
        async () => {
          const answer = await httpGet(apiPort, "/.well-known/scafo/health", {});
          return answer.status === 200 ? answer : null;
        },
      );
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });

      const meta = await readMeta(registry);
      expect(meta, "the registry the first node bootstraps").not.toBeNull();
      expect(meta?.platformDomains).toEqual([PLATFORM_DOMAIN]);

      const node = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(node?.value.addresses).toMatchObject({ apiPort: NODE_PORT });
      observed.health = JSON.parse(health.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "registers an operator key whose public half lands in the registry",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-key-"));
      tmpDirs.push(dir);
      keyPath = join(dir, "operator.json");

      const result = await runCli(
        ["operator", "keygen", "--out", keyPath, "--register"],
        storeEnv(),
      );
      expectCleanExit(result);

      operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
      const record = await readJson<OperatorRecord>(registry, operatorRecordKey(operatorKey.id));
      expect(record?.value.publicKey.x).toBe(operatorKey.publicKey.x);
      expect(await readJson(registry, nodeKey(operatorKey.id))).toBeNull();
      observed.operatorId = operatorKey.id;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys the first version into the application the config names, with no --name at all",
    async () => {
      const args = [...deployArgs(await stageApp("v1")), "--key", keyPath];
      /* The directory's own `name` is what this deploy addresses: nothing on the
         command line says which application it is, and the one it creates is the
         one the config carries. */
      expect(args).not.toContain("--name");
      expect(args).not.toContain("--env");

      const started = Date.now();
      const result = await runCli(args, {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      versionV1 = deploymentOf(result.output);
      expect(await listDeployments(registry, APPLICATION)).toContain(versionV1);
      expect(await readJson(registry, applicationKey(APPLICATION))).not.toBeNull();
      observed.versionV1 = versionV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the first deployment through Caddy on the application's own host",
    async () => {
      const answer = await untilServes(appHost(), "v1");
      expect(JSON.parse(answer.body).url, `the url ${appHost()} saw`).toContain(appHost());

      const runtimeHealth = await until(
        `${appHost()} to answer celld health`,
        DEADLINE_MS,
        async () => {
          const probed = await httpGet(caddyHttpPort, "/.well-known/celld/health", {
            host: appHost(),
          });
          return probed.status === 200 && probed.body === '{"ok":true}' ? probed : null;
        },
      );
      expect(JSON.parse(runtimeHealth.body)).toEqual({ ok: true });
      observed.v1Host = appHost();
      observed.celldHealth = runtimeHealth.status;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "leaves the route the operator authored in Caddy untouched",
    async () => {
      /* An operator route sits BEFORE the scafo catch-all and is matched first.
         Nothing scafo does can disturb it, because scafo writes nothing into
         this Caddy at all — but that is exactly what deserves stating once, and
         it is stated after a deploy so it is not vacuously true. */
      const answer = await httpGet(caddyHttpPort, "/", { host: OPERATOR_HOST });
      expect(answer.status).toBe(200);
      expect(answer.body).toBe("operator");
      observed.operatorRoute = { status: answer.status, body: answer.body };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers the fleet's API at the platform domain's own apex, through Caddy",
    async () => {
      const health = await until(
        `${PLATFORM_DOMAIN} to answer the daemon's health through Caddy`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(caddyHttpPort, "/.well-known/scafo/health", {
            host: PLATFORM_DOMAIN,
          });
          return answer.status === 200 ? answer : null;
        },
      );
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });
      observed.apexHealth = JSON.parse(health.body);

      /* Reached the node and was answered by it: a path the API does not serve
         is the node's own 404, not the ingress's. */
      const missing = await httpGet(caddyHttpPort, "/v1/nope", { host: PLATFORM_DOMAIN });
      expect(missing.status).toBe(404);
      expect(missing.body).not.toContain("urn:scafo:not-found");
      expect(missing.body).not.toBe(NO_ROUTE);

      const served = await httpGet(caddyHttpPort, "/", { host: appHost() });
      expect(served.status).toBe(200);
      expect(served.body).toContain(`"v1"`);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "NEVER reaches /v1/storage or the routing document through that apex",
    async () => {
      /* Answered by CADDY, not by the node behind it: the module resolves these
         to no upstream at all and records `denied`, and the fixture's error route
         is what turns that into this 404. The body is how the two are told
         apart — the node's own 404 never says this. */
      for (const path of [
        "/v1/storage",
        "/v1/storage/list?prefix=",
        "/v1/storage/objects/anything",
        "/v1/ingress/routes",
        "/v1/ingress/routes/traefik",
      ]) {
        const blocked = await httpGet(caddyHttpPort, path, { host: PLATFORM_DOMAIN });

        expect(blocked.status, `${path} through the apex`).toBe(404);
        expect(blocked.body, `${path} through the apex`).not.toContain("urn:scafo:");
        expect(blocked.body, `${path} through the apex`).toBe(NO_ROUTE);
      }
      observed.apexDenied = ["/v1/storage", "/v1/ingress/routes"];

      /* The denial is at a path SEGMENT boundary, so a path that merely starts
         with the same letters is proxied like any other — and reaches the node,
         which is what its own answer proves. */
      for (const path of ["/v1/storagex", "/v1/ingress/routesx"]) {
        const proxied = await httpGet(caddyHttpPort, path, { host: PLATFORM_DOMAIN });

        expect(proxied.body, `${path} through the apex`).not.toBe(NO_ROUTE);
      }
      observed.apexNotDenied = ["/v1/storagex", "/v1/ingress/routesx"];

      const local = await httpGet(apiPort, "/v1/storage/list?prefix=", {});
      expect(local.status).toBe(401);
      expect(local.body).toContain("urn:scafo:");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers a host the fleet does not serve with the same 404, and says nothing more",
    async () => {
      const unknown = await httpGet(caddyHttpPort, "/", { host: "unrouted.scafo.test" });

      expect(unknown.status).toBe(404);
      expect(unknown.body).toBe(NO_ROUTE);
      observed.unknownHost = { status: unknown.status, body: unknown.body };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "tells an ingress it serves a platform host and refuses one nothing claimed",
    async () => {
      const served = await httpGet(apiPort, `/v1/ingress/ask?domain=${appHost()}`, {});
      expect(served.status).toBe(200);

      const apex = await httpGet(apiPort, `/v1/ingress/ask?domain=${PLATFORM_DOMAIN}`, {});
      expect(apex.status).toBe(200);

      const unknown = await httpGet(apiPort, "/v1/ingress/ask?domain=unclaimed.example.com", {});
      expect(unknown.status).toBe(404);
      observed.ask = { served: served.status, apex: apex.status, unknown: unknown.status };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys a second version for the existing application",
    async () => {
      const started = Date.now();
      const result = await runCli([...deployArgs(await stageApp("v2")), "--key", keyPath], {});
      observed.deployV2Ms = Date.now() - started;
      observed.deployV2Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      versionV2 = deploymentOf(result.output);
      expect(versionV2).not.toBe(versionV1);
      observed.versionV2 = versionV2;

      /*
       * FROM `deployed` TO SERVED, measured. The accepting node asks its local
       * runtime process to adopt the fleet's pointer the moment the revision is
       * recorded, instead of leaving it to the runtime's own thirty-second poll —
       * so the application answers with the new version in seconds. The bound is
       * well under that poll, and loose enough to hold on a loaded machine.
       */
      const deployedAt = Date.now();
      await untilServes(appHost(), "v2");
      const adoptedMs = Date.now() - deployedAt;
      observed.adoptedMs = adoptedMs;
      console.log(`e2e: ${APPLICATION} served v2 ${String(adoptedMs)}ms after it was deployed`);
      expect(adoptedMs, `${String(adoptedMs)}ms from "deployed" to serving v2`).toBeLessThan(
        ADOPTION_BOUND_MS,
      );

      const operator = await httpGet(caddyHttpPort, "/", { host: OPERATOR_HOST });
      expect(operator.body, "the operator's own route outlives a deploy").toBe("operator");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "settles on exactly one application-owned runtime process",
    async () => {
      const state = await until(
        "the node to report a single running process",
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(apiPort, "/v1/state", {
            authorization: `Bearer ${await operatorToken()}`,
          });
          if (answer.status !== 200) return null;

          const body = JSON.parse(answer.body) as DaemonState;
          const running = body.processes.filter((process) => process.state === "running");
          return running.length === 1 ? body : null;
        },
      );

      const running = state.processes.filter((process) => process.state === "running");
      expect(running[0].id).toBe(APPLICATION);
      expect(state.node?.id).toBe(NODE_ID);
      expect(state.reconcile?.failures ?? []).toEqual([]);
      observed.finalProcesses = state.processes;
      observed.finalReconcile = state.reconcile;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "records one trust policy per application, each naming its own repository",
    async () => {
      /* Two policies, under two names that share a prefix, admitting different
         repositories. Trust is stated for exactly one application: `app-ci` and
         `app` are as unrelated here as any two names in the installation. */
      for (const [flags, subject] of [
        [["--name", APPLICATION, "--env", CI_ENV], CI_SUBJECT_GLOB],
        [["--name", APPLICATION], APP_SUBJECT_GLOB],
      ] as Array<[string[], string]>) {
        const result = await runCli(
          [
            "trust",
            "set",
            ...flags,
            "--issuer",
            issuer.iss,
            "--audience",
            "scafo",
            "--subject",
            subject,
          ],
          storeEnv(),
        );
        expectCleanExit(result);
      }

      const ciPolicy = await readJson<TrustPolicy>(registry, trustKey(CI_APPLICATION));
      expect(ciPolicy?.value.issuers).toEqual([
        { iss: issuer.iss, aud: "scafo", subjects: [CI_SUBJECT_GLOB] },
      ]);
      const appPolicy = await readJson<TrustPolicy>(registry, trustKey(APPLICATION));
      expect(appPolicy?.value.issuers).toEqual([
        { iss: issuer.iss, aud: "scafo", subjects: [APP_SUBJECT_GLOB] },
      ]);

      const shown = await runCli(
        ["trust", "show", "--name", APPLICATION, "--env", CI_ENV],
        storeEnv(),
      );
      expectCleanExit(shown);
      expect(shown.output).toContain(CI_SUBJECT_GLOB);
      expect(shown.output).toContain(issuer.iss);
      observed.trustPolicies = {
        [CI_APPLICATION]: ciPolicy?.value,
        [APPLICATION]: appPolicy?.value,
      };
      observed.trustShowOutput = shown.output;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys a second application out of the same directory with nothing but a workload token",
    async () => {
      const token = await issuer.mint({ sub: CI_SUBJECT });
      const args = [...deployArgs(await stageApp("v3"), CI_ENV), "--token", token];

      /* No operator key and no bucket credentials: everything this deploy is
         allowed to do it is allowed on the strength of the token alone. */
      expect(args).not.toContain("--key");
      expect(args).not.toContain("--name");
      const ciEnv: Record<string, string> = {};
      expect(Object.keys(ciEnv).filter((name) => name.startsWith("SCAFO_"))).toEqual([]);

      const started = Date.now();
      const result = await runCli(args, ciEnv);
      observed.workloadDeployMs = Date.now() - started;
      observed.workloadDeployOutput = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      versionCi = deploymentOf(result.output);
      expect(await listDeployments(registry, CI_APPLICATION)).toContain(versionCi);
      observed.workloadDeployment = versionCi;
      observed.workloadSubject = CI_SUBJECT;

      const ci = await getApplication(registry, CI_APPLICATION);
      expect(ci.deployment).toMatchObject({ revision: 1 });
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves both applications side by side, each on its own host and its own version",
    async () => {
      const ci = await untilServes(ciHost(), "v3");
      expect(JSON.parse(ci.body).url).toContain(ciHost());

      const settled = await untilServes(appHost(), "v2");
      expect(JSON.parse(settled.body).url).toContain(appHost());

      expect(ciHost()).not.toBe(appHost());
      expect(JSON.parse(ci.body).version).toBe("v3");
      expect(JSON.parse(settled.body).version).toBe("v2");

      const both = await httpGet(apiPort, "/v1/state", {
        authorization: `Bearer ${await operatorToken()}`,
      });
      expect(both.status).toBe(200);
      const running = (JSON.parse(both.body) as DaemonState).processes
        .filter((process) => process.state === "running")
        .map((process) => process.id)
        .sort();
      expect(running).toEqual([APPLICATION, CI_APPLICATION]);

      observed.sideBySide = {
        [appHost()]: JSON.parse(settled.body).version,
        [ciHost()]: JSON.parse(ci.body).version,
        running,
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "refuses a token from a repository the policy does not name, and says which failure it was",
    async () => {
      const token = await issuer.mint({ sub: HOSTILE_SUBJECT });
      const result = await runCli(
        [...deployArgs(await stageApp("v4"), CI_ENV), "--token", token],
        {},
      );

      observed.hostileDeployOutput = result.output;
      observed.hostileDeployCode = result.code;

      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("urn:scafo:trust-mismatch");
      expect(result.output).toContain(HOSTILE_SUBJECT);

      const ci = await getApplication(registry, CI_APPLICATION);
      expect(ci.deployment).toMatchObject({ revision: 1 });
      await untilServes(ciHost(), "v3");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "admits the refused subject with the command the refusal ends on, keeping what was trusted",
    async () => {
      /* A third application, so that nothing else in the suite sees its deploys.
         It trusts one repository; a token from another earns the refusal, and
         the refusal's last words are run exactly as printed. */
      const hintEnv = "hint";
      const hinted = `${APPLICATION}-${hintEnv}`;
      const granted = await runCli(
        [
          "trust",
          "set",
          "--name",
          APPLICATION,
          "--env",
          hintEnv,
          "--issuer",
          issuer.iss,
          "--subject",
          CI_SUBJECT_GLOB,
        ],
        storeEnv(),
      );
      expectCleanExit(granted);

      const token = await issuer.mint({ sub: HOSTILE_SUBJECT });
      const refused = await runCli(
        [...deployArgs(await stageApp("v7"), hintEnv), "--token", token],
        {},
      );
      expect(refused.code, refused.output).not.toBe(0);
      expect(refused.output).toContain("urn:scafo:trust-mismatch");
      /* Nothing of what the application does trust is told to whoever was refused. */
      expect(refused.output).not.toContain(CI_SUBJECT_GLOB);

      const printed = /"(scafo trust add [^"]+)"/.exec(refused.output)?.[1];
      expect(printed, refused.output).toBe(
        `scafo trust add --name ${hinted} --issuer ${issuer.iss} --subject ${HOSTILE_SUBJECT}`,
      );
      observed.trustHint = printed;

      const admitted = await runCli((printed ?? "").split(" ").slice(1), storeEnv());
      expectCleanExit(admitted);
      const policy = await readJson<TrustPolicy>(registry, trustKey(hinted));
      expect(policy?.value.issuers).toEqual([
        { iss: issuer.iss, aud: "scafo", subjects: [CI_SUBJECT_GLOB, HOSTILE_SUBJECT] },
      ]);

      const accepted = await runCli(
        [
          ...deployArgs(await stageApp("v7"), hintEnv),
          "--token",
          await issuer.mint({ sub: HOSTILE_SUBJECT }),
        ],
        {},
      );
      expectCleanExit(accepted);
      await untilServes(`${hinted}.${PLATFORM_DOMAIN}`, "v7");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "refuses a token one application trusts when it is presented for another",
    async () => {
      /* The same token that just deployed `app-ci`, offered to `app`. Trust is
         stated per application and nothing about a shared prefix carries it
         across: `app` names another repository, so this is a denial rather than
         a token failure, and the refusal names the application it was for. */
      const token = await issuer.mint({ sub: CI_SUBJECT });
      const result = await runCli([...deployArgs(await stageApp("v5")), "--token", token], {});

      observed.crossApplicationOutput = result.output;
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("urn:scafo:trust-mismatch");
      expect(result.output).toContain(CI_SUBJECT);
      expect(result.output).toContain(`"${APPLICATION}"`);

      const application = await getApplication(registry, APPLICATION);
      expect(application.deployment).toMatchObject({ revision: 2 });
      await untilServes(appHost(), "v2");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "leaves one application exactly as it was when the other takes a deploy",
    async () => {
      const before = await getApplication(registry, APPLICATION);
      const token = await issuer.mint({ sub: CI_SUBJECT });
      const result = await runCli(
        [...deployArgs(await stageApp("v6"), CI_ENV), "--token", token],
        {},
      );
      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      await untilServes(ciHost(), "v6");
      const untouched = await untilServes(appHost(), "v2");
      expect(JSON.parse(untouched.body).version).toBe("v2");

      const after = await getApplication(registry, APPLICATION);
      expect(after.deployment).toEqual(before.deployment);
      expect(await listDeployments(registry, APPLICATION)).toEqual(
        await listDeployments(registry, APPLICATION),
      );
      expect(await listDeployments(registry, CI_APPLICATION)).toHaveLength(2);

      observed.independentDeploy = {
        redeployed: CI_APPLICATION,
        untouched: APPLICATION,
        deployment: after.deployment,
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "lets --var override the config's own variable and leaves the others as written",
    async () => {
      const result = await runCli(
        [
          ...deployArgs(await stageApp("v7"), VARS_ENV),
          "--key",
          keyPath,
          "--var",
          "GREETING:from-flag",
        ],
        {},
      );
      observed.varDeployOutput = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      const host = `${APPLICATION}-${VARS_ENV}.${PLATFORM_DOMAIN}`;
      const answer = await untilServes(host, "v7");
      const body = JSON.parse(answer.body) as Record<string, unknown>;

      /* The running application is the proof: the flag's value reached it, and
         the variable the flag never named arrived exactly as the config has it. */
      expect(body.greeting).toBe("from-flag");
      expect(body.kept).toBe("kept");
      observed.varDeployBody = body;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "publishes an already-bundled artifact on its own config, with no flag at all",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-prebundled-"));
      tmpDirs.push(dir);
      await cp(join(FIXTURES, "prebundled"), dir, { recursive: true });

      const args = [...deployArgs(dir, PREBUNDLED_ENV), "--key", keyPath];
      expect(args).not.toContain("--no-bundle");
      expect(args).not.toContain("--var");

      const result = await runCli(args, {});
      observed.prebundledDeployOutput = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      const host = `${APPLICATION}-${PREBUNDLED_ENV}.${PLATFORM_DOMAIN}`;
      const answer = await untilServes(host, "prebundled");
      expect(JSON.parse(answer.body).url).toContain(host);
      observed.prebundled = JSON.parse(answer.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "prunes the application's old Celld deployments straight out of the bucket",
    async () => {
      /* Bucket-direct, like every other command that holds no node: the store
         settings come from the environment, and no `--node` is passed. The
         application has published two versions and its pointer names the
         second, so one deployment is past `--keep 1` and the age gate is
         lifted. */
      const before = await deployedPrefixes(APPLICATION);
      expect(before, "the two versions this suite deployed").toEqual(
        expect.arrayContaining([versionV1, versionV2]),
      );

      const result = await runCli(
        ["deployment", "prune", "--name", APPLICATION, "--keep", "1", "--older-than", "0", "--yes"],
        storeEnv(),
      );
      observed.pruneOutput = result.output;
      expectCleanExit(result);

      const after = await deployedPrefixes(APPLICATION);
      expect(after, "the version the fleet's own pointer names").toContain(versionV2);
      expect(after, "the old version prune was told to take").not.toContain(versionV1);

      /* The proof that what was deleted was old and not live: the application
         answers on the version it was serving before the prune. */
      const answer = await untilServes(appHost(), "v2");
      expect(JSON.parse(answer.body).url).toContain(appHost());
      observed.prunedAway = versionV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "refuses to prune an installation no node is answering for",
    async () => {
      /* The release gate reads the Celld every answering node reports. Another
         prefix of the same bucket is an installation no node ever started in,
         so nothing says which Celld wrote it — and a prune that cannot tell
         refuses rather than guesses. The same refusal meets a stopped fleet once
         its last heartbeat has left the liveness window. */
      const result = await runCli(
        ["deployment", "prune", "--name", APPLICATION, "--keep", "0", "--older-than", "0", "--yes"],
        { ...storeEnv(), SCAFO_S3_PREFIX: `${BUCKET_SETTINGS.prefix}-unserved` },
      );
      observed.pruneRefusalOutput = result.output;

      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("urn:scafo:capability-missing");
      expect(result.output).toContain("no node of this installation is answering");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deletes one application whole and leaves the one whose name it prefixes serving",
    async () => {
      const nodeFlags = ["--node", `http://127.0.0.1:${String(apiPort)}`, "--key", keyPath];

      const retired = await runCli(
        ["app", "retire", "--name", APPLICATION, "--env", CI_ENV, ...nodeFlags],
        {},
      );
      expectCleanExit(retired);
      expect(retired.output).toContain("retired");

      await until(`${ciHost()} to stop being served`, DEADLINE_MS, async () => {
        const answer = await httpGet(caddyHttpPort, "/", { host: ciHost() });
        return answer.status === 404 ? answer : null;
      });

      const deleted = await runCli(
        ["app", "delete", "--name", APPLICATION, "--env", CI_ENV, "--force", ...nodeFlags],
        {},
      );
      observed.deleteOutput = deleted.output;
      expectCleanExit(deleted);
      expect(deleted.output).toContain(applicationKey(CI_APPLICATION));

      /* Everything of it, and only of it. `fleets/app-ci` and `fleets/app` share
         every character up to the hyphen, so a sweep by string prefix would take
         both — and the one that stays is what says this one did not. */
      for (const key of [
        applicationKey(CI_APPLICATION),
        trustKey(CI_APPLICATION),
        placementKey(CI_APPLICATION),
      ]) {
        expect(await readJson(registry, key), key).toBeNull();
      }
      expect(await registry.store.list(`${fleetPrefix(CI_APPLICATION)}/`)).toEqual([]);
      expect(await listDeployments(registry, CI_APPLICATION)).toEqual([]);

      expect(await readJson(registry, applicationKey(APPLICATION))).not.toBeNull();
      expect(await readJson(registry, trustKey(APPLICATION))).not.toBeNull();
      const kept = await registry.store.list(`${fleetPrefix(APPLICATION)}/`);
      expect(kept.length, "the fleet of the application that stays").toBeGreaterThan(0);
      expect(await listDeployments(registry, APPLICATION)).toContain(versionV2);

      const answer = await untilServes(appHost(), "v2");
      expect(JSON.parse(answer.body).url).toContain(appHost());

      const gone = await httpGet(caddyHttpPort, "/", { host: ciHost() });
      expect(gone.status).toBe(404);
      expect(gone.body).toBe(NO_ROUTE);

      observed.deleted = {
        application: CI_APPLICATION,
        keptFleetObjects: kept.length,
        keptHost: appHost(),
      };
    },
    STEP_TIMEOUT_MS,
  );
});

/** Every Celld version directory `application` still holds in the bucket. */
async function deployedPrefixes(application: string): Promise<string[]> {
  const prefix = `${deployPrefix(application)}${SCRIPT_NAME}/`;
  const versions = new Set<string>();
  for (const key of await registry.store.list(prefix)) {
    /* A version is a DIRECTORY under the script, so only a key with something
       beneath it names one; the script's own `current.json` sits here too. */
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash > 0) versions.add(rest.slice(0, slash));
  }
  return [...versions].sort();
}

/** The host the fixture's own application is served at. */
function appHost(): string {
  return `${APPLICATION}.${PLATFORM_DOMAIN}`;
}

/** The host the `--env ci` application is served at, which shares a prefix with it. */
function ciHost(): string {
  return `${CI_APPLICATION}.${PLATFORM_DOMAIN}`;
}

/**
 * The flags one deploy of the fixture is run with, from the host.
 *
 * NO `--name`, ever: the directory's config names the application, and `--env`
 * is the only thing that moves a deploy off it. Each caller adds the credential
 * it holds — `--key` for the operator, `--token` for a workload — so that the
 * absence of a key is visible at the call site rather than hidden here.
 */
function deployArgs(dir: string, env?: string): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(apiPort)}`,
    ...(env === undefined ? [] : ["--env", env]),
  ];
}

/** The bucket settings the CLI reads when it talks to the store directly. */
function storeEnv(): Record<string, string> {
  return storeEnvFor(storeFromHost, BUCKET_SETTINGS);
}

/** A copy of the fixture application with its version variable set to `version`. */
function stageApp(version: string): Promise<string> {
  return stageAppIn(version, tmpDirs);
}

/** A fresh single-use operator token; a spent one is refused as a replay. */
async function operatorToken(): Promise<string> {
  return signNodeToken(operatorKey.privateKey, operatorKey.id);
}

/** Polls one host through Caddy until it answers with the expected app version. */
async function untilServes(host: string, version: string): Promise<HttpAnswer> {
  return until(`${host} to serve "${version}"`, DEADLINE_MS, async () => {
    const answer = await httpGet(caddyHttpPort, "/", { host });
    if (answer.status !== 200) return null;
    return answer.body.includes(`"${version}"`) ? answer : null;
  });
}

/** Polls until `probe` returns a value, attaching daemon logs on timeout. */
function until<T>(what: string, deadlineMs: number, probe: () => Promise<T | null>): Promise<T> {
  return untilPolled(what, deadlineMs, probe, { context: daemonLogTail });
}

/** Fails with command output and daemon logs. */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${daemonLogTail()}`).toBe(0);
}

/** The tail of the daemon container's output, as a failure message carries it. */
function daemonLogTail(limit: number = 12_000): string {
  const text = daemonLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- daemon container logs ---\n${tail}\n--- end daemon container logs ---`;
}
