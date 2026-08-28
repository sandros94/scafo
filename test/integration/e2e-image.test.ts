/*
 * The node image, in the topology it was packaged for.
 *
 * THIS SUITE IS ABOUT PACKAGING, NOT ABOUT THE PRODUCT. The single-node loop is
 * already proven twice over — once through Caddy, once through Traefik — and
 * both run the daemon off a bind-mounted worktree, which is exactly what an
 * operator never does. What is unproven until here is the artifact: that the
 * repository's Dockerfile builds, that the image carries celld and esbuild where
 * the code looks for them, that its entrypoint takes `sail` and its arguments,
 * that a node works with no write access outside its state directory because it
 * does not run as root, and that a container stopped inside the grace the image
 * documents exits cleanly.
 *
 * So the loop here is the shortest one that could only pass if all of that is
 * true — health, a key, one deploy, one request served, one clean stop — and
 * nothing else. Anything asserting product behaviour belongs in the suites that
 * already assert it.
 *
 * The topology is the validated one, unchanged: Caddy and the node SHARE a
 * network namespace, the celld processes bind loopback, and the store is a
 * separate container reached by address on the docker bridge.
 *
 * Skipped unless SCAFO_E2E=1, and slower than the others by however long the
 * image takes to build:
 *
 *   SCAFO_E2E=1 pnpm vitest run test/integration/e2e-image.test.ts
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import {
  listBuilds,
  nodeKey,
  readJson,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { NodeRecord } from "../../src/core/types/registry.ts";
import {
  BOOT_DEADLINE_MS,
  type BucketSettings,
  buildIdOf,
  buildRepo,
  type CommandResult,
  DEADLINE_MS,
  FIXTURES,
  httpGet,
  registryAt,
  REPO_ROOT,
  run,
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

const CADDY_IMAGE = "caddy:2";

/**
 * Tagged and KEPT rather than built anonymously and deleted on exit. The layer
 * cache makes a rebuild cheap either way; what a stable tag buys is a second run
 * that reuses the whole image, and an artifact left behind for whoever has to
 * look inside it after a failure.
 */
const IMAGE_TAG = "scafo-e2e-image";

const CADDY_HTTP_PORT = 80;
const CADDY_ADMIN_PORT = 2019;
/** Published on the Caddy container, because the node shares its namespace. */
const NODE_PORT = 7400;

/** The uid the image's `scafo` user is created with; nothing may run as root. */
const IMAGE_UID = "10001";

const BUCKET: BucketSettings = {
  bucket: "scafo-e2e-image",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};

const PLATFORM_DOMAIN = "scafo.test";
const PROJECT = "app";
const ENVIRONMENT = "production";
const NODE_ID = "node-e2e-image";

/**
 * What the container is stopped with, and the number the image, the compose
 * example and the Kubernetes manifest all carry. A node given less than this
 * has its celld processes killed mid-drain.
 */
const STOP_GRACE_S = 35;

let store: StartedStore;
let caddy: StartedTestContainer;
let node: StartedTestContainer;

let caddyHttpPort: number;
let apiPort: number;

let registry: RegistryContext;
let keyPath: string;
let build: string;

