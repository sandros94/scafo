/*
 * The durability knob against real infrastructure: two nodes told
 * `SCAFO_DURABILITY=fleet`, one bucket, one counter cell whose acknowledged
 * writes must survive everything this suite does to the fleet.
 *
 * Three things only this topology can show. That the knob actually reaches the
 * runtime — the spawned process's own environment carries the posture, read
 * back through `/proc` (the follower log itself lives on peer disks, not in
 * the bucket, so the bucket shows nothing). That the posture keeps its
 * promise — a node SIGKILLed mid-count loses not one acknowledged write when
 * the survivor takes the cell over. And that the mode is a rolling choice, not
 * a wedding: a third node in bucket posture joins, takes the same cell over
 * from the fleet-posture survivor, and the count still only ever goes up.
 *
 * Skipped unless SCAFO_E2E=1:
 *
 *   SCAFO_E2E=1 pnpm vitest run test/integration/e2e-durability.test.ts
 */

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_IMAGE,
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  DEADLINE_MS,
  FIXTURES,
  REPO_ROOT,
  SETUP_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  type BucketSettings,
  type StartedStore,
  httpGet,
  runCli,
  stageApp,
  startStore,
  storeEnv,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";
const describeE2e = E2E ? describe : describe.skip;

const CADDY_IMAGE = "caddy:2";
const CADDY_HTTP_PORT = 80;
const CADDY_ADMIN_PORT = 2019;
const AGENT_PORT = 7400;

const SETTINGS: BucketSettings = {
  bucket: "scafo-e2e-durability",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};

const PLATFORM_DOMAIN = "scafo.test";
const PROJECT = "app";
const ENVIRONMENT = "production";
const HOST = `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`;

interface Node {
  id: string;
  caddy: StartedTestContainer;
  agent: StartedTestContainer;
  httpPort: number;
  agentPort: number;
  log: string[];
}

