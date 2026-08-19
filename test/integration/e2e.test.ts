/*
 * The whole single-node product loop against real infrastructure: a SeaweedFS
 * bucket holding the registry, a Caddy the agent drives through its admin API,
 * celld running the builds, and the built `scalo` CLI driving all of it from the
 * host the way an operator would.
 *
 * The topology mirrors one real VPS. Caddy and the agent SHARE a network
 * namespace, which is what makes the loopback contract real: the runtime
 * processes only ever listen on 127.0.0.1, Caddy dials them there, and the agent
 * reaches Caddy's admin API on the same loopback. The store is a separate
 * container, reached over a docker network by its address on it — so the agent
 * uses the container-internal endpoint while the test process, on the host, uses
 * the published one.
 *
 * What is not about the topology — the images and deadlines, the bucket, the
 * staged fixture application, requests that can set a `Host` header, the built
 * CLI, the poll — lives in `_harness.ts` and is shared with the Traefik suite,
 * which mirrors this one with the other ingress in Caddy's place. What stays
 * here is what this suite is: its containers, and what it asserts about them.
 *
 * Skipped unless SCALO_E2E=1, because it is minutes rather than seconds:
 *
 *   SCALO_E2E=1 pnpm vitest run test/integration/e2e.test.ts
 *
 * Every HTTP assertion polls until a deadline, because a change only reaches
 * Caddy after the reconcile pass that observes it. Any timeout dumps the agent
 * container's logs into the failure — they are the only account of what the node
 * was doing.
 *
 * The Caddy fixture puts its admin API on `0.0.0.0:2019` so the host can read it
 * too, and therefore has to name the origins it accepts: Caddy only allows a
 * loopback admin's own origin implicitly, and the driver presents one on every
 * call. An operator exposing the admin API beyond loopback owes Caddy the same
 * setting.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentState } from "../../src/agent/app.ts";
import type { OperatorKeyFile } from "../../src/cli/commands/keygen.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  getEnvironment,
  listBuilds,
  readJson,
  readMeta,
  type RegistryContext,
  nodeKey,
  trustKey,
} from "../../src/core/registry/index.ts";
import type { NodeRecord, TrustPolicy } from "../../src/core/types/registry.ts";
import {
  AGENT_IMAGE,
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  type BucketSettings,
  buildIdOf,
  buildRepo,
  type CommandResult,
  DEADLINE_MS,
  FIXTURES,
  type HttpAnswer,
  httpGet,
  httpPost,
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

const E2E = process.env.SCALO_E2E === "1";

const CADDY_IMAGE = "caddy:2";

const CADDY_HTTP_PORT = 80;
const CADDY_ADMIN_PORT = 2019;
/** Published on the Caddy container, because the agent shares its namespace. */
const AGENT_PORT = 7400;

const BUCKET = "scalo-e2e";
const KEY_PREFIX = "e2e";
const ACCESS_KEY = "scalo";
const SECRET_KEY = "scalo-secret";
const REGION = "us-east-1";

/** The same four settings the harness starts the store and the CLI with. */
const BUCKET_SETTINGS: BucketSettings = {
  bucket: BUCKET,
  prefix: KEY_PREFIX,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
  region: REGION,
};

const PLATFORM_DOMAIN = "scalo.test";
const OPERATOR_HOST = "operator.test";
const PROJECT = "app";
const ENVIRONMENT = "production";
const NODE_ID = "node-e2e";

/** Environment the CI-shaped deploy creates; it exists nowhere until then. */
const CI_ENVIRONMENT = "ci";
/** The subject pattern the project's policy trusts, as an operator would write it. */
const WORKLOAD_GLOB = "repo:acme/shop:ref:refs/heads/*";
/** A workload the glob above admits. */
const WORKLOAD_SUBJECT = "repo:acme/shop:ref:refs/heads/main";
/** A workload of a repository nothing in the policy names. */
const HOSTILE_SUBJECT = "repo:evil/other:ref:refs/heads/main";

