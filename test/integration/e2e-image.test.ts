/* Image packaging path: non-root runtime, bundled Celld and esbuild, deploy, health, and graceful shutdown. */

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
const STOP_GRACE_S = 50;

let store: StartedStore;
let caddy: StartedTestContainer;
let node: StartedTestContainer;

let caddyHttpPort: number;
let apiPort: number;

let registry: RegistryContext;
let keyPath: string;
let build: string;

const tmpDirs: string[] = [];
/** Node output retained for failure context. */
const nodeLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the node image, in the topology it was packaged for", () => {
  beforeAll(async () => {
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
      .withEnvironment({
        ...storeEnv(store.fromContainers, BUCKET),
        SCAFO_NODE_ID: NODE_ID,
        SCAFO_TRANSPORT: "none",
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_CADDY_ADMIN: `http://127.0.0.1:${String(CADDY_ADMIN_PORT)}`,
        SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
      })
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
      const pinned = await node.exec(["sh", "-c", "echo $CELLD_ESBUILD"]);

      expect(celld.exitCode, celld.output).toBe(0);
      expect(celld.output).toContain("0.4.0");
      expect(esbuild.exitCode, esbuild.output).toBe(0);
      expect(pinned.output.trim()).not.toBe("");

      observed.image = {
        uid: uid.output.trim(),
        celld: celld.output.trim(),
        esbuild: esbuild.output.trim(),
        celldEsbuild: pinned.output.trim(),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "declares and reaches a healthy fixed-loopback image healthcheck",
    async () => {
      const health = await until(
        "the node to answer /.well-known/scafo/health",
        BOOT_DEADLINE_MS,
        async () => {
          const answer = await httpGet(apiPort, "/.well-known/scafo/health", {});
          return answer.status === 200 ? answer : null;
        },
      );
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
          'fetch("http://127.0.0.1:7400/.well-known/scafo/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))',
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
          "--key",
          keyPath,
        ],
        {},
      );
      observed.deployMs = Date.now() - started;

      expectCleanExit(deploy);
      expect(deploy.output, nodeLogTail()).toContain("deployed");
      build = buildIdOf(deploy.output);
      expect(await listBuilds(registry, PROJECT)).toContain(build);

      const host = `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`;
      const answer = await until(`${host} to serve "v1"`, DEADLINE_MS, async () => {
        const served = await httpGet(caddyHttpPort, "/", { host });
        return served.status === 200 && served.body.includes(`"v1"`) ? served : null;
      });

      const runtimeHealth = await httpGet(caddyHttpPort, "/.well-known/celld/health", { host });
      expect(runtimeHealth.status).toBe(200);
      expect(JSON.parse(runtimeHealth.body)).toEqual({ ok: true });

      observed.served = { host, build, body: answer.body, celldHealth: runtimeHealth.status };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "stops cleanly within the grace the image documents",
    async () => {
      const started = Date.now();
      const stopped = await docker(["stop", "-t", String(STOP_GRACE_S), node.getId()]);
      const elapsedMs = Date.now() - started;
      expect(stopped.code, stopped.output).toBe(0);

      const inspected = await docker(["inspect", "--format", "{{.State.ExitCode}}", node.getId()]);
      const exitCode = Number(inspected.output.trim());

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

/** Fails with command output and node logs. */
function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${nodeLogTail()}`).toBe(0);
}

/** The tail of the node container's output, as a failure message carries it. */
function nodeLogTail(limit: number = 12_000): string {
  const text = nodeLog.join("");
  const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
  return `--- node container logs ---\n${tail}\n--- end node container logs ---`;
}
