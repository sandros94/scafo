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

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { FleetRouting } from "../../src/core/types/ingress.ts";
import type { NodeRecord, OperatorRecord, TrustPolicy } from "../../src/core/types/registry.ts";
import {
  NODE_IMAGE,
  ADOPTION_BOUND_MS,
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  type BucketSettings,
  collectLogs,
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
  startExplained,
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
/** A host of the operator's own, outside every platform domain this node serves. */
const CUSTOM_HOST = "shop.custom.test";
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
/** The workload deploy refused for its subject, whose last words a later case runs. */
let hostileRefusal: CommandResult;

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

    daemon = await startExplained(
      new GenericContainer(NODE_IMAGE)
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
        .withLogConsumer(collectLogs(daemonLog))
        .withWaitStrategy(Wait.forLogMessage(/listening on/))
        .withStartupTimeout(BOOT_DEADLINE_MS),
      { log: daemonLog, what: `node ${NODE_ID}` },
    );

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
          return probed.status === 200 ? probed : null;
        },
      );
      observed.v1Host = appHost();
      observed.celldHealth = runtimeHealth.status;
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
    "names a platform host it serves in the routing document, and nothing claimed by nobody",
    async () => {
      const routing = await fleetRouting();
      const hosts = routing.routes.map((route) => route.host);

      /* The document is what an ingress approves certificates from: a host it
         names exactly may get one, and a host it does not name may not. */
      expect(hosts).toContain(appHost());
      expect(hosts).not.toContain("unclaimed.example.com");
      expect(routing.api?.hosts).toContain(PLATFORM_DOMAIN);
      expect(routing.wildcards).toContain(PLATFORM_DOMAIN);
      observed.routedHosts = hosts;
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

      /* The operator's own route sits before the scafo catch-all, and scafo
         writes nothing into this Caddy, so after a deploy it still answers
         exactly as the operator authored it. */
      const operator = await httpGet(caddyHttpPort, "/", { host: OPERATOR_HOST });
      expect(operator.status).toBe(200);
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
      hostileRefusal = result;

      observed.hostileDeployOutput = result.output;
      observed.hostileDeployCode = result.code;

      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("urn:scafo:trust-mismatch");
      expect(result.output).toContain(HOSTILE_SUBJECT);
      /* Nothing of what the application does trust is told to whoever was refused. */
      expect(result.output).not.toContain(CI_SUBJECT_GLOB);

      const ci = await getApplication(registry, CI_APPLICATION);
      expect(ci.deployment).toMatchObject({ revision: 1 });
      await untilServes(ciHost(), "v3");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "admits the refused subject with the command the refusal ends on, keeping what was trusted",
    async () => {
      /* The last words of the refusal above, run exactly as printed: they
         append the refused subject to what `app-ci` already trusts, and the
         same token deploys once they have. */
      const printed = /"(scafo trust add [^"]+)"/.exec(hostileRefusal.output)?.[1];
      expect(printed, hostileRefusal.output).toBe(
        `scafo trust add --name ${CI_APPLICATION} --issuer ${issuer.iss} --subject ${HOSTILE_SUBJECT}`,
      );
      observed.trustHint = printed;

      const admitted = await runCli((printed ?? "").split(" ").slice(1), storeEnv());
      expectCleanExit(admitted);
      const policy = await readJson<TrustPolicy>(registry, trustKey(CI_APPLICATION));
      expect(policy?.value.issuers).toEqual([
        { iss: issuer.iss, aud: "scafo", subjects: [CI_SUBJECT_GLOB, HOSTILE_SUBJECT] },
      ]);

      const accepted = await runCli(
        [
          ...deployArgs(await stageApp("v4"), CI_ENV),
          "--token",
          await issuer.mint({ sub: HOSTILE_SUBJECT }),
        ],
        {},
      );
      expectCleanExit(accepted);
      await untilServes(ciHost(), "v4");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "refuses a token one application trusts when it is presented for another",
    async () => {
      /* The subject `app-ci` was first deployed by, offered to `app`. Trust is
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
      const appDeployments = await listDeployments(registry, APPLICATION);
      const ciDeployments = await listDeployments(registry, CI_APPLICATION);

      /* `--var` is an edit of the archive alone, made before the directory is
         packed, so a workload deploy carries one like any other. */
      const token = await issuer.mint({ sub: CI_SUBJECT });
      const result = await runCli(
        [
          ...deployArgs(await stageApp("v6"), CI_ENV),
          "--token",
          token,
          "--var",
          "GREETING:from-flag",
        ],
        {},
      );
      observed.varDeployOutput = result.output;
      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      const version = deploymentOf(result.output);

      /* The running application is the proof: the flag's value reached it, and
         the variable the flag never named arrived exactly as the config has it. */
      const redeployed = JSON.parse((await untilServes(ciHost(), "v6")).body) as Record<
        string,
        unknown
      >;
      expect(redeployed.greeting).toBe("from-flag");
      expect(redeployed.kept).toBe("kept");
      observed.varDeployBody = redeployed;

      const untouched = JSON.parse((await untilServes(appHost(), "v2")).body) as Record<
        string,
        unknown
      >;
      expect(untouched.version).toBe("v2");
      expect(untouched.greeting, "the other application's own config").toBe("from-config");

      const after = await getApplication(registry, APPLICATION);
      expect(after.deployment).toEqual(before.deployment);
      expect(await listDeployments(registry, APPLICATION)).toEqual(appDeployments);
      const ciAfter = await listDeployments(registry, CI_APPLICATION);
      expect(ciAfter).toHaveLength(ciDeployments.length + 1);
      expect(ciAfter).toEqual(expect.arrayContaining([...ciDeployments, version]));

      observed.independentDeploy = {
        redeployed: CI_APPLICATION,
        untouched: APPLICATION,
        deployment: after.deployment,
      };
    },
    STEP_TIMEOUT_MS,
  );

  /*
   * A claim is made plain first and then upgraded in place with `--wildcard`,
   * so one host shows both shapes and is released once.
   *
   * Rule 3 — any other single label under the base answering from the
   * application itself — is the one part of this that the ingress has to
   * understand: it is published as a `*.<base>` key, which a consumer reaches
   * only by replacing a request host's first label with `*` after an exact miss.
   * Caddy reads the routing through the `scafo` dynamic-upstreams module, which
   * ships from another repository: this case needs an image whose module has
   * that lookup (`SCAFO_E2E_CADDY_IMAGE` overrides the pinned one).
   */
  it(
    "serves a custom domain an operator claims, its subdomains once the claim covers them, and neither once it is released",
    async () => {
      const nodeFlags = ["--node", `http://127.0.0.1:${String(apiPort)}`, "--key", keyPath];
      const envHost = `${CI_ENV}.${CUSTOM_HOST}`;
      const otherHost = `anything-else.${CUSTOM_HOST}`;

      /* Nothing answers there before the claim: the host is nobody's. */
      const before = await httpGet(caddyHttpPort, "/", { host: CUSTOM_HOST });
      expect(before.status).toBe(404);
      expect(before.body).toBe(NO_ROUTE);

      const added = await runCli(
        ["app", "domain", "add", CUSTOM_HOST, "--name", APPLICATION, ...nodeFlags],
        {},
      );
      observed.domainAddOutput = added.output;
      expectCleanExit(added);
      expect(added.output).toContain(CUSTOM_HOST);
      /* The DNS helper really ran, and said one of the two things it can say.
         WHICH one is the resolver's business rather than scafo's — a machine
         whose resolver answers for `.test` reads the first — and either way the
         claim stands and the command succeeded. */
      expect(added.output).toMatch(
        new RegExp(`already resolves to this installation|CNAME to "${appHost()}"`),
      );

      /* Caddy pulls, so this is a poll: the routing document has to carry the
         new host before the ingress can answer for it. */
      const plain = await untilServes(CUSTOM_HOST, "v2");
      expect(JSON.parse(plain.body).url, `the url ${CUSTOM_HOST} saw`).toContain(CUSTOM_HOST);

      /* And the routing document names it exactly, which is what makes
         on-demand TLS issue for a name an operator has just pointed here. */
      expect((await fleetRouting()).routes.map((route) => route.host)).toContain(CUSTOM_HOST);

      const listedPlain = await runCli(
        ["app", "domain", "list", "--name", APPLICATION, "--json", ...nodeFlags],
        {},
      );
      expectCleanExit(listedPlain);
      expect(JSON.parse(listedPlain.output)).toEqual({
        application: APPLICATION,
        domains: [CUSTOM_HOST],
        wildcardDomains: [],
      });

      /* The same claim, re-added with `--wildcard`, now covers its subdomains. */
      const upgraded = await runCli(
        [
          "app",
          "domain",
          "add",
          CUSTOM_HOST,
          "--name",
          APPLICATION,
          "--wildcard",
          "--json",
          ...nodeFlags,
        ],
        {},
      );
      expectCleanExit(upgraded);
      const claimed = JSON.parse(upgraded.output) as {
        application: { wildcardDomains?: string[] };
        dns: string;
        wildcardDns: string;
      };
      expect(claimed.application.wildcardDomains).toEqual([CUSTOM_HOST]);
      /* Both questions were asked, and each answered with one of the three
         things a resolver can say here. */
      expect(["ok", "pending", "unknown"]).toContain(claimed.dns);
      expect(["ok", "pending", "unknown"]).toContain(claimed.wildcardDns);
      observed.wildcardClaim = claimed;

      /* Rule 1: the base answers from the application itself. */
      const base = await untilServes(CUSTOM_HOST, "v2");
      expect(JSON.parse(base.body).url, `the url ${CUSTOM_HOST} saw`).toContain(CUSTOM_HOST);

      /* Rule 2: `<env>.<base>` answers from `<application>-<env>`, which this
         suite deployed through OIDC and which is serving v6. Both are ORDINARY
         host entries in the routing document, so any ingress already reads them. */
      const env = await untilServes(envHost, "v6");
      expect(JSON.parse(env.body).url, `the url ${envHost} saw`).toContain(envHost);

      /* Rule 3: any other single label answers from the application itself. */
      const other = await untilServes(otherHost, "v2");
      expect(JSON.parse(other.body).url, `the url ${otherHost} saw`).toContain(otherHost);

      /* The routing document names exactly the base and its environment, which
         is all an ingress approves a certificate for: an arbitrary subdomain is
         covered only by the `*.` entry, which routes and never approves, and a
         name two labels under the base is not covered at all. */
      const routing = await fleetRouting();
      const hosts = routing.routes.map((route) => route.host);
      expect(hosts).toContain(CUSTOM_HOST);
      expect(hosts).toContain(envHost);
      expect(hosts).toContain(`*.${CUSTOM_HOST}`);
      expect(hosts).not.toContain(otherHost);
      expect(hosts).not.toContain(`a.b.${CUSTOM_HOST}`);
      expect(routing.wildcards).toContain(CUSTOM_HOST);

      const listed = await runCli(
        ["app", "domain", "list", "--name", APPLICATION, "--json", ...nodeFlags],
        {},
      );
      expectCleanExit(listed);
      expect(JSON.parse(listed.output)).toEqual({
        application: APPLICATION,
        domains: [CUSTOM_HOST],
        wildcardDomains: [CUSTOM_HOST],
      });

      const removed = await runCli(
        ["app", "domain", "remove", CUSTOM_HOST, "--name", APPLICATION, ...nodeFlags],
        {},
      );
      observed.domainRemoveOutput = removed.output;
      expectCleanExit(removed);

      for (const host of [CUSTOM_HOST, envHost, otherHost]) {
        const gone = await until(`${host} to stop being served`, DEADLINE_MS, async () => {
          const got = await httpGet(caddyHttpPort, "/", { host });
          return got.status === 404 ? got : null;
        });
        expect(gone.body, host).toBe(NO_ROUTE);
      }
      const released = (await fleetRouting()).routes.map((route) => route.host);
      expect(released).not.toContain(CUSTOM_HOST);
      expect(released).not.toContain(`*.${CUSTOM_HOST}`);

      /* The application keeps the host it was always served at. */
      expect(JSON.parse((await untilServes(appHost(), "v2")).body).version).toBe("v2");
      observed.customDomain = { host: CUSTOM_HOST, servedThenReleased: true };
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

/** The fleet's routing document, as the node serves it to its ingress. */
async function fleetRouting(): Promise<FleetRouting> {
  const answer = await httpGet(apiPort, "/v1/ingress/routes", {
    authorization: `Bearer ${INGRESS_TOKEN}`,
  });
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as FleetRouting;
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