let store: StartedStore;
let caddy: StartedTestContainer;
let agent: StartedTestContainer;
/** Stands in for a CI provider; the agent reaches it over the bridge by URL. */
let issuer: StubIssuer;

/** Endpoints of the one bucket, as the host and as the containers reach it. */
let storeFromHost: string;
let storeFromContainers: string;

let caddyHttpPort: number;
let caddyAdminPort: number;
let agentPort: number;

let registry: RegistryContext;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let buildV1: string;
let buildV2: string;
let buildCi: string;

const tmpDirs: string[] = [];
/** Everything the agent container has written, kept for failure messages. */
const agentLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the single-node product loop, end to end", () => {
  beforeAll(async () => {
    /* Built first: the agent container runs `dist/` off the bind-mounted
       worktree, so a stale build would test the previous commit. */
    await buildRepo();

    store = await startStore(BUCKET_SETTINGS);
    storeFromHost = store.fromHost;
    storeFromContainers = store.fromContainers;

    caddy = await new GenericContainer(CADDY_IMAGE)
      .withCopyFilesToContainer([
        { source: join(FIXTURES, "caddy.json"), target: "/etc/caddy/config.json" },
      ])
      .withCommand(["caddy", "run", "--config", "/etc/caddy/config.json"])
      /* The agent's own port is published here: it has no network of its own. */
      .withExposedPorts(CADDY_HTTP_PORT, CADDY_ADMIN_PORT, AGENT_PORT)
      /* Waiting on the admin API rather than on every published port: nothing
         listens on the agent's until the agent itself starts. */
      .withWaitStrategy(
        Wait.forHttp(`/config/apps/http/servers/scalo/routes`, CADDY_ADMIN_PORT).forStatusCode(200),
      )
      .start();

    caddyHttpPort = caddy.getMappedPort(CADDY_HTTP_PORT);
    caddyAdminPort = caddy.getMappedPort(CADDY_ADMIN_PORT);
    agentPort = caddy.getMappedPort(AGENT_PORT);

    agent = await new GenericContainer(AGENT_IMAGE)
      /* The whole point of the topology: Caddy's `127.0.0.1:<port>` upstream
         dials reach the celld processes, and the agent reaches Caddy's admin. */
      .withNetworkMode(`container:${caddy.getId()}`)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
      .withWorkingDir("/work")
      .withEnvironment({
        SCALO_S3_ENDPOINT: storeFromContainers,
        SCALO_S3_BUCKET: BUCKET,
        SCALO_S3_PREFIX: KEY_PREFIX,
        SCALO_S3_ACCESS_KEY: ACCESS_KEY,
        SCALO_S3_SECRET_KEY: SECRET_KEY,
        SCALO_S3_REGION: REGION,
        SCALO_NODE_ID: NODE_ID,
        /* The listener below binds every interface, which the agent refuses
           without being told what network that is. Inside a container of its
           own, on a private docker network, it is the trusted-network case. */
        SCALO_TRANSPORT: "none",
        /* Container-local, and explicitly so: the working directory is this
           repository bind-mounted at /work, and the node's identity must not be
           written into a checkout. */
        SCALO_STATE_DIR: "/var/lib/scalo",
        SCALO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCALO_CADDY_ADMIN: `http://127.0.0.1:${String(CADDY_ADMIN_PORT)}`,
        /* Peers reach a single node on loopback; without this the advertised
           host would be the wildcard the listener binds. */
        SCALO_ADVERTISE: `127.0.0.1:${String(AGENT_PORT)}`,
        /* Belt and braces: the image's own esbuild, rather than whichever one
           the bind-mounted node_modules resolves to. */
        ESBUILD_BINARY_PATH: "/usr/local/bin/esbuild",
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "up",
        "--listen",
        `0.0.0.0:${String(AGENT_PORT)}`,
      ])
      /* Consumed from the first byte, so the logs survive even a start that
         never satisfies the wait strategy. */
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => agentLog.push(String(chunk)));
        stream.on("err", (chunk) => agentLog.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    registry = registryAt(storeFromHost, BUCKET_SETTINGS);

    /* Its own container on the same bridge, so the agent runs the real discovery
       and key-set requests against a URL it was handed in a token. */
    issuer = await startStubIssuer({
      network: BRIDGE_NETWORK,
      startupTimeoutMs: BOOT_DEADLINE_MS,
    });
    observed.issuer = issuer.iss;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /* Stopped before Caddy: the agent lives in Caddy's network namespace. */
    await agent?.stop().catch(() => {});
    await caddy?.stop().catch(() => {});
    await issuer?.stop();
    await store?.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "answers its health endpoint and has bootstrapped the registry in the bucket",
    async () => {
      const health = await until("the agent to answer /v1/health", BOOT_DEADLINE_MS, async () => {
        const answer = await httpGet(agentPort, "/v1/health", {});
        return answer.status === 200 ? answer : null;
      });
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });

      const meta = await readMeta(registry);
      expect(meta, "the registry the first node bootstraps").not.toBeNull();
      expect(meta?.platformDomains).toEqual([PLATFORM_DOMAIN]);

      const node = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(node?.value.addresses).toMatchObject({ agentPort: AGENT_PORT });
      observed.health = JSON.parse(health.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "registers an operator key whose public half lands in the registry",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scalo-e2e-key-"));
      tmpDirs.push(dir);
      keyPath = join(dir, "operator.json");

      const result = await runCli(["keygen", "--out", keyPath, "--register"], storeEnv());
      expectCleanExit(result);

      operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
      const record = await readJson<NodeRecord>(registry, nodeKey(operatorKey.id));
      expect(record?.value.publicKey.x).toBe(operatorKey.publicKey.x);
      observed.operatorId = operatorKey.id;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys the first build, flips the alias to it and reports it routed",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await stageApp("v1")), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, agentLogTail()).toContain("routed");

      buildV1 = buildIdOf(result.output);
      expect(await listBuilds(registry, PROJECT)).toContain(buildV1);
      observed.buildV1 = buildV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the first build through Caddy on the environment host, the apex and the build host",
    async () => {
      for (const host of [envHost(), apexHost(), buildHost(buildV1)]) {
        const answer = await untilServes(host, "v1");
        expect(JSON.parse(answer.body).url, `the url ${host} saw`).toContain(host);
      }
      observed.v1Hosts = [envHost(), apexHost(), buildHost(buildV1)];
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "leaves the route the operator authored in Caddy untouched",
    async () => {
      const answer = await httpGet(caddyHttpPort, "/", { host: OPERATOR_HOST });
      expect(answer.status).toBe(200);
      expect(answer.body).toBe("operator");

      const routes = await caddyRoutes();
      expect(routes.map((route) => route["@id"])).toContain("operator_authored");
      observed.caddyRouteIds = routes.map((route) => route["@id"]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "tells an ingress it serves a platform host and refuses one nothing claimed",
    async () => {
      const served = await httpGet(agentPort, `/v1/ingress/ask?domain=${envHost()}`, {});
      expect(served.status).toBe(200);

      const unknown = await httpGet(agentPort, "/v1/ingress/ask?domain=unclaimed.example.com", {});
      expect(unknown.status).toBe(404);
      observed.ask = { served: served.status, unknown: unknown.status };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "flips to a second build, and withdraws the superseded build's host once its process is stopped",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await stageApp("v2")), {});
      observed.deployV2Ms = Date.now() - started;
      observed.deployV2Output = result.output;

      expectCleanExit(result);
      expect(result.output, agentLogTail()).toContain("routed");
      buildV2 = buildIdOf(result.output);
      expect(buildV2).not.toBe(buildV1);
      observed.buildV2 = buildV2;

      /*
       * Recorded, not asserted. The planner only stops the superseded process on
       * the pass AFTER the replacement passes its gate, so whether the old build
       * host still answers here depends on where in the 5s interval the deploy
       * settled — a race no assertion should depend on.
       */
      observed.v1BuildHostRightAfterFlip = await httpGet(caddyHttpPort, "/", {
        host: buildHost(buildV1),
      });

      await untilServes(envHost(), "v2");
      await untilServes(apexHost(), "v2");
      await untilServes(buildHost(buildV2), "v2");

      /* What the implementation actually does: the stop is planned once v2 is
         ready, the route goes with the process, and Caddy is left with no match
         for the old build host. */
      const withdrawn = await until(
        `${buildHost(buildV1)} to stop being routed`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(caddyHttpPort, "/", { host: buildHost(buildV1) });
          return answer.body.includes(`"v1"`) ? null : answer;
        },
      );
      observed.v1BuildHostAfterReconcile = withdrawn;

      const routes = await caddyRoutes();
      expect(routes.map((route) => route["@id"])).not.toContain(`scalo_${buildHost(buildV1)}`);
      expect(routes.map((route) => route["@id"])).toContain("operator_authored");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "rolls the environment back to the first build, and serves it on the apex again",
    async () => {
      const answer = await httpPost(
        agentPort,
        "/v1/aliases",
        { project: PROJECT, environment: ENVIRONMENT, rollback: true },
        await operatorToken(),
      );
      expectStatus(answer, 200);
      expect(JSON.parse(answer.body).environment.alias).toMatchObject({ build: buildV1 });

      const started = Date.now();
      await untilServes(apexHost(), "v1");
      await untilServes(envHost(), "v1");
      observed.rollbackMs = Date.now() - started;

      const record = await getEnvironment(registry, PROJECT, ENVIRONMENT);
      expect(record.alias).toMatchObject({ build: buildV1, previous: buildV2 });
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "settles on exactly one running process, serving the build the alias points at",
    async () => {
      const state = await until(
        "the node to report a single running process",
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(agentPort, "/v1/state", {
            authorization: `Bearer ${await operatorToken()}`,
          });
          if (answer.status !== 200) return null;

          const body = JSON.parse(answer.body) as AgentState;
          const running = body.processes.filter((process) => process.state === "running");
          return running.length === 1 ? body : null;
        },
      );

      const running = state.processes.filter((process) => process.state === "running");
      expect(running[0].id).toBe(`${PROJECT}--${ENVIRONMENT}--${buildV1}`);
      expect(state.node?.id).toBe(NODE_ID);
      expect(state.reconcile?.failures ?? []).toEqual([]);
      observed.finalProcesses = state.processes;
      observed.finalReconcile = state.reconcile;
    },
    STEP_TIMEOUT_MS,
  );

  /*
   * From here on the caller is a CI job, not an operator. Everything above ran
   * with an operator key on disk and, for the registry-facing commands, the
   * bucket's credentials in the environment; a CI job has neither, and the
   * assertions below are worth nothing unless it keeps not having them.
   */

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
          "scalo",
          "--subject",
          WORKLOAD_GLOB,
        ],
        storeEnv(),
      );
      expectCleanExit(result);

      const policy = await readJson<TrustPolicy>(registry, trustKey(PROJECT));
      expect(policy?.value.issuers).toEqual([
        { iss: issuer.iss, aud: "scalo", subjects: [WORKLOAD_GLOB] },
      ]);

      /* And an operator can read back what they set, glob intact — the pattern
         is the thing being checked, so it is printed verbatim. */
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

      /*
       * The claim this whole step exists to make. The CI side holds ONE secret,
       * the token it was minted, and it is short-lived and scoped to a subject:
       * no operator key file is named, and the bucket's credentials are not in
       * the environment the command runs with. If either leaked in, this deploy
       * would still pass while proving nothing.
       */
      expect(args).not.toContain("--key");
      const ciEnv: Record<string, string> = {};
      expect(Object.keys(ciEnv).filter((name) => name.startsWith("SCALO_"))).toEqual([]);

      const started = Date.now();
      const result = await runCli(args, ciEnv);
      observed.workloadDeployMs = Date.now() - started;
      observed.workloadDeployOutput = result.output;

      expectCleanExit(result);
      /* Accepted (202), then carried the whole way: build, flip, and a process
         through its readiness gate. Every poll re-presented the same token,
         which a workload token — unlike a node token — survives. */
      expect(result.output, agentLogTail()).toContain("routed");

      buildCi = buildIdOf(result.output);
      expect(await listBuilds(registry, PROJECT)).toContain(buildCi);
      observed.workloadBuild = buildCi;
      observed.workloadSubject = WORKLOAD_SUBJECT;

      const answer = await untilServes(ciHost(), "v3");
      expect(JSON.parse(answer.body).url).toContain(ciHost());

      /* The environment the CI job named did not exist before this deploy. */
      const environment = await getEnvironment(registry, PROJECT, CI_ENVIRONMENT);
      expect(environment.alias).toMatchObject({ build: buildCi });

      /* And production is untouched: a token scoped to one project deploying a
         new environment of it must not disturb what was already running. */
      await untilServes(apexHost(), "v1");
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
      /*
       * Distinguishable on purpose, and the only rejection that is: the token
       * held up as authentication and the project simply does not admit it,
       * which is authorization and something the caller must be able to act on.
       */
      expect(result.output).toContain("urn:scalo:trust-mismatch");
      expect(result.output).toContain(HOSTILE_SUBJECT);

      /* Nothing was built and the alias did not move. */
      const environment = await getEnvironment(registry, PROJECT, CI_ENVIRONMENT);
      expect(environment.alias).toMatchObject({ build: buildCi });
      await untilServes(ciHost(), "v3");
    },
    STEP_TIMEOUT_MS,
  );
});

