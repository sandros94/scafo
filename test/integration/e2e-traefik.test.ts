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
 * comparison mean anything: Traefik and the daemon SHARE a network namespace, so
 * the runtime processes listen on 127.0.0.1, Traefik dials them there, and
 * Traefik reaches the daemon on the same loopback. The store is a separate
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
import type { DaemonState } from "../../src/daemon/app.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  getEnvironment,
  listBuilds,
  nodeKey,
  operatorKey as operatorRecordKey,
  readJson,
  readMeta,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { NodeRecord, OperatorRecord } from "../../src/core/types/registry.ts";
import type { TraefikDynamicConfig } from "../../src/drivers/ingress/traefik.ts";
import {
  NODE_IMAGE,
  BOOT_DEADLINE_MS,
  type BucketSettings,
  buildIdOf,
  buildRepo,
  type CommandResult,
  DEADLINE_MS,
  FIXTURES,
  type HttpAnswer,
  httpGet,
  registryAt,
  REPO_ROOT,
  runCli,
  SETUP_TIMEOUT_MS,
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
/** Published on the Traefik container, because the daemon shares its namespace. */
const NODE_PORT = 7400;

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
 * The routers this node publishes whatever it is serving: the pair that answers
 * the fleet's API at the domain's own apex — the second of which
 * is what keeps `/v1/storage` off that public name.
 */
const STANDING_ROUTERS = [`scafo_api_${PLATFORM_DOMAIN}`, `scafo_apideny_${PLATFORM_DOMAIN}`];

let store: StartedStore;
let traefik: StartedTestContainer;
let daemon: StartedTestContainer;

let httpPort: number;
let traefikApiPort: number;
let apiPort: number;

let registry: RegistryContext;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let buildV1: string;
let buildV2: string;

const tmpDirs: string[] = [];
/** Everything the daemon container has written, kept for failure messages. */
const daemonLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the single-node product loop through Traefik", () => {
  beforeAll(async () => {
    /* Built first: the daemon container runs `dist/` off the bind-mounted
       worktree, so a stale build would test the previous commit. */
    await buildRepo();
    store = await startStore(BUCKET);

    traefik = await new GenericContainer(TRAEFIK_IMAGE)
      .withCopyFilesToContainer([
        { source: join(FIXTURES, "traefik.yml"), target: "/etc/traefik/traefik.yml" },
      ])
      /* The daemon's own port is published here: it has no network of its own. */
      .withExposedPorts(TRAEFIK_HTTP_PORT, TRAEFIK_API_PORT, NODE_PORT)
      /*
       * Waiting on `/ping` rather than on the routing, and the distinction
       * matters here in a way it did not for Caddy: Traefik is ready long before
       * it has any scafo routing at all, because the endpoint it polls belongs
       * to a daemon that has not started yet. Its provider will log a failed
       * poll a second from now, and that is the correct state to start from.
       */
      .withWaitStrategy(Wait.forHttp("/ping", TRAEFIK_API_PORT).forStatusCode(200))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    httpPort = traefik.getMappedPort(TRAEFIK_HTTP_PORT);
    traefikApiPort = traefik.getMappedPort(TRAEFIK_API_PORT);
    apiPort = traefik.getMappedPort(NODE_PORT);

    daemon = await new GenericContainer(NODE_IMAGE)
      /* The whole point of the topology: Traefik's `http://127.0.0.1:<port>`
         servers reach the celld processes, and Traefik reaches the daemon. */
      .withNetworkMode(`container:${traefik.getId()}`)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
      .withWorkingDir("/work")
      .withEnvironment({
        ...storeEnv(store.fromContainers, BUCKET),
        SCAFO_NODE_ID: NODE_ID,
        /* The listener below binds every interface, which the daemon refuses
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
        SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
        /* Keep Celld on the image's builder despite the bind-mounted worktree. */
        CELLD_ESBUILD: "/usr/local/bin/esbuild",
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "sail",
        "--listen",
        `0.0.0.0:${String(NODE_PORT)}`,
      ])
      /* Consumed from the first byte, so the logs survive even a start that
         never satisfies the wait strategy. */
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => daemonLog.push(String(chunk)));
        stream.on("err", (chunk) => daemonLog.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    registry = registryAt(store.fromHost, BUCKET);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /* Stopped before Traefik: the daemon lives in Traefik's network namespace. */
    await daemon?.stop().catch(() => {});
    await traefik?.stop().catch(() => {});
    await store?.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-traefik] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "answers its health endpoint and has bootstrapped the registry in the bucket",
    async () => {
      const health = await wait(
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

      const node = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(node?.value.addresses).toMatchObject({ apiPort: NODE_PORT });
      observed.health = JSON.parse(health.body);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "publishes an empty configuration before it has anything to serve",
    async () => {
      const answer = await httpGet(apiPort, "/v1/ingress/traefik", {});

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
    "answers Traefik's native 404 for a host nothing owns",
    async () => {
      const answer = await wait(
        "an unknown host to fall through Traefik",
        DEADLINE_MS,
        async () => {
          const got = await httpGet(httpPort, "/", { host: "unrouted.scafo.test" });
          return got.status === 404 && got.body.includes("404 page not found") ? got : null;
        },
      );
      expect(answer).toMatchObject({ status: 404 });
      expect(answer.body).toContain("404 page not found");
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
        ["operator", "keygen", "--out", keyPath, "--register"],
        storeEnv(store.fromHost, BUCKET),
      );
      expectCleanExit(result);

      operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
      /* Filed under the OPERATORS prefix, in a keyspace of its own: an operator
         key is not a machine of the fleet and no longer looks like one. */
      const record = await readJson<OperatorRecord>(registry, operatorRecordKey(operatorKey.id));
      expect(record?.value.publicKey.x).toBe(operatorKey.publicKey.x);
      expect(await readJson(registry, nodeKey(operatorKey.id))).toBeNull();
      observed.operatorId = operatorKey.id;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys the first build and reports it deployed",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await staged("v1")), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");

      buildV1 = buildIdOf(result.output);
      expect(await listBuilds(registry, PROJECT)).toContain(buildV1);
      observed.buildV1 = buildV1;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "serves the first build through Traefik on the environment host and apex",
    async () => {
      /*
       * The ROUTERS are waited for FIRST, through Traefik's API and before any
       * request touches a host — and that ordering is load-bearing twice over.
       * A request-side wait alone would not prove which provider snapshot
       * Traefik holds. Routing first, traffic second.
       */
      const expected = [
        ...[envHost(), apexHost()].map((host) => `scafo_${host}`),
        ...STANDING_ROUTERS,
      ].sort();
      await wait("Traefik to hold the two v1 routers", DEADLINE_MS, async () => {
        const routers = (await scafoRouters()).sort();
        return routers.join(",") === expected.map((name) => `${name}@http`).join(",")
          ? routers
          : null;
      });

      for (const host of [envHost(), apexHost()]) {
        const answer = await untilServes(host, "v1");
        expect(JSON.parse(answer.body).url, `the url ${host} saw`).toContain(host);
      }

      /* The document the node published, and the routers Traefik built from it:
         the same names, arrived at from opposite ends of the poll. */
      const snapshot = await snapshotNow();
      expect(Object.keys(snapshot.http?.routers ?? {}).sort()).toEqual(expected);
      observed.v1Snapshot = snapshot;
      observed.v1TraefikRouters = await scafoRouters();
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "answers the fleet's API at the domain's apex, and denies the colocated prefixes there",
    async () => {
      /*
       * THE PULL MODEL'S HALF OF THE APEX CONTRACT, and the shape worth pinning
       * against the real thing: the denial is sent to `noop@internal`, Traefik's
       * own service for a router that must reach no backend. A router naming a
       * service Traefik cannot resolve is DISABLED, and a disabled denial is
       * `/v1/storage` falling through to the apex router — so what this asserts
       * is that the denial is a router Traefik actually built and honours.
       */
      const health = await wait(
        `${PLATFORM_DOMAIN} to answer the daemon's health`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(httpPort, "/.well-known/scafo/health", {
            host: PLATFORM_DOMAIN,
          });
          return answer.status === 200 ? answer : null;
        },
      );
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });
      observed.apexHealth = JSON.parse(health.body);

      for (const path of [
        "/v1/storage",
        "/v1/storage/list?prefix=",
        "/v1/storage/objects/anything",
        "/v1/ingress/traefik",
      ]) {
        const blocked = await httpGet(httpPort, path, { host: PLATFORM_DOMAIN });

        /* Traefik's own answer for a router with nothing behind it, and the one
           thing that matters about it: it is not the daemon's. */
        expect(blocked.status, `${path} through the apex`).toBe(418);
        expect(blocked.body, `${path} through the apex`).not.toContain("urn:scafo:");
      }
      observed.apexDeniedStatus = 418;

      /* The pull-provider route itself is untouched on the node's own listener,
         which is where a colocated Traefik reaches it. */
      const local = await httpGet(apiPort, "/v1/ingress/traefik", {});
      expect(local.status).toBe(200);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "makes a second deployment current, and Traefik follows the published route",
    async () => {
      const result = await runCli(deployArgs(await staged("v2")), {});
      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      buildV2 = buildIdOf(result.output);
      expect(buildV2).not.toBe(buildV1);
      observed.buildV2 = buildV2;
      observed.deployV2Output = result.output;

      /* The deployment settles before Traefik necessarily polls the new route. */
      const publishedAt = Date.now();
      await wait(`the router for ${envHost()} to be published`, DEADLINE_MS, async () => {
        const routers = (await snapshotNow()).http?.routers ?? {};
        return `scafo_${envHost()}` in routers ? routers : null;
      });
      await untilServes(envHost(), "v2");
      observed.deployPublishedToServedMs = Date.now() - publishedAt;

      await untilServes(apexHost(), "v2");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "settles on exactly one environment-owned runtime process",
    async () => {
      const state = await wait(
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
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
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
      /* Only the fleet API routers remain; unknown application hosts fall
         through to Traefik's native 404. */
      const settledAt = await wait(
        "the node to publish nothing but the standing routers",
        DEADLINE_MS,
        async () => {
          const routers = Object.keys((await snapshotNow()).http?.routers ?? { absent: true });
          return routers.every((name) => STANDING_ROUTERS.includes(name)) ? Date.now() : null;
        },
      );
      const gone = await wait(`${envHost()} to stop being served`, DEADLINE_MS, async () => {
        const answer = await httpGet(httpPort, "/", { host: envHost() });
        return answer.status === 404 ? answer : null;
      });
      observed.retireToStandingSnapshotMs = settledAt - retiredAt;
      observed.retireToUnroutedMs = Date.now() - retiredAt;
      expect(gone.body).toContain("404 page not found");

      /* The apex goes with it. */
      for (const host of [apexHost()]) {
        const answer = await httpGet(httpPort, "/", { host });
        expect(answer.status, host).toBe(404);
        expect(answer.body, host).toContain("404 page not found");
      }

      /* Read from both ends: Traefik holds only the fleet API routers. */
      const remaining = await scafoRouters();
      expect(remaining.sort()).toEqual([...STANDING_ROUTERS].map((name) => `${name}@http`).sort());

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

/** The flags one deploy of the fixture is run with, from the host. */
function deployArgs(dir: string): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(apiPort)}`,
    "--project",
    PROJECT,
    "--env",
    ENVIRONMENT,
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
  const answer = await httpGet(apiPort, "/v1/ingress/traefik", {});
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
  const answer = await httpGet(traefikApiPort, "/api/http/routers", {});
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

/** {@link until} with the daemon's logs attached to whatever it fails to see. */
function wait<T>(what: string, deadlineMs: number, probe: () => Promise<T | null>): Promise<T> {
  return until(what, deadlineMs, probe, { context: daemonLogTail });
}

/**
 * Fails with everything the command printed, and with what the node was doing
 * while it ran: a CLI that exits non-zero has already reported why, and the
 * reason is almost always on the other side of the request it made.
 */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${daemonLogTail()}`).toBe(0);
}

/** The tail of the daemon container's output, as a failure message carries it. */
function daemonLogTail(limit: number = 12_000): string {
  const text = daemonLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- daemon container logs ---\n${tail}\n--- end daemon container logs ---`;
}
