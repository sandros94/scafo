/*
 * End-to-end single-node Caddy deployment path. Caddy and daemon share a network
 * namespace; runtimes bind loopback.
 *
 * CADDY PULLS. Nothing here is written into Caddy: the fixture config names the
 * `scafo` dynamic-upstreams module, and Caddy asks the node where each host lives
 * every second. So an assertion after a deploy is a poll, not a one-shot — the
 * routing document has to be fetched before the new host resolves.
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
  getEnvironment,
  listDeployments,
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
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  type BucketSettings,
  buildRepo,
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
const PROJECT = "app";
const ENVIRONMENT = "production";
const NODE_ID = "node-e2e";

/** Environment the CI-shaped deploy creates; it exists nowhere until then. */
const CI_ENVIRONMENT = "ci";
/** Environment the `--var` deploy creates, so nothing else is disturbed by it. */
const VARS_ENVIRONMENT = "vars";
/** Environment the already-bundled artifact is published into, with no flag. */
const PREBUNDLED_ENVIRONMENT = "prebundled";
/** The subject pattern the project's policy trusts, as an operator would write it. */
const WORKLOAD_GLOB = "repo:acme/shop:ref:refs/heads/*";
/** A workload the glob above admits. */
const WORKLOAD_SUBJECT = "repo:acme/shop:ref:refs/heads/main";
/** A workload of a repository nothing in the policy names. */
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
    await buildRepo();

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
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
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
    "deploys the first version and reports it deployed",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await stageApp("v1")), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      versionV1 = deploymentOf(result.output);
      expect(await listDeployments(registry, PROJECT)).toContain(versionV1);
      observed.versionV1 = versionV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the first deployment through Caddy on the environment host and apex",
    async () => {
      for (const host of [envHost(), apexHost()]) {
        const answer = await untilServes(host, "v1");
        expect(JSON.parse(answer.body).url, `the url ${host} saw`).toContain(host);
      }
      const runtimeHealth = await until(
        `${envHost()} to answer celld health`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(caddyHttpPort, "/.well-known/celld/health", {
            host: envHost(),
          });
          return answer.status === 200 && answer.body === '{"ok":true}' ? answer : null;
        },
      );
      expect(JSON.parse(runtimeHealth.body)).toEqual({ ok: true });
      observed.v1Hosts = [envHost(), apexHost()];
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

      const app = await httpGet(caddyHttpPort, "/", { host: apexHost() });
      expect(app.status).toBe(200);
      expect(app.body).toContain(`"v1"`);

      const ask = await httpGet(apiPort, `/v1/ingress/ask?domain=${PLATFORM_DOMAIN}`, {});
      expect(ask.status).toBe(200);
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
      const served = await httpGet(apiPort, `/v1/ingress/ask?domain=${envHost()}`, {});
      expect(served.status).toBe(200);

      const unknown = await httpGet(apiPort, "/v1/ingress/ask?domain=unclaimed.example.com", {});
      expect(unknown.status).toBe(404);
      observed.ask = { served: served.status, unknown: unknown.status };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys a second version for the existing environment",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await stageApp("v2")), {});
      observed.deployV2Ms = Date.now() - started;
      observed.deployV2Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      versionV2 = deploymentOf(result.output);
      expect(versionV2).not.toBe(versionV1);
      observed.versionV2 = versionV2;

      await untilServes(envHost(), "v2");
      await untilServes(apexHost(), "v2");

      const operator = await httpGet(caddyHttpPort, "/", { host: OPERATOR_HOST });
      expect(operator.body, "the operator's own route outlives a deploy").toBe("operator");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "settles on exactly one environment-owned runtime process",
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
      expect(running[0].id).toBe(`${PROJECT}--${ENVIRONMENT}`);
      expect(state.node?.id).toBe(NODE_ID);
      expect(state.reconcile?.failures ?? []).toEqual([]);
      observed.finalProcesses = state.processes;
      observed.finalReconcile = state.reconcile;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "records the trust policy that lets a CI job deploy without a key of ours",
    async () => {
      const result = await runCli(
        [
          "trust",
          "set",
          "--project",
          PROJECT,
          "--issuer",
          issuer.iss,
          "--audience",
          "scafo",
          "--subject",
          WORKLOAD_GLOB,
        ],
        storeEnv(),
      );
      expectCleanExit(result);

      const policy = await readJson<TrustPolicy>(registry, trustKey(PROJECT));
      expect(policy?.value.issuers).toEqual([
        { iss: issuer.iss, aud: "scafo", subjects: [WORKLOAD_GLOB] },
      ]);

      const shown = await runCli(["trust", "show", "--project", PROJECT], storeEnv());
      expectCleanExit(shown);
      expect(shown.output).toContain(WORKLOAD_GLOB);
      expect(shown.output).toContain(issuer.iss);
      observed.trustPolicy = policy?.value;
      observed.trustShowOutput = shown.output;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys a new environment with nothing but a workload token, and serves it",
    async () => {
      const token = await issuer.mint({ sub: WORKLOAD_SUBJECT });
      const args = [...deployArgs(await stageApp("v3"), CI_ENVIRONMENT), "--token", token];

      expect(args).not.toContain("--key");
      const ciEnv: Record<string, string> = {};
      expect(Object.keys(ciEnv).filter((name) => name.startsWith("SCAFO_"))).toEqual([]);

      const started = Date.now();
      const result = await runCli(args, ciEnv);
      observed.workloadDeployMs = Date.now() - started;
      observed.workloadDeployOutput = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      versionCi = deploymentOf(result.output);
      expect(await listDeployments(registry, PROJECT)).toContain(versionCi);
      observed.workloadDeployment = versionCi;
      observed.workloadSubject = WORKLOAD_SUBJECT;

      const answer = await untilServes(ciHost(), "v3");
      expect(JSON.parse(answer.body).url).toContain(ciHost());

      const environment = await getEnvironment(registry, PROJECT, CI_ENVIRONMENT);
      expect(environment.deployment).toMatchObject({ revision: 1 });

      await untilServes(apexHost(), "v2");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "lets --var override the config's own variable and leaves the others as written",
    async () => {
      const result = await runCli(
        [
          ...deployArgs(await stageApp("v5"), VARS_ENVIRONMENT),
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

      const host = `${PROJECT}--${VARS_ENVIRONMENT}.${PLATFORM_DOMAIN}`;
      const answer = await untilServes(host, "v5");
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

      const args = [...deployArgs(dir, PREBUNDLED_ENVIRONMENT), "--key", keyPath];
      expect(args).not.toContain("--no-bundle");
      expect(args).not.toContain("--var");

      const result = await runCli(args, {});
      observed.prebundledDeployOutput = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      const host = `${PROJECT}--${PREBUNDLED_ENVIRONMENT}.${PLATFORM_DOMAIN}`;
      const answer = await untilServes(host, "prebundled");
      expect(JSON.parse(answer.body).url).toContain(host);
      observed.prebundled = JSON.parse(answer.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "refuses a token from a repository the policy does not name, and says which failure it was",
    async () => {
      const token = await issuer.mint({ sub: HOSTILE_SUBJECT });
      const result = await runCli(
        [...deployArgs(await stageApp("v4"), CI_ENVIRONMENT), "--token", token],
        {},
      );

      observed.hostileDeployOutput = result.output;
      observed.hostileDeployCode = result.code;

      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("urn:scafo:trust-mismatch");
      expect(result.output).toContain(HOSTILE_SUBJECT);

      const environment = await getEnvironment(registry, PROJECT, CI_ENVIRONMENT);
      expect(environment.deployment).toMatchObject({ revision: 1 });
      await untilServes(ciHost(), "v3");
    },
    STEP_TIMEOUT_MS,
  );
});

function envHost(): string {
  return `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`;
}

function apexHost(): string {
  return `${PROJECT}.${PLATFORM_DOMAIN}`;
}

function ciHost(): string {
  return `${PROJECT}--${CI_ENVIRONMENT}.${PLATFORM_DOMAIN}`;
}

/**
 * The flags one deploy of the fixture is run with, from the host.
 *
 * The operator key is named only for the environment the operator owns. A caller
 * deploying another environment appends its own `--token` instead, and the
 * absence of `--key` here is what makes that a real workload deploy.
 */
function deployArgs(dir: string, environment: string = ENVIRONMENT): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(apiPort)}`,
    "--project",
    PROJECT,
    "--env",
    environment,
    ...(environment === ENVIRONMENT ? ["--key", keyPath] : []),
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