/* ------------------------------------------------------------------ helpers */

function envHost(): string {
  return `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`;
}

function apexHost(): string {
  return `${PROJECT}.${PLATFORM_DOMAIN}`;
}

function buildHost(build: string): string {
  return `${PROJECT}--${build}.${PLATFORM_DOMAIN}`;
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
    "--agent",
    `http://127.0.0.1:${String(agentPort)}`,
    "--project",
    PROJECT,
    "--env",
    environment,
    "--flip",
    "--runtime-configurable",
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

/** The routes Caddy currently holds in the server the node writes into. */
async function caddyRoutes(): Promise<Array<Record<string, unknown>>> {
  const answer = await httpGet(caddyAdminPort, "/config/apps/http/servers/scalo/routes", {});
  expect(answer.status, `the Caddy admin API answered ${answer.body}`).toBe(200);

  const body: unknown = JSON.parse(answer.body);
  return Array.isArray(body) ? (body as Array<Record<string, unknown>>) : [];
}

/**
 * Polls until `probe` returns a value. A deadline that runs out fails with the
 * agent container's logs attached, because nothing else says what the node did.
 */
function until<T>(what: string, deadlineMs: number, probe: () => Promise<T | null>): Promise<T> {
  return untilPolled(what, deadlineMs, probe, { context: agentLogTail });
}

/**
 * Fails with everything the command printed, and with what the node was doing
 * while it ran: a CLI that exits non-zero has already reported why, and the
 * reason is almost always on the other side of the request it made.
 */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${agentLogTail()}`).toBe(0);
}

/** Fails with the answer's body, which is where a problem document explains itself. */
function expectStatus(answer: HttpAnswer, status: number): void {
  expect(answer.status, answer.body).toBe(status);
}

/** The tail of the agent container's output, as a failure message carries it. */
function agentLogTail(limit: number = 12_000): string {
  const text = agentLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- agent container logs ---\n${tail}\n--- end agent container logs ---`;
}
