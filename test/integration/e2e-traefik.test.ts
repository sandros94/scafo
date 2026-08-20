/*
 * The single-node product loop again, with Traefik where Caddy was: the same
 * SeaweedFS bucket, the same celld, the same built CLI driving it all from the
 * host — and a completely different conversation with the ingress.
 *
 * THE POINT OF THIS SUITE is that difference. Caddy is PUSHED: the node calls
 * its admin API and the route is in place when the call returns. Traefik PULLS:
 * the node renders its routing, caches it, serves it at `/v1/ingress/traefik`,
 * and Traefik's `http` provider polls that URL — so nothing the node does is
 * visible to traffic until the next poll. Every assertion here therefore has two
 * halves worth separating: what the NODE publishes, and what TRAEFIK serves. The
 * gap between them is the pull model, and this suite measures it.
 *
 * The topology mirrors the Caddy suite exactly, which is what makes the
 * comparison mean anything: Traefik and the agent SHARE a network namespace, so
 * the runtime processes listen on 127.0.0.1, Traefik dials them there, and
 * Traefik reaches the agent on the same loopback. The store is a separate
 * container on the docker bridge.
 *
 * There is NO operator-coexistence step here, and its absence is a finding
 * rather than an omission. Caddy's suite proves scafo leaves a hand-written
 * route alone, because scafo writes into a server the operator also writes into.
 * Traefik's http provider has no such sharing to get wrong: what this document
 * says IS everything that provider routes, and an operator's own routers come
 * from their other providers, which scafo never sees and cannot touch.
 *
 * Skipped unless SCAFO_E2E=1, because it is minutes rather than seconds:
 *
 *   SCAFO_E2E=1 pnpm vitest run test/integration/e2e-traefik.test.ts
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
  nodeKey,
  readJson,
  readMeta,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { NodeRecord } from "../../src/core/types/registry.ts";
import type { TraefikDynamicConfig } from "../../src/drivers/ingress/traefik.ts";
import {
  AGENT_IMAGE,
  BOOT_DEADLINE_MS,
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
  stageApp,
  type StartedStore,
  startStore,
  STEP_TIMEOUT_MS,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";

const TRAEFIK_IMAGE = "traefik:v3";

const TRAEFIK_HTTP_PORT = 80;
/** Carries Traefik's own API and its ping; the suite reads both from the host. */
const TRAEFIK_API_PORT = 8080;
/** Published on the Traefik container, because the agent shares its namespace. */
const AGENT_PORT = 7400;

const BUCKET: BucketSettings = {
  bucket: "scafo-e2e-traefik",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};

const PLATFORM_DOMAIN = "scafo.test";
const PROJECT = "app";
const ENVIRONMENT = "production";
const NODE_ID = "node-e2e-traefik";

/**
 * What Traefik answers for a host no router matches, pinned against the image
 * this suite runs. Its Caddy counterpart is an EMPTY 200 — Caddy's server exists
 * and simply matches nothing — which is the sharpest difference between the two
 * from a client's point of view, and the reason a health check written against
 * one of them says nothing about the other.
 */
const TRAEFIK_NO_ROUTE_BODY = "404 page not found";

let store: StartedStore;
let traefik: StartedTestContainer;
let agent: StartedTestContainer;

let httpPort: number;
let apiPort: number;
let agentPort: number;

let registry: RegistryContext;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let buildV1: string;
let buildV2: string;

