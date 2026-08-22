/*
 * The whole single-node product loop against real infrastructure: a SeaweedFS
 * bucket holding the registry, a Caddy the agent drives through its admin API,
 * celld running the builds, and the built `scafo` CLI driving all of it from the
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
 * Skipped unless SCAFO_E2E=1, because it is minutes rather than seconds:
 *
 *   SCAFO_E2E=1 pnpm vitest run test/integration/e2e.test.ts
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
import type { ProcessStatus } from "../../src/core/types/supervisor.ts";
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
  sampleVersions,
  SETUP_TIMEOUT_MS,
  SPLIT_MIN_REQUESTS,
  SPLIT_SAMPLE,
  stageApp as stageAppIn,
  type StartedStore,
  startStore,
  STEP_TIMEOUT_MS,
  storeEnv as storeEnvFor,
  until as untilPolled,
} from "./_harness.ts";
import { startStubIssuer, type StubIssuer } from "./_stub-issuer.ts";

const E2E = process.env.SCAFO_E2E === "1";

const CADDY_IMAGE = "caddy:2";

const CADDY_HTTP_PORT = 80;
const CADDY_ADMIN_PORT = 2019;
/** Published on the Caddy container, because the agent shares its namespace. */
const AGENT_PORT = 7400;

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
/** The build eased in with `scafo deploy --canary`, beside the alias. */
let buildCanary: string;

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
        Wait.forHttp(`/config/apps/http/servers/scafo/routes`, CADDY_ADMIN_PORT).forStatusCode(200),
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
        SCAFO_S3_ENDPOINT: storeFromContainers,
        SCAFO_S3_BUCKET: BUCKET,
        SCAFO_S3_PREFIX: KEY_PREFIX,
        SCAFO_S3_ACCESS_KEY: ACCESS_KEY,
        SCAFO_S3_SECRET_KEY: SECRET_KEY,
        SCAFO_S3_REGION: REGION,
        SCAFO_NODE_ID: NODE_ID,
        /* The listener below binds every interface, which the agent refuses
           without being told what network that is. Inside a container of its
           own, on a private docker network, it is the trusted-network case. */
        SCAFO_TRANSPORT: "none",
        /* Container-local, and explicitly so: the working directory is this
           repository bind-mounted at /work, and the node's identity must not be
           written into a checkout. */
        SCAFO_STATE_DIR: "/var/lib/scafo",
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_CADDY_ADMIN: `http://127.0.0.1:${String(CADDY_ADMIN_PORT)}`,
        /* Peers reach a single node on loopback; without this the advertised
           host would be the wildcard the listener binds. */
        SCAFO_ADVERTISE: `127.0.0.1:${String(AGENT_PORT)}`,
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
      const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-key-"));
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
    "answers the fleet's API at the platform domain's own apex, through Caddy",
    async () => {
      /*
       * THE APEX IS THE FLEET'S FRONT DOOR. `*.scafo.test` is one label and
       * never `scafo.test` itself, so nothing served this name before: the node
       * routes it to its own agent, and any node of the fleet answers any call
       * there because the registry is in the bucket.
       */
      const health = await until(
        `${PLATFORM_DOMAIN} to answer the agent's health through Caddy`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(caddyHttpPort, "/v1/health", { host: PLATFORM_DOMAIN });
          return answer.status === 200 ? answer : null;
        },
      );
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });
      observed.apexHealth = JSON.parse(health.body);

      /* And it is the API rather than the wake surface: a path the API does not
         have is the API's own miss, not "nothing is served at this host". */
      const missing = await httpGet(caddyHttpPort, "/v1/nope", { host: PLATFORM_DOMAIN });
      expect(missing.status).toBe(404);
      expect(missing.body).not.toContain("urn:scafo:not-found");

      /* The apex takes nothing away from the applications under it. */
      const app = await httpGet(caddyHttpPort, "/", { host: apexHost() });
      expect(app.status).toBe(200);
      expect(app.body).toContain(`"v1"`);

      /* THE CERTIFICATE PATH: the wildcard does not cover this name, so the
         on-demand ask is the only thing that can mint it one — and it says yes,
         with no environment, no claim and no process behind it. */
      const ask = await httpGet(agentPort, `/v1/ingress/ask?domain=${PLATFORM_DOMAIN}`, {});
      expect(ask.status).toBe(200);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "NEVER reaches /v1/storage or the pull-provider route through that apex",
    async () => {
      /*
       * THE ONE NON-NEGOTIABLE RULE OF THIS SURFACE, asserted where it is
       * enforced. `/v1/storage` carries the certificates, the ACME account key
       * and the issuance locks a colocated ingress persists through this node,
       * behind a shared token; `/v1/ingress/traefik` is the node's whole routing
       * map. Both are for a caller on this machine, and the exclusion is CADDY'S
       * — the agent behind it is never asked.
       */
      for (const path of [
        "/v1/storage",
        "/v1/storage/list?prefix=",
        "/v1/storage/objects/anything",
        "/v1/ingress/traefik",
      ]) {
        const blocked = await httpGet(caddyHttpPort, path, { host: PLATFORM_DOMAIN });

        expect(blocked.status, `${path} through the apex`).toBe(404);
        /* The ingress's own denial: no problem document, no header the agent
           puts on its answers, and therefore nothing that reached it. */
        expect(blocked.body, `${path} through the apex`).not.toContain("urn:scafo:");
        expect(blocked.body, `${path} through the apex`).toBe("");
      }
      observed.apexDenied = ["/v1/storage", "/v1/ingress/traefik"];

      /* The surface itself is untouched and still answers a local caller — on
         the node's own listener, which is where it is meant to be reached. */
      const local = await httpGet(agentPort, "/v1/storage/list?prefix=", {});
      expect(local.status).toBe(401);
      expect(local.body).toContain("urn:scafo:");
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

      await untilServes(envHost(), "v2");
      await untilServes(apexHost(), "v2");
      await untilServes(buildHost(buildV2), "v2");

      /*
       * The withdrawal is watched through the ADMIN API and never by requesting
       * the host: a request for a superseded build's host is a WAKE now — it
       * would restart the very process this test is waiting to see stopped, and
       * the poll would hold its own condition false until the deadline. The one
       * deliberate wake of a superseded build is the last test of this suite.
       */
      await until(`${buildHost(buildV1)} to stop being routed`, DEADLINE_MS, async () => {
        const routes = await caddyRoutes();
        return routes.some((route) => route["@id"] === `scafo_${buildHost(buildV1)}`)
          ? null
          : routes;
      });

      const routes = await caddyRoutes();
      expect(routes.map((route) => route["@id"])).toContain("operator_authored");
      /* Withdrawn from its own route, but not into nothing: the catch-all that
         hands unmatched platform hosts to the agent is what answers for it now. */
      expect(routes.map((route) => route["@id"])).toContain(`scafo_catchall_${PLATFORM_DOMAIN}`);
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
      expect(Object.keys(ciEnv).filter((name) => name.startsWith("SCAFO_"))).toEqual([]);

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
      expect(result.output).toContain("urn:scafo:trust-mismatch");
      expect(result.output).toContain(HOSTILE_SUBJECT);

      /* Nothing was built and the alias did not move. */
      const environment = await getEnvironment(registry, PROJECT, CI_ENVIRONMENT);
      expect(environment.alias).toMatchObject({ build: buildCi });
      await untilServes(ciHost(), "v3");
    },
    STEP_TIMEOUT_MS,
  );

  /*
   * Weighted traffic, from here to the end. Production is at v1 with one process
   * running it, which is the state a canary is actually eased into: a build that
   * has been serving for a while, and a new one nobody has sent traffic to yet.
   */

  it(
    "eases a canary in without flipping, and Caddy divides the traffic between both builds",
    async () => {
      const started = Date.now();
      const result = await runCli(canaryArgs(await stageApp("v5"), 50), {});
      observed.canaryDeployMs = Date.now() - started;
      observed.canaryDeployOutput = result.output;

      expectCleanExit(result);
      /* Deployed WITHOUT a flip, then weighed against whatever the alias points
         at — which the node reads for itself, so the CLI never has to know. */
      expect(result.output, agentLogTail()).toContain("splits its traffic");
      buildCanary = buildIdOf(result.output);
      expect(buildCanary).not.toBe(buildV1);
      observed.buildCanary = buildCanary;

      const environment = await getEnvironment(registry, PROJECT, ENVIRONMENT);
      expect(environment.split).toEqual([
        { build: buildV1, weight: 50 },
        { build: buildCanary, weight: 50 },
      ]);
      /* The alias has NOT moved: it is still the primary pointer and still what
         a rollback goes back to. */
      expect(environment.alias).toMatchObject({ build: buildV1 });

      /*
       * THE ASSERTION THIS WHOLE SLICE EXISTS FOR. Two builds of one environment
       * answering on one host — which means the node activated and started each
       * of them in its own paired step. Batched activations would have started
       * both processes on the last-activated version, and every one of these
       * forty requests would have come back "v5".
       */
      const reached = await until(
        `${apexHost()} to answer with both builds`,
        DEADLINE_MS,
        async () => {
          const counted = await sampleVersions(caddyHttpPort, apexHost(), SPLIT_SAMPLE);
          return counted.v1 !== undefined && counted.v5 !== undefined ? counted : null;
        },
      );
      observed.canaryReachedSample = reached;

      /* Measured again on a settled routing: the sample above may have started
         before the canary's route was in place, and a window that straddles the
         change is a measurement of the change rather than of the split. */
      const seen = await sampleVersions(caddyHttpPort, apexHost(), SPLIT_SAMPLE);
      observed.canarySample = seen;

      for (const version of ["v1", "v5"]) {
        expect(seen[version], `${version} of ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(
          SPLIT_MIN_REQUESTS,
        );
      }
      /* Nothing but the two legs answered: no 502 from a leg the routing named
         before it was ready, and no third build. */
      expect(Object.keys(seen).sort()).toEqual(["v1", "v5"]);

      /* And each leg is still addressable on its own, unweighted. */
      for (const [build, version] of [
        [buildV1, "v1"],
        [buildCanary, "v5"],
      ]) {
        const answer = await untilServes(buildHost(build), version);
        expect(JSON.parse(answer.body).version).toBe(version);
      }
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "promotes the canary with a flip, which clears the split and retires the leg that lost",
    async () => {
      const answer = await httpPost(
        agentPort,
        "/v1/aliases",
        { project: PROJECT, environment: ENVIRONMENT, build: buildCanary },
        await operatorToken(),
      );
      expectStatus(answer, 200);

      const body = JSON.parse(answer.body);
      expect(body.environment.split).toBeNull();
      expect(body.environment.alias).toMatchObject({ build: buildCanary, previous: buildV1 });
      /* A flip is a full cutover and says so, because nothing else in the answer
         mentions the split that was running a moment ago. */
      expect(body.warnings.map((warning: { code: string }) => warning.code)).toContain(
        "split-cleared",
      );
      observed.promotionWarnings = body.warnings;

      const settled = await until(
        `${apexHost()} to serve the promoted build alone`,
        DEADLINE_MS,
        async () => {
          const counted = await sampleVersions(caddyHttpPort, apexHost(), SPLIT_SAMPLE);
          return counted.v5 === SPLIT_SAMPLE ? counted : null;
        },
      );
      observed.promotedSample = settled;

      /* The retired leg goes the way every superseded build goes: its process is
         stopped once the winner is ready, and its host goes with it. */
      const state = await until(
        "the node to report one process for production",
        DEADLINE_MS,
        async () => {
          const got = await httpGet(agentPort, "/v1/state", {
            authorization: `Bearer ${await operatorToken()}`,
          });
          if (got.status !== 200) return null;

          const parsed = JSON.parse(got.body) as AgentState;
          return production(parsed).length === 1 ? parsed : null;
        },
      );
      expect(production(state)[0].id).toBe(`${PROJECT}--${ENVIRONMENT}--${buildCanary}`);
      expect(state.reconcile?.failures ?? []).toEqual([]);
      observed.afterPromotionProcesses = state.processes;

      const routes = await caddyRoutes();
      expect(routes.map((route) => route["@id"])).not.toContain(`scafo_${buildHost(buildV1)}`);
      /* And the operator's own route is still there, after all of it. */
      expect(routes.map((route) => route["@id"])).toContain("operator_authored");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "wakes a superseded build at its own host, and answers 404 for a name nobody owns",
    async () => {
      /*
       * THE ONE DELIBERATE WAKE, run last because it is not free: the recalled
       * build runs for `buildIdleS` after this, and every earlier test counts
       * processes. The request lands on the catch-all, the agent starts the
       * superseded build against its own fleet, holds the request through the
       * readiness gate, and answers with the very version that was retired —
       * G2's "every build recallable at its own host", observed end to end.
       */
      const woken = await until(
        `${buildHost(buildV1)} to wake and serve v1 again`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(caddyHttpPort, "/", { host: buildHost(buildV1) });
          return answer.status === 200 && answer.body.includes(`"v1"`) ? answer : null;
        },
      );
      expect(JSON.parse(woken.body).version).toBe("v1");
      observed.wokenBuildAnswer = woken;

      /* And the node says so: the wake surface admitted at least this one. */
      const state = await httpGet(agentPort, "/v1/state", {
        authorization: `Bearer ${await operatorToken()}`,
      });
      expect((JSON.parse(state.body) as AgentState).wakes?.admitted).toBeGreaterThanOrEqual(1);

      /*
       * A name nothing owns is a 404 FROM THE AGENT, in the same problem
       * document every API refusal wears — which retires the old behaviour
       * where an unrouted host got Caddy's bare 200-empty. One answer, whether
       * the name never existed or its build was reaped: the bucket is the
       * source of truth, and what it does not hold is not discussed.
       */
      const unknown = await httpGet(caddyHttpPort, "/", {
        host: `${PROJECT}--deadbeef.${PLATFORM_DOMAIN}`,
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toContain("urn:scafo:not-found");

      const unknownProject = await httpGet(caddyHttpPort, "/", {
        host: `nobody-home.${PLATFORM_DOMAIN}`,
      });
      expect(unknownProject.status).toBe(404);
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

/**
 * The same deploy with `--canary <weight>` in place of `--flip`.
 *
 * The two are refused together, which is what makes this a separate list rather
 * than an extra flag: a flip puts the new build in front of ALL the traffic and
 * a canary deliberately leaves the current one serving most of it.
 */
function canaryArgs(dir: string, weight: number): string[] {
  return [
    "deploy",
    dir,
    "--agent",
    `http://127.0.0.1:${String(agentPort)}`,
    "--project",
    PROJECT,
    "--env",
    ENVIRONMENT,
    "--canary",
    String(weight),
    "--runtime-configurable",
    "--key",
    keyPath,
  ];
}

/** The running processes of the production environment, the CI one aside. */
function production(state: AgentState): ProcessStatus[] {
  return state.processes.filter(
    (process) =>
      process.state === "running" && process.id.startsWith(`${PROJECT}--${ENVIRONMENT}--`),
  );
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
  const answer = await httpGet(caddyAdminPort, "/config/apps/http/servers/scafo/routes", {});
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