describeE2e("durability, end to end", () => {
  let store: StartedStore;
  const nodes: Node[] = [];
  const tmpDirs: string[] = [];
  let keyPath: string;
  /* The count the cell last acknowledged; every assertion moves it. */
  let counted = 0;

  beforeAll(async () => {
    store = await startStore(SETTINGS);

    nodes.push(await startNode("dur-a", "fleet"));
    nodes.push(await startNode("dur-b", "fleet"));

    const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-dur-key-"));
    tmpDirs.push(dir);
    keyPath = join(dir, "operator.json");
    const keygen = await runCli(
      ["operator", "keygen", "--out", keyPath, "--register"],
      storeEnv(store.fromHost, SETTINGS),
    );
    expect(keygen.code, keygen.output).toBe(0);

    const deploy = await runCli(
      [
        "deploy",
        await stageApp("v1", tmpDirs),
        "--agent",
        `http://127.0.0.1:${String(nodes[0].agentPort)}`,
        "--project",
        PROJECT,
        "--env",
        ENVIRONMENT,
        "--flip",
        "--key",
        keyPath,
      ],
      {},
    );
    expect(deploy.code, deploy.output).toBe(0);

    for (const node of nodes) {
      await until(`${node.id} to serve ${HOST}`, DEADLINE_MS, async () => {
        const answer = await httpGet(node.httpPort, "/", { host: HOST });
        return answer.status === 200 && answer.body.includes('"v1"') ? answer : null;
      });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const node of nodes) {
      await node.agent.stop().catch(() => {});
      await node.caddy.stop().catch(() => {});
    }
    await store.container.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
  });

  it(
    "counts through both nodes: one cell, wherever the request lands",
    async () => {
      await countThrough(nodes[0]);
      await countThrough(nodes[1]);
      expect(counted).toBe(2);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "hands the configured durability to the runtime process itself",
    async () => {
      /* The knob's whole journey — environment, agent config, driver, spawned
         process — read back off the one process that actually runs the cells.
         Only runtime processes carry this variable; the agent itself does not. */
      const found = await until("a runtime process to carry the posture", DEADLINE_MS, () =>
        durabilityOf(nodes[1]),
      );
      expect(found, failureOn(nodes[1])).toBe("CELLD_DURABILITY=fleet");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "loses nothing acknowledged when a fleet-posture node is SIGKILLed",
    async () => {
      for (let i = 0; i < 8; i++) await countThrough(nodes[0]);

      /* No drain, no goodbye: whatever of the log the bucket does not have yet
         is exactly what the surviving follower is for. */
      await nodes[0].agent.stop({ timeout: 0 }).catch(() => {});

      await countExactlyOnceThrough(nodes[1], "the survivor");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "rolls the fleet back to bucket posture without losing the cell",
    async () => {
      nodes.push(await startNode("dur-c", "bucket"));
      const joined = nodes[2];

      await until(`${joined.id} to serve ${HOST}`, DEADLINE_MS, async () => {
        const answer = await httpGet(joined.httpPort, "/", { host: HOST });
        return answer.status === 200 && answer.body.includes('"v1"') ? answer : null;
      });

      const posture = await until("the joiner's runtime process", DEADLINE_MS, () =>
        durabilityOf(joined),
      );
      expect(posture, failureOn(joined)).toBe("CELLD_DURABILITY=bucket");

      /* The takeover that crosses postures: a bucket-posture process must find
         a complete bucket behind a fleet-posture writer, or refuse to serve. */
      await nodes[1].agent.stop({ timeout: 0 }).catch(() => {});

      await countExactlyOnceThrough(joined, "the bucket-posture joiner");
      await countThrough(joined);
    },
    STEP_TIMEOUT_MS,
  );

  /** One `/count` through a node's ingress, asserted strictly monotonic. */
  async function countThrough(node: Node): Promise<void> {
    const answer = await until(`${node.id} to count`, DEADLINE_MS, async () => {
      const got = await httpGet(node.httpPort, "/count", { host: HOST });
      return got.status === 200 ? got : null;
    });
    counted += 1;
    expect(countOf(answer.body), failureOn(node)).toBe(counted);
  }

  /**
   * One `/count` after a takeover: retried until the cell answers at all, and
   * then its FIRST answer must be exactly one past everything acknowledged —
   * a lower value is a lost write, a higher one a phantom.
   */
  async function countExactlyOnceThrough(node: Node, who: string): Promise<void> {
    const answer = await until(`${who} to take the cell over`, DEADLINE_MS, async () => {
      const got = await httpGet(node.httpPort, "/count", { host: HOST });
      return got.status === 200 && countOf(got.body) !== null ? got : null;
    });
    counted += 1;
    expect(countOf(answer.body), failureOn(node)).toBe(counted);
  }

  function failureOn(node: Node): string {
    return `on ${node.id}; its log:\n${node.log.join("")}`;
  }

  /** The durability line of a node's runtime-process environment, or null. */
  async function durabilityOf(node: Node): Promise<string | null> {
    const result = await node.agent.exec([
      "sh",
      "-c",
      "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep ^CELLD_DURABILITY= | head -1",
    ]);
    const line = result.output.trim();
    return line === "" ? null : line;
  }

  async function startNode(id: string, durability: "bucket" | "fleet"): Promise<Node> {
    const caddy = await new GenericContainer(CADDY_IMAGE)
      .withCopyFilesToContainer([
        { source: join(FIXTURES, "caddy.json"), target: "/etc/caddy/config.json" },
      ])
      .withCommand(["caddy", "run", "--config", "/etc/caddy/config.json"])
      .withExposedPorts(CADDY_HTTP_PORT, CADDY_ADMIN_PORT, AGENT_PORT)
      .withWaitStrategy(
        Wait.forHttp(`/config/apps/http/servers/scafo/routes`, CADDY_ADMIN_PORT).forStatusCode(200),
      )
      .start();

    const bridgeAddress = caddy.getIpAddress(BRIDGE_NETWORK);
    const log: string[] = [];

    const agent = await new GenericContainer(AGENT_IMAGE)
      .withNetworkMode(`container:${caddy.getId()}`)
      .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
      .withWorkingDir("/work")
      .withEnvironment({
        ...storeEnv(store.fromContainers, SETTINGS),
        SCAFO_NODE_ID: id,
        SCAFO_TRANSPORT: "none",
        SCAFO_STATE_DIR: `/var/lib/scafo-${id}`,
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_CADDY_ADMIN: `http://127.0.0.1:${String(CADDY_ADMIN_PORT)}`,
        SCAFO_ADVERTISE: `${bridgeAddress}:${String(AGENT_PORT)}`,
        SCAFO_BIND_HOST: "0.0.0.0",
        /* The setting under test, differing per node on purpose. */
        SCAFO_DURABILITY: durability,
        ESBUILD_BINARY_PATH: "/usr/local/bin/esbuild",
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "sail",
        "--listen",
        `0.0.0.0:${String(AGENT_PORT)}`,
      ])
      .withLogConsumer((stream: Readable) => {
        stream.on("data", (chunk) => log.push(String(chunk)));
        stream.on("err", (chunk) => log.push(String(chunk)));
      })
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS)
      .start();

    return {
      id,
      caddy,
      agent,
      httpPort: caddy.getMappedPort(CADDY_HTTP_PORT),
      agentPort: caddy.getMappedPort(AGENT_PORT),
      log,
    };
  }
});

/** The count an answer from `/count` carries, or null when it carries none. */
function countOf(body: string): number | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const n = (parsed as { n?: unknown }).n;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}