const tmpDirs: string[] = [];
/** Everything the agent container has written, kept for failure messages. */
const agentLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the single-node product loop through Traefik", () => {
  beforeAll(async () => {
    /* Built first: the agent container runs `dist/` off the bind-mounted
       worktree, so a stale build would test the previous commit. */
    await buildRepo();
    store = await startStore(BUCKET);

    traefik = await new GenericContainer(TRAEFIK_IMAGE)
      .withCopyFilesToContainer([
        { source: join(FIXTURES, "traefik.yml"), target: "/etc/traefik/traefik.yml" },
      ])
      /* The agent's own port is published here: it has no network of its own. */
      .withExposedPorts(TRAEFIK_HTTP_PORT, TRAEFIK_API_PORT, AGENT_PORT)
      /*
       * Waiting on `/ping` rather than on the routing, and the distinction
       * matters here in a way it did not for Caddy: Traefik is ready long before
       * it has any scafo routing at all, because the endpoint it polls belongs
       * to an agent that has not started yet. Its provider will log a failed
       * poll a second from now, and that is the correct state to start from.
       */
      .withWaitStrategy(Wait.forHttp("/ping", TRAEFIK_API_PORT).forStatusCode(200))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    httpPort = traefik.getMappedPort(TRAEFIK_HTTP_PORT);
    apiPort = traefik.getMappedPort(TRAEFIK_API_PORT);
    agentPort = traefik.getMappedPort(AGENT_PORT);

    agent = await new GenericContainer(AGENT_IMAGE)
      /* The whole point of the topology: Traefik's `http://127.0.0.1:<port>`
         servers reach the celld processes, and Traefik reaches the agent. */
      .withNetworkMode(`container:${traefik.getId()}`)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
      .withWorkingDir("/work")
      .withEnvironment({
        ...storeEnv(store.fromContainers, BUCKET),
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
        /*
         * The one line that differs from the Caddy suite's node — and there is
         * nothing beside it, no address and no credential, because this node
         * never calls its ingress. It publishes, and Traefik asks.
         */
        SCAFO_INGRESS_DRIVER: "traefik",
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

    registry = registryAt(store.fromHost, BUCKET);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /* Stopped before Traefik: the agent lives in Traefik's network namespace. */
    await agent?.stop().catch(() => {});
    await traefik?.stop().catch(() => {});
    await store?.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-traefik] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "answers its health endpoint and has bootstrapped the registry in the bucket",
    async () => {
      const health = await wait("the agent to answer /v1/health", BOOT_DEADLINE_MS, async () => {
        const answer = await httpGet(agentPort, "/v1/health", {});
        return answer.status === 200 ? answer : null;
      });
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });

      const meta = await readMeta(registry);
      expect(meta, "the registry the first node bootstraps").not.toBeNull();

      const node = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(node?.value.addresses).toMatchObject({ agentPort: AGENT_PORT });
      observed.health = JSON.parse(health.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "publishes an empty configuration before it has anything to serve",
    async () => {
      const answer = await httpGet(agentPort, "/v1/ingress/traefik", {});

      expect(answer.status).toBe(200);
      /*
       * The empty document, and it has to be exactly this. The obvious spelling
       * of "route nothing" — `{"http":{"routers":{},"services":{}}}` — is
       * REFUSED by Traefik's decoder, which makes the poll a failed one, and a
       * failed poll leaves Traefik serving whatever it last read. A node that
       * stopped serving an environment would go on serving it.
       */
      expect(JSON.parse(answer.body)).toEqual({});
      observed.emptySnapshot = answer.body;

      /* And Traefik, having read it, holds no scafo router at all. */
      expect(await scafoRouters()).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers 404 for a host nothing routes, which is NOT what Caddy answers",
    async () => {
      const answer = await httpGet(httpPort, "/", { host: "unrouted.scafo.test" });

      expect(answer.status).toBe(404);
      expect(answer.body.trim()).toBe(TRAEFIK_NO_ROUTE_BODY);
      /* Recorded verbatim: an operator moving between the two ingresses gets a
         different answer for the same request, and nothing else says so. */
      observed.routelessHost = { status: answer.status, body: answer.body };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "registers an operator key whose public half lands in the registry",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-traefik-key-"));
      tmpDirs.push(dir);
      keyPath = join(dir, "operator.json");

      const result = await runCli(
        ["keygen", "--out", keyPath, "--register"],
        storeEnv(store.fromHost, BUCKET),
      );
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
      const result = await runCli(deployArgs(await staged("v1")), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      /*
       * "routed" here means what it means everywhere: a process serving the
       * build passed its readiness gate and the node published the routing. It
       * does NOT mean Traefik has read it yet — that is the next assertion, and
       * keeping them apart is the whole difference this suite exists to show.
       */
      expect(result.output, agentLogTail()).toContain("routed");

      buildV1 = buildIdOf(result.output);
      expect(await listBuilds(registry, PROJECT)).toContain(buildV1);
      observed.buildV1 = buildV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the first build through TRAEFIK on the environment host, the apex and the build host",
    async () => {
      for (const host of [envHost(), apexHost(), buildHost(buildV1)]) {
        const answer = await untilServes(host, "v1");
        expect(JSON.parse(answer.body).url, `the url ${host} saw`).toContain(host);
      }

      /* The document the node published, and the routers Traefik built from it:
         the same three hosts, arrived at from opposite ends of the poll. */
      const snapshot = await snapshotNow();
      expect(Object.keys(snapshot.http?.routers ?? {}).sort()).toEqual(
        [envHost(), apexHost(), buildHost(buildV1)].map((host) => `scafo_${host}`).sort(),
      );
      expect((await scafoRouters()).sort()).toEqual(
        Object.keys(snapshot.http?.routers ?? {})
          .map((name) => `${name}@http`)
          .sort(),
      );
      observed.v1Snapshot = snapshot;
      observed.v1TraefikRouters = await scafoRouters();
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "flips to a second build, and Traefik follows within a poll of the node publishing it",
    async () => {
      const result = await runCli(deployArgs(await staged("v2")), {});
      expectCleanExit(result);
      expect(result.output, agentLogTail()).toContain("routed");
      buildV2 = buildIdOf(result.output);
      expect(buildV2).not.toBe(buildV1);
      observed.buildV2 = buildV2;
      observed.deployV2Output = result.output;

      /*
       * Both v2 hosts, from both ends. The interesting number is NOT here: by
       * the time `scafo deploy` printed "routed" the node had published the new
       * routing and Traefik had already polled it, so the poll interval hides
       * entirely inside the deploy's own seconds. Recorded as the observation it
       * is — under a deploy, the pull model costs nothing visible.
       */
      const publishedAt = Date.now();
      expect(`scafo_${buildHost(buildV2)}` in ((await snapshotNow()).http?.routers ?? {})).toBe(
        true,
      );
      await untilServes(envHost(), "v2");
      observed.flipPublishedToServedMs = Date.now() - publishedAt;

      await untilServes(apexHost(), "v2");
      await untilServes(buildHost(buildV2), "v2");

      /*
       * The withdrawal is where the pull model is actually visible, because it
       * happens on the node's own schedule rather than under a command that is
       * already waiting. The planner stops the superseded process on the pass
       * AFTER v2 passed its gate, the node stops publishing that host, and only
       * Traefik's next poll takes the router away.
       *
       * In between, the router still points at a port nothing listens on — so
       * Traefik answers 502 for a host that is on its way out, where a settled
       * withdrawal answers 404. A pushed ingress has the same gap in principle
       * and a shorter one in practice, since removing the route is part of the
       * same pass that stopped the process.
       */
      const unpublishedAt = await wait(
        `the node to stop publishing ${buildHost(buildV1)}`,
        DEADLINE_MS,
        async () => {
          const routers = (await snapshotNow()).http?.routers ?? {};
          if (`scafo_${buildHost(buildV1)}` in routers) return null;
          /* Read in the same breath, so the answer belongs to the window. */
          return {
            at: Date.now(),
            stale: await httpGet(httpPort, "/", { host: buildHost(buildV1) }),
          };
        },
      );
      const withdrawn = await wait(
        `${buildHost(buildV1)} to stop being routed by Traefik`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(httpPort, "/", { host: buildHost(buildV1) });
          return answer.status === 404 ? answer : null;
        },
      );

      expect(withdrawn.body.trim()).toBe(TRAEFIK_NO_ROUTE_BODY);
      expect(await scafoRouters()).not.toContain(`scafo_${buildHost(buildV1)}@http`);
      observed.withdrawPullLatencyMs = Date.now() - unpublishedAt.at;
      observed.v1BuildHostDuringWithdrawal = unpublishedAt.stale;
      observed.v1BuildHostAfterWithdrawal = withdrawn;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "settles on exactly one running process, serving the build the alias points at",
    async () => {
      const state = await wait(
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
      expect(running[0].id).toBe(`${PROJECT}--${ENVIRONMENT}--${buildV2}`);
      /*
       * No ingress failure in the pass, which is a stronger statement here than
       * it looks: an `apply` that reaches nothing cannot fail on a network, so a
       * failure recorded against this driver could only be the render refusing a
       * routing — and the render refuses hosts, which is what it is for.
       */
      expect(state.reconcile?.failures ?? []).toEqual([]);
      observed.finalProcesses = state.processes;
      observed.finalReconcile = state.reconcile;
    },
    STEP_TIMEOUT_MS,
  );

  /*
   * Weighted traffic, the pull-model half. The Caddy suite eases a canary in
   * with `scafo deploy --canary`; this one states the split outright with
   * `scafo env split --set`, so between the two suites both surfaces are driven
   * end to end — and here the leg being brought back (v1) is one whose process
   * was STOPPED when v2 superseded it, which is the restart path.
   */

  it(
    "splits the environment's traffic over both builds, and Traefik serves both",
    async () => {
      const started = Date.now();
      const result = await runCli(
        [
          "env",
          "split",
          "--project",
          PROJECT,
          "--env",
          ENVIRONMENT,
          "--set",
          `${buildV1}=50,${buildV2}=50`,
          "--agent",
          `http://127.0.0.1:${String(agentPort)}`,
          "--key",
          keyPath,
        ],
        {},
      );
      expectCleanExit(result);
      expect(result.output).toContain("splits its traffic");
      observed.splitOutput = result.output;

      const record = await getEnvironment(registry, PROJECT, ENVIRONMENT);
      expect(record.split).toEqual([
        { build: buildV1, weight: 50 },
        { build: buildV2, weight: 50 },
      ]);
      /* The alias has not moved; a split weights traffic and nothing else. */
      expect(record.alias).toMatchObject({ build: buildV2 });

      /*
       * What the NODE publishes, first — the weighted service, with one child
       * per leg — and only then what Traefik serves. Keeping the two apart is
       * this suite's whole reason for existing, and the split is where the
       * document changes shape rather than merely changing a port.
       */
      const weighted = await wait(
        "the node to publish a weighted service for the environment host",
        DEADLINE_MS,
        async () => {
          const service = (await snapshotNow()).http?.services[`scafo_${envHost()}`];
          return service !== undefined && "weighted" in service ? service : null;
        },
      );
      expect(weighted.weighted.services.map((child) => child.weight)).toEqual([50, 50]);
      /* Every child resolves inside the same document, unqualified. */
      const services = (await snapshotNow()).http?.services ?? {};
      for (const child of weighted.weighted.services) {
        expect(child.name, child.name).not.toContain("@");
        expect(services[child.name], child.name).toBeDefined();
      }
      observed.weightedService = weighted;
      observed.splitPublishedMs = Date.now() - started;

      /*
       * And now the wire. Two builds of one environment answering on one host is
       * only possible because the node activated and started each of them in its
       * own paired step: batched activations would have started both processes
       * on the last-activated version, and all forty of these would say "v2".
       */
      const reached = await wait(
        `${envHost()} to answer with both builds`,
        DEADLINE_MS,
        async () => {
          const counted = await sampleVersions(httpPort, envHost(), SPLIT_SAMPLE);
          return counted.v1 !== undefined && counted.v2 !== undefined ? counted : null;
        },
      );
      observed.splitReachedSample = reached;
      observed.splitServedMs = Date.now() - started;

      /* Measured again on a settled routing: the sample above may have started a
         poll before Traefik read the weighted service, and a window that
         straddles the change measures the change rather than the split. */
      const seen = await sampleVersions(httpPort, envHost(), SPLIT_SAMPLE);
      observed.splitSample = seen;

      for (const version of ["v1", "v2"]) {
        expect(seen[version], `${version} of ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(
          SPLIT_MIN_REQUESTS,
        );
      }
      expect(Object.keys(seen).sort()).toEqual(["v1", "v2"]);

      /* The apex divides the same way, and each leg stays addressable alone. */
      const apex = await sampleVersions(httpPort, apexHost(), SPLIT_SAMPLE);
      expect(Object.keys(apex).sort()).toEqual(["v1", "v2"]);
      observed.splitApexSample = apex;
      expect(JSON.parse((await untilServes(buildHost(buildV1), "v1")).body).version).toBe("v1");
      expect(JSON.parse((await untilServes(buildHost(buildV2), "v2")).body).version).toBe("v2");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "promotes one leg with a flip, which clears the split and withdraws the other",
    async () => {
      const answer = await httpPost(
        agentPort,
        "/v1/aliases",
        { project: PROJECT, environment: ENVIRONMENT, build: buildV1 },
        await operatorToken(),
      );
      expect(answer.status, answer.body).toBe(200);

      const body = JSON.parse(answer.body);
      expect(body.environment.split).toBeNull();
      /* A flip is a full cutover and says so, so an operator promoting a leg is
         told the split they were running has ended. */
      expect(body.warnings.map((warning: { code: string }) => warning.code)).toContain(
        "split-cleared",
      );
      observed.promotionWarnings = body.warnings;

      /* Back to a plain load balancer: the weighted service and its children go
         with the split that declared them. */
      const plain = await wait(
        "the node to publish a single-backend service again",
        DEADLINE_MS,
        async () => {
          const service = (await snapshotNow()).http?.services[`scafo_${envHost()}`];
          return service !== undefined && "loadBalancer" in service ? service : null;
        },
      );
      expect(plain.loadBalancer.servers).toHaveLength(1);
      observed.afterPromotionService = plain;

      const settled = await wait(
        `${envHost()} to serve the promoted build alone`,
        DEADLINE_MS,
        async () => {
          const counted = await sampleVersions(httpPort, envHost(), SPLIT_SAMPLE);
          return counted.v1 === SPLIT_SAMPLE ? counted : null;
        },
      );
      observed.promotedSample = settled;

      /* The leg that lost is retired the way every superseded build is, and its
         host stops resolving with the process that served it. */
      const withdrawn = await wait(
        `${buildHost(buildV2)} to stop being routed by Traefik`,
        DEADLINE_MS,
        async () => {
          const got = await httpGet(httpPort, "/", { host: buildHost(buildV2) });
          return got.status === 404 ? got : null;
        },
      );
      expect(withdrawn.body.trim()).toBe(TRAEFIK_NO_ROUTE_BODY);
      expect(await scafoRouters()).not.toContain(`scafo_${buildHost(buildV2)}@http`);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "retires the environment, and Traefik stops answering for it entirely",
    async () => {
      const retiredAt = Date.now();
      const retired = await runCli(
        [
          "env",
          "retire",
          "--project",
          PROJECT,
          "--env",
          ENVIRONMENT,
          "--agent",
          `http://127.0.0.1:${String(agentPort)}`,
          "--key",
          keyPath,
        ],
        {},
      );
      expectCleanExit(retired);
      expect(retired.output).toContain("retired");

      /*
       * THE CASE THE DRIVER IS BUILT AROUND. This node serves one environment,
       * so retiring it leaves the routing empty — and an empty routing is the
       * one Traefik will not take from a provider unless it is spelled as an
       * empty document. Rendered any other way, this assertion never passes:
       * Traefik would go on serving a build whose process has been stopped.
       *
       * Timed in two halves, because they are two different mechanisms: the
       * reconcile pass that notices the retirement and stops publishing (up to
       * the 5s interval), and Traefik's next poll (up to the 2s this fixture
       * sets). Only the second half is what choosing a polled ingress costs.
       */
      const emptyAt = await wait(
        "the node to publish an empty configuration",
        DEADLINE_MS,
        async () => (Object.keys(await snapshotNow()).length === 0 ? Date.now() : null),
      );
      const gone = await wait(`${envHost()} to stop being served`, DEADLINE_MS, async () => {
        const answer = await httpGet(httpPort, "/", { host: envHost() });
        return answer.status === 404 ? answer : null;
      });
      observed.retireToEmptySnapshotMs = emptyAt - retiredAt;
      observed.emptySnapshotToUnroutedMs = Date.now() - emptyAt;
      observed.retireToUnroutedMs = Date.now() - retiredAt;
      expect(gone.body.trim()).toBe(TRAEFIK_NO_ROUTE_BODY);

      /* The apex and the build host go with it; nothing of this node is left. */
      for (const host of [apexHost(), buildHost(buildV2)]) {
        const answer = await httpGet(httpPort, "/", { host });
        expect(answer.status, host).toBe(404);
      }

      /* Read from both ends: the node publishes the empty document, and Traefik
         holds no scafo router at all. */
      expect(await snapshotNow()).toEqual({});
      expect(await scafoRouters()).toEqual([]);

      const record = await getEnvironment(registry, PROJECT, ENVIRONMENT);
      expect(record.retiredAt).toBeDefined();
      observed.retiredAt = record.retiredAt;
      observed.retiredSnapshot = await snapshotNow();
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

/** The flags one deploy of the fixture is run with, from the host. */
function deployArgs(dir: string): string[] {
  return [
    "deploy",
    dir,
    "--agent",
    `http://127.0.0.1:${String(agentPort)}`,
    "--project",
    PROJECT,
    "--env",
    ENVIRONMENT,
    "--flip",
    "--runtime-configurable",
    "--key",
    keyPath,
  ];
}

function staged(version: string): Promise<string> {
  return stageApp(version, tmpDirs);
}

/** A fresh single-use operator token; a spent one is refused as a replay. */
function operatorToken(): Promise<string> {
  return signNodeToken(operatorKey.privateKey, operatorKey.id);
}

/** The configuration the node is publishing for Traefik right now. */
async function snapshotNow(): Promise<TraefikDynamicConfig> {
  const answer = await httpGet(agentPort, "/v1/ingress/traefik", {});
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as TraefikDynamicConfig;
}

/**
 * The routers Traefik currently holds from the http provider — its side of the
 * poll, read from its own API rather than inferred from what it serves.
 *
 * Names come back qualified with the provider that supplied them
 * (`scafo_shop.test@http`), which is Traefik's own convention and not something
 * the node writes.
 */
async function scafoRouters(): Promise<string[]> {
  const answer = await httpGet(apiPort, "/api/http/routers", {});
  if (answer.status === 404) return [];
  expect(answer.status, `Traefik's API answered ${answer.body}`).toBe(200);

  const routers = JSON.parse(answer.body) as Array<{ name: string }>;
  return routers.map((router) => router.name).filter((name) => name.startsWith("scafo_"));
}

/** Polls one host through Traefik until it answers with the expected app version. */
function untilServes(host: string, version: string): Promise<HttpAnswer> {
  return wait(`${host} to serve "${version}"`, DEADLINE_MS, async () => {
    const answer = await httpGet(httpPort, "/", { host });
    if (answer.status !== 200) return null;
    return answer.body.includes(`"${version}"`) ? answer : null;
  });
}

/** {@link until} with the agent's logs attached to whatever it fails to see. */
function wait<T>(what: string, deadlineMs: number, probe: () => Promise<T | null>): Promise<T> {
  return until(what, deadlineMs, probe, { context: agentLogTail });
}

/**
 * Fails with everything the command printed, and with what the node was doing
 * while it ran: a CLI that exits non-zero has already reported why, and the
 * reason is almost always on the other side of the request it made.
 */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${agentLogTail()}`).toBe(0);
}

/** The tail of the agent container's output, as a failure message carries it. */
function agentLogTail(limit: number = 12_000): string {
  const text = agentLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- agent container logs ---\n${tail}\n--- end agent container logs ---`;
}
