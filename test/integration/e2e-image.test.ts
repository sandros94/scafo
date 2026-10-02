/* Image packaging path: non-root runtime, bundled Celld and esbuild, deploy, health, and graceful shutdown. */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import {
  listDeployments,
  nodeKey,
  readJson,
  type RegistryContext,
} from "../../src/core/registry/index.ts";
import type { FleetRouting } from "../../src/core/types/ingress.ts";
import type { NodeRecord } from "../../src/core/types/registry.ts";
import {
  BOOT_DEADLINE_MS,
  type BucketSettings,
  collectLogs,
  type CommandResult,
  DEADLINE_MS,
  deploymentOf,
  httpGet,
  registryAt,
  REPO_ROOT,
  run,
  runCli,
  SETUP_TIMEOUT_MS,
  stageApp,
  type StartedStore,
  startExplained,
  startStore,
  STEP_TIMEOUT_MS,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";

/** The Celld release the Dockerfile pins; the image must carry that one and no other. */
async function pinnedCelldVersion(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  const pin = /^FROM ghcr\.io\/denoland\/celld:(\S+?)@sha256:/m.exec(dockerfile)?.[1];
  if (pin === undefined) throw new Error("the Dockerfile pins no Celld release");
  return pin;
}

/**
 * The container engine's client release the Dockerfile pins; the image carries
 * that client and no engine at all.
 */
async function pinnedDockerVersion(): Promise<string> {
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");
  const pin = /^ARG DOCKER_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  if (pin === undefined) throw new Error("the Dockerfile pins no container client release");
  return pin;
}

/** The bearer the routing document is read with, as an ingress would read it. */
const INGRESS_TOKEN = "e2e-image-ingress-token";

/**
 * Tagged and KEPT rather than built anonymously and deleted on exit. The layer
 * cache makes a rebuild cheap either way; what a stable tag buys is a second run
 * that reuses the whole image, and an artifact left behind for whoever has to
 * look inside it after a failure.
 */
const IMAGE_TAG = "scafo-e2e-image";

/*
 * An image reference already in the local daemon, which this suite then uses
 * instead of building the Dockerfile itself.
 *
 * CI builds the node image once at the start of the run, loads that one archive
 * into each job's daemon and names it here, so what this suite proves about the
 * packaging is proven about the bits the run publishes — not about a rebuild of
 * the same source. Unset, which is every local run, the suite builds, as it
 * always has.
 */
const PREBUILT_IMAGE: string = process.env.SCAFO_E2E_IMAGE ?? "";
/** What the container is started from, and what `docker inspect` is asked about. */
const IMAGE_REF: string = PREBUILT_IMAGE === "" ? IMAGE_TAG : PREBUILT_IMAGE;

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
/** The application this suite deploys, and the name its `wrangler.jsonc` carries. */
const APPLICATION = "app";
const NODE_ID = "node-e2e-image";

/**
 * What the container is stopped with, and the number the image, the compose
 * example and the Kubernetes manifest all carry. A node given less than this
 * has its celld processes killed mid-drain.
 */
const STOP_GRACE_S = 50;

let store: StartedStore;
let node: StartedTestContainer;

let apiPort: number;

let registry: RegistryContext;
let keyPath: string;
let deploymentVersion: string;

const tmpDirs: string[] = [];
/** Node output retained for failure context. */
const nodeLog: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("the node image, run as it ships", () => {
  beforeAll(async () => {
    const started = Date.now();
    const image =
      PREBUILT_IMAGE === ""
        ? await GenericContainer.fromDockerfile(REPO_ROOT, "Dockerfile")
            .withCache(true)
            .build(IMAGE_TAG, { deleteOnExit: false })
        : new GenericContainer(PREBUILT_IMAGE);
    observed.imageRef = IMAGE_REF;
    observed.imageBuildMs = PREBUILT_IMAGE === "" ? Date.now() - started : null;

    store = await startStore(BUCKET);

    node = await startExplained(
      image
        .withExposedPorts(NODE_PORT)
        .withEnvironment({
          ...storeEnv(store.fromContainers, BUCKET),
          SCAFO_NODE_ID: NODE_ID,
          SCAFO_TRANSPORT: "none",
          SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
          SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
          SCAFO_ADVERTISE: `127.0.0.1:${String(NODE_PORT)}`,
          /* In the environment rather than on the command line, because the
           image's healthcheck resolves the listener from the same sources the
           daemon does and a flag is not one of them. */
          SCAFO_LISTEN: `0.0.0.0:${String(NODE_PORT)}`,
        })
        .withCommand(["sail"])
        .withLogConsumer(collectLogs(nodeLog))
        .withWaitStrategy(Wait.forLogMessage(/listening on/))
        .withStartupTimeout(BOOT_DEADLINE_MS),
      { log: nodeLog, what: `node ${NODE_ID}` },
    );
    apiPort = node.getMappedPort(NODE_PORT);

    registry = registryAt(store.fromHost, BUCKET);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await node?.stop().catch(() => {});
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
      expect(celld.output).toContain(await pinnedCelldVersion());
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
    "carries the container engine's client on PATH, and no engine of its own",
    async () => {
      /* `celld deploy` builds or pulls a container image through this client on
         the node that accepts the deploy, so it has to be here; the engine it
         talks to is the operator's, through a socket they mount. */
      const found = await node.exec(["sh", "-c", "command -v docker"]);
      expect(found.exitCode, found.output).toBe(0);
      expect(found.output.trim()).toBe("/usr/local/bin/docker");

      const version = await node.exec(["docker", "--version"]);
      expect(version.exitCode, version.output).toBe(0);
      expect(version.output).toContain(await pinnedDockerVersion());

      /* No engine, and nothing to reach without a socket: the client alone
         grants the node nothing. */
      const engine = await node.exec(["sh", "-c", "command -v dockerd containerd"]);
      expect(engine.exitCode, engine.output).not.toBe(0);

      const info = await node.exec(["docker", "info"]);
      expect(info.exitCode, info.output).not.toBe(0);

      observed.containerClient = {
        path: found.output.trim(),
        version: version.output.trim(),
        infoExitCode: info.exitCode,
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "declares a healthcheck that reads the node's own configuration, and reaches it",
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
        IMAGE_REF,
      ]);
      expect(inspected.code, inspected.output).toBe(0);
      const healthcheck = JSON.parse(inspected.output) as {
        Test?: string[];
        Interval?: number;
        Timeout?: number;
        StartPeriod?: number;
        Retries?: number;
      };
      /* The probe is the CLI's own `health`, so the container's listener — set
         here to the wildcard, not the default loopback — is what it asks. */
      expect(healthcheck).toMatchObject({
        Test: ["CMD", "node", "/app/dist/cli/index.mjs", "health"],
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

      /* What the probe itself says, run the way the healthcheck runs it: the
         line names the listener it read out of the node's own configuration. */
      const probe = await node.exec(["node", "/app/dist/cli/index.mjs", "health"]);
      expect(probe.exitCode, probe.output).toBe(0);
      expect(probe.output).toContain(`0.0.0.0:${String(NODE_PORT)}`);

      const record = await readJson<NodeRecord>(registry, nodeKey(NODE_ID));
      expect(record?.value.addresses).toMatchObject({ apiPort: NODE_PORT });
      observed.health = {
        ...JSON.parse(health.body),
        imageHealth: healthy.output.trim(),
        probe: probe.output.trim(),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "takes a deploy from the host CLI and serves it from the image's own runtime",
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
          "--name",
          APPLICATION,
          "--key",
          keyPath,
        ],
        {},
      );
      observed.deployMs = Date.now() - started;

      expectCleanExit(deploy);
      expect(deploy.output, nodeLogTail()).toContain("deployed");
      deploymentVersion = deploymentOf(deploy.output);
      expect(await listDeployments(registry, APPLICATION)).toContain(deploymentVersion);

      /* Served the way any ingress finds it: the routing document names the
         host and the upstream that answers it, and that upstream, dialled from
         inside the node, answers with the deployment just made. The ingress in
         front is the e2e suite's to prove. */
      const host = `${APPLICATION}.${PLATFORM_DOMAIN}`;
      const answer = await until(`${host} to serve "v1"`, DEADLINE_MS, async () => {
        const routes = await httpGet(apiPort, "/v1/ingress/routes", {
          authorization: `Bearer ${INGRESS_TOKEN}`,
        });
        if (routes.status !== 200) return null;
        const route = (JSON.parse(routes.body) as FleetRouting).routes.find(
          (entry) => entry.host === host,
        );
        const upstream = route?.upstreams[0]?.address;
        if (upstream === undefined) return null;

        const served = await node.exec([
          "node",
          "-e",
          `fetch(${JSON.stringify(`http://${upstream}/`)}).then(async (r) => console.log(r.status, await r.text()))`,
        ]);
        return served.exitCode === 0 &&
          served.stdout.startsWith("200 ") &&
          served.stdout.includes(`"v1"`)
          ? { upstream, body: served.stdout.slice(4).trim() }
          : null;
      });

      observed.served = { host, deployment: deploymentVersion, ...answer };
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