const tmpDirs: string[] = [];
/** Everything the node container has written, kept for failure messages. */
const nodeLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the node image, in the topology it was packaged for", () => {
  beforeAll(async () => {
    /* The HOST's dist, which the CLI below runs from. The image builds its own
       from source and shares nothing with it — that separation is the point. */
    await buildRepo();

    const started = Date.now();
    const image = await GenericContainer.fromDockerfile(REPO_ROOT, "Dockerfile")
      .withCache(true)
      .build(IMAGE_TAG, { deleteOnExit: false });
    observed.imageBuildMs = Date.now() - started;

    store = await startStore(BUCKET);

    caddy = await new GenericContainer(CADDY_IMAGE)
      .withCopyFilesToContainer([
        { source: join(FIXTURES, "caddy.json"), target: "/etc/caddy/config.json" },
      ])
      .withCommand(["caddy", "run", "--config", "/etc/caddy/config.json"])
      .withExposedPorts(CADDY_HTTP_PORT, CADDY_ADMIN_PORT, NODE_PORT)
      .withWaitStrategy(
        Wait.forHttp("/config/apps/http/servers/scafo/routes", CADDY_ADMIN_PORT).forStatusCode(200),
      )
      .start();

    caddyHttpPort = caddy.getMappedPort(CADDY_HTTP_PORT);
    apiPort = caddy.getMappedPort(NODE_PORT);

    node = await image
      .withNetworkMode(`container:${caddy.getId()}`)
      /*
       * NO BIND MOUNT AND NO WORKING DIRECTORY. The other suites hand the
       * container a worktree to run `dist/` out of; this one hands it nothing,
       * so everything it runs has to have been packaged into it.
       */
      .withEnvironment({
        ...storeEnv(store.fromContainers, BUCKET),
        SCAFO_NODE_ID: NODE_ID,
        SCAFO_TRANSPORT: "none",
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_CADDY_ADMIN: `http://127.0.0.1:${String(CADDY_ADMIN_PORT)}`,
        SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
        /* Deliberately NOT set here, unlike every other suite: the image pins
           ESBUILD_BINARY_PATH and names its own state directory, and a node that
           needed either of them from outside would be a packaging failure. */
      })
      /* The image's ENTRYPOINT supplies `node /app/dist/cli/index.mjs`; this is
         the CMD an operator overrides, which is what makes it worth passing. */
      .withCommand(["sail", "--listen", `0.0.0.0:${String(NODE_PORT)}`])
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => nodeLog.push(String(chunk)));
        stream.on("err", (chunk) => nodeLog.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    registry = registryAt(store.fromHost, BUCKET);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    /* Stopped before Caddy: the node lives in Caddy's network namespace. The
       last step already stopped it, and stopping a stopped container is fine. */
    await node?.stop().catch(() => {});
    await caddy?.stop().catch(() => {});
    await store?.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-image] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "runs as a non-root user, with celld, esbuild and the built CLI on board",
    async () => {
      const uid = await node.exec(["id", "-u"]);
      expect(uid.output.trim(), "the uid the image runs as").toBe(IMAGE_UID);

      const celld = await node.exec(["celld", "--version"]);
      const esbuild = await node.exec(["esbuild", "--version"]);
      /* Pinned in the image so deploy intake never resolves it across packages
         at runtime, where the answer depends on the layout it was started under. */
      const pinned = await node.exec(["sh", "-c", "echo $ESBUILD_BINARY_PATH"]);

      expect(celld.exitCode, celld.output).toBe(0);
      expect(esbuild.exitCode, esbuild.output).toBe(0);
      expect(pinned.output.trim()).not.toBe("");

      observed.image = {
        uid: uid.output.trim(),
        celld: celld.output.trim(),
        esbuild: esbuild.output.trim(),
        esbuildBinaryPath: pinned.output.trim(),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "declares and reaches a healthy fixed-loopback image healthcheck",
    async () => {
      const health = await until("the node to answer /v1/health", BOOT_DEADLINE_MS, async () => {
        const answer = await httpGet(apiPort, "/v1/health", {});
        return answer.status === 200 ? answer : null;
      });
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: NODE_ID });

      const inspected = await docker([
        "inspect",
        "--format",
        "{{json .Config.Healthcheck}}",
        IMAGE_TAG,
      ]);
      expect(inspected.code, inspected.output).toBe(0);
      const healthcheck = JSON.parse(inspected.output) as {
        Test?: string[];
        Interval?: number;
        Timeout?: number;
        StartPeriod?: number;
        Retries?: number;
      };
      expect(healthcheck).toMatchObject({
        Test: [
          "CMD",
          "node",
          "-e",
          'fetch("http://127.0.0.1:7400/v1/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))',
        ],
        Interval: 5_000_000_000,
        Timeout: 3_000_000_000,
        StartPeriod: 30_000_000_000,
        Retries: 3,
      });

      const healthy = await until("the image healthcheck to pass", BOOT_DEADLINE_MS, async () => {
        const state = await docker([
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{end}}",
          node.getId(),
        ]);
        return state.code === 0 && state.output.trim() === "healthy" ? state : null;
      });

      const record = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(record?.value.addresses).toMatchObject({ apiPort: NODE_PORT });
      observed.health = { ...JSON.parse(health.body), imageHealth: healthy.output.trim() };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "takes a deploy from the host CLI and serves it through Caddy",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-image-key-"));
      tmpDirs.push(dir);
      keyPath = join(dir, "operator.json");

      const keygen = await runCli(
        ["operator", "keygen", "--out", keyPath, "--register"],
        storeEnv(store.fromHost, BUCKET),
      );
      expectCleanExit(keygen);
      const operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
      observed.operatorId = operatorKey.id;

      const started = Date.now();
      const deploy = await runCli(
        [
          "deploy",
          await stageApp("v1", tmpDirs),
          "--node",
          `http://127.0.0.1:${String(apiPort)}`,
          "--project",
          PROJECT,
          "--env",
          ENVIRONMENT,
          "--flip",
          "--runtime-configurable",
          "--key",
          keyPath,
        ],
        {},
      );
      observed.deployMs = Date.now() - started;

      expectCleanExit(deploy);
      expect(deploy.output, nodeLogTail()).toContain("routed");
      build = buildIdOf(deploy.output);
      expect(await listBuilds(registry, PROJECT)).toContain(build);

      /* The whole packaging claim in one request: an artifact the host packed,
         unpacked and built by the IMAGE's esbuild, run by the IMAGE's celld as a
         non-root user, and reached through the ingress sharing its namespace. */
      const host = `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`;
      const answer = await until(`${host} to serve "v1"`, DEADLINE_MS, async () => {
        const served = await httpGet(caddyHttpPort, "/", { host });
        return served.status === 200 && served.body.includes(`"v1"`) ? served : null;
      });

      observed.served = { host, build, body: answer.body };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "stops cleanly within the grace the image documents",
    async () => {
      /*
       * `docker stop -t 35`, the way an operator's init system does it, rather
       * than through the test framework — the number is the point. On SIGTERM
       * the node marks itself draining, releases the coordinator lease, stops
       * reconciling, closes its listener and only then stops its celld
       * processes, which drain for 25s and are killed at 30. A container given
       * docker's default 10s is killed in the middle of that, and exits 137.
       */
      const started = Date.now();
      const stopped = await docker(["stop", "-t", String(STOP_GRACE_S), node.getId()]);
      const elapsedMs = Date.now() - started;
      expect(stopped.code, stopped.output).toBe(0);

      const inspected = await docker(["inspect", "--format", "{{.State.ExitCode}}", node.getId()]);
      const exitCode = Number(inspected.output.trim());

      /* Zero, not 137: 137 is SIGKILL, which is what a grace that ran out looks
         like from the outside and the one outcome this whole rule exists to
         prevent. */
      expect(exitCode, nodeLogTail()).toBe(0);
      expect(elapsedMs, "the stop must fit inside the grace it was given").toBeLessThan(
        STOP_GRACE_S * 1000,
      );
      expect(nodeLog.join(""), nodeLogTail()).toContain("is draining");

      observed.stop = { exitCode, elapsedMs, graceS: STOP_GRACE_S };
    },
    STEP_TIMEOUT_MS,
  );
});

/** One docker command, run the way an operator runs it. */
function docker(args: string[]): Promise<CommandResult> {
  return run("docker", args, REPO_ROOT, process.env as Record<string, string>);
}

/**
 * Fails with everything the command printed, and with what the node was doing
 * while it ran: a CLI that exits non-zero has already reported why, and the
 * reason is almost always on the other side of the request it made.
 */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${nodeLogTail()}`).toBe(0);
}

/** The tail of the node container's output, as a failure message carries it. */
function nodeLogTail(limit: number = 12_000): string {
  const text = nodeLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- node container logs ---\n${tail}\n--- end node container logs ---`;
}
