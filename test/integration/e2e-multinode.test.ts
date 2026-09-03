/*
 * End-to-end two-node path. Traefik and daemon share a namespace locally; peer traffic needs
 * explicit non-loopback transport.
 *
 * Each node's Traefik polls THAT node for the whole fleet's routing, preferring the node it
 * sits on. So an ingress colocated with a node that holds no process for a host still answers
 * for it, over the upstreams the fleet document names on the nodes that do.
 */

import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { S3Client } from "uns3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonState } from "../../src/daemon/app.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  claimDomain,
  createEnvironment,
  domainKey,
  listNodes,
  NODE_LIVENESS_WINDOW_MS,
  placementKey,
  readJson,
  type RegistryContext,
  environmentKey,
  nodeKey,
  setReplicas,
} from "../../src/core/registry/index.ts";
import type { NodeRecord } from "../../src/core/types/registry.ts";
import type { ProcessStatus } from "../../src/core/types/supervisor.ts";
import { createUns3Store } from "../../src/drivers/store/uns3.ts";

const env = process.env;
const E2E = env.SCAFO_E2E === "1";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const FIXTURES = join(HERE, "_e2e-fixtures");
const CLI = join(REPO_ROOT, "dist/cli/index.mjs");

const STORE_IMAGE = "chrislusf/seaweedfs:4.42";
const TRAEFIK_IMAGE = "traefik:v3";
/** node24 + celld + esbuild; the same image the single-node suite needs. */
const NODE_IMAGE = "scafo-probe";

const STORE_PORT = 8333;
const TRAEFIK_HTTP_PORT = 80;
/** Carries Traefik's own API and its ping; the suite waits on the latter. */
const TRAEFIK_API_PORT = 8080;
/** Published on each Traefik container, because its daemon has no network of its own. */
const NODE_PORT = 7400;

const BUCKET = "scafo-e2e-multinode";
const KEY_PREFIX = "e2e";
const ACCESS_KEY = "scafo";
const SECRET_KEY = "scafo-secret";
const REGION = "us-east-1";
const PLATFORM_DOMAIN = "scafo.test";
const PROJECT = "app";
const ENVIRONMENT = "production";
/** Deployed, deleted through the coordinator, and reaped: the ephemeral one. */
const PREVIEW = "preview";
/**
 * Scaled down to a single node, then carried through the coordinator's death.
 *
 * The NAME is load-bearing, and only for how much this suite proves: rendezvous
 * hashing is deterministic, so `app/single` over these two node ids always lands
 * on node-a — which is the node that boots first, therefore usually wins the
 * coordinator lease, and is therefore the one the kill step kills. That makes
 * the interesting branch the usual one: the environment has to be MOVED to a
 * node that was not running it. Neither the name nor the boot order guarantees
 * it, so the assertion still handles the other outcome.
 */
const SOLO = "single";
/**
 * Deployed under a node selector only one node satisfies, then let loose again.
 *
 * Which node that is, is not rendezvous hashing's decision here but the
 * operator's: node-b boots carrying {@link FAST_LABEL} and node-a carries no
 * label at all, so `--node-selector tier=fast --replicas all` has exactly one
 * eligible node however the digests fall.
 */
const TARGETED = "targeted";

/** The label node-b boots with, and the one {@link TARGETED} selects on. */
const FAST_LABEL = "tier=fast";

/** Deployed through a node excluded from its placement selector. */
const AWAITED = "awaited";

/** Deployed to both nodes, retired out of service, then force-deleted. */
const SUNSET = "sunset";
/** Claimed for {@link SUNSET}, so its deletion has a claim to release too. */
const SUNSET_DOMAIN = "sunset.example.test";

const NODE_A = "node-a";
const NODE_B = "node-b";

/**
 * Supplied rather than minted: each Traefik starts before its daemon and has to
 * present the token from its first poll, so both sides are told the same one.
 * Traefik reads ONE source of static configuration, so it is templated into the
 * fixture rather than added to the container's environment.
 */
const INGRESS_TOKEN = "e2e-multinode-ingress-token";

const BRIDGE_NETWORK = "bridge";

const SETUP_TIMEOUT_MS = 420_000;
const STEP_TIMEOUT_MS = 180_000;
/** Per-assertion ceiling; the reconcile interval is 5s, so this is many passes. */
const DEADLINE_MS = 120_000;
const BOOT_DEADLINE_MS = 60_000;
const STORE_DEADLINE_MS = 120_000;
const POLL_MS = 500;
/** Covers liveness expiry, reassignment, reconcile, and process start after a node dies. */
const REASSIGN_DEADLINE_MS = 240_000;
const REASSIGN_STEP_TIMEOUT_MS = 300_000;
/** Draining reassignment must finish before the liveness-expiry bound. */
const GRACEFUL_DRAIN_BUDGET_MS = 60_000;

/** The lease TTL the daemon runs with; failover is bounded by a few of these. */
const LEASE_TTL_MS = 15_000;

/** One node's ingress, daemon, and host-facing ports. */
interface Node {
  id: string;
  ingress: StartedTestContainer;
  daemon: StartedTestContainer;
  /** Address the other containers reach this pair at. */
  bridgeAddress: string;
  httpPort: number;
  apiPort: number;
  /** Daemon output retained for failure context. */
  log: string[];
  /** False once this suite has deliberately stopped the daemon. */
  running: boolean;
}

let store: StartedTestContainer;
let nodes: Node[] = [];

let storeFromHost: string;
let storeFromContainers: string;

let registry: RegistryContext;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let buildV1: string;
/** The one node placement gave {@link SOLO} to; which one is not this test's to pick. */
let soloHolder: Node;
/** Its process there, so a survivor that kept it can be shown never to have restarted. */
let soloProcess: ProcessStatus;

const tmpDirs: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("two nodes of one installation, end to end", () => {
  beforeAll(async () => {
    const built = await run("pnpm", ["build"], REPO_ROOT, env as Record<string, string>);
    if (built.code !== 0) throw new Error(`"pnpm build" failed:\n${built.output}`);

    store = await new GenericContainer(STORE_IMAGE)
      .withCommand(["server", "-s3"])
      .withExposedPorts(STORE_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/))
      .withStartupTimeout(STORE_DEADLINE_MS)
      .start();

    storeFromHost = `http://${store.getHost()}:${String(store.getMappedPort(STORE_PORT))}`;
    storeFromContainers = `http://${store.getIpAddress(BRIDGE_NETWORK)}:${String(STORE_PORT)}`;
    await createBucket(storeFromHost, BUCKET);

    nodes = [await startNode(NODE_A), await startNode(NODE_B, FAST_LABEL)];

    registry = {
      store: createUns3Store(
        new S3Client({
          endpoint: storeFromHost,
          region: REGION,
          credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
          bucketStyle: "path",
          defaultBucket: BUCKET,
        }),
        { bucket: BUCKET, prefix: KEY_PREFIX },
      ),
    };

    const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-multi-key-"));
    tmpDirs.push(dir);
    keyPath = join(dir, "operator.json");
    expectCleanExit(
      await runCli(["operator", "keygen", "--out", keyPath, "--register"], storeEnv()),
    );
    operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const node of nodes) {
      await node.daemon.stop().catch(() => {});
      await node.ingress.stop().catch(() => {});
    }
    await store?.stop().catch(() => {});
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    console.log(`\n[e2e-multinode] raw observations\n${JSON.stringify(observed, null, 2)}`);
  }, SETUP_TIMEOUT_MS);

  it(
    "brings both nodes up, each registered under its own address",
    async () => {
      for (const node of nodes) {
        const health = await until(
          `${node.id} to answer /.well-known/scafo/health`,
          BOOT_DEADLINE_MS,
          async () => {
            const answer = await httpGet(node.apiPort, "/.well-known/scafo/health", {});
            return answer.status === 200 ? answer : null;
          },
        );
        expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: node.id });
      }

      expect(await listNodes(registry)).toEqual(expect.arrayContaining([NODE_A, NODE_B]));

      for (const node of nodes) {
        const record = await readJson<NodeRecord>(registry, nodeKey(node.id));
        expect(record?.value.addresses, node.id).toEqual({
          internal: node.bridgeAddress,
          apiPort: NODE_PORT,
        });
      }
      const labelled = await readJson<NodeRecord>(registry, nodeKey(NODE_B));
      const unlabelled = await readJson<NodeRecord>(registry, nodeKey(NODE_A));
      expect(labelled?.value.labels).toEqual({ tier: "fast" });
      expect(unlabelled?.value.labels).toBeUndefined();

      observed.nodes = nodes.map((node) => ({
        id: node.id,
        address: node.bridgeAddress,
        labels: node.id === NODE_B ? FAST_LABEL : null,
      }));
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deploys through one node and is served by both",
    async () => {
      const started = Date.now();
      const result = await runCli(deployArgs(await stageApp("v1"), ENVIRONMENT), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      buildV1 = buildIdOf(result.output);
      observed.buildV1 = buildV1;

      const servedAt: Record<string, number> = {};
      for (const node of nodes) {
        const at = Date.now();
        await untilServes(node, envHost(), "v1");
        servedAt[node.id] = Date.now() - at;
      }
      observed.servedAfterDeployMs = servedAt;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "counts up through one durable object however many nodes are asked",
    async () => {
      for (const node of nodes) {
        await until(`${node.id} to answer /count`, DEADLINE_MS, async () => {
          const answer = await httpGet(node.httpPort, "/count", { host: envHost() });
          return answer.status === 200 && typeof countOf(answer.body) === "number" ? answer : null;
        });
      }

      const counts: Array<{ node: string; n: number }> = [];
      for (let round = 0; round < 3; round++) {
        for (const node of nodes) {
          const answer = await httpGet(node.httpPort, "/count", { host: envHost() });
          expectStatus(answer, 200);
          counts.push({ node: node.id, n: countOf(answer.body) as number });
        }
      }

      observed.counts = counts;
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i].n, `${JSON.stringify(counts)}\n${daemonLogTail()}`).toBeGreaterThan(
          counts[i - 1].n,
        );
      }
      expect(counts.at(-1)?.n).toBe((counts[0].n as number) + counts.length - 1);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "elects exactly one coordinator, and both nodes name the same one",
    async () => {
      const states = await until(
        "one node to hold the coordinator lease",
        DEADLINE_MS,
        async () => {
          const seen = await Promise.all(nodes.map(async (node) => stateOf(node)));
          const holders = seen.filter((state) => state.coordinator?.self === true);
          return holders.length === 1 ? seen : null;
        },
      );

      const holders = nodes.filter((_, index) => states[index].coordinator?.self === true);
      expect(holders).toHaveLength(1);
      const named = new Set(states.map((state) => state.coordinator?.node));
      expect(named.size).toBe(1);
      expect([...named][0]).toBe(holders[0].id);

      observed.coordinator = {
        node: holders[0].id,
        fence: states[0].coordinator?.fence,
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "deletes an ephemeral environment asked of the node that is NOT the coordinator",
    async () => {
      await createEnvironment(registry, PROJECT, {
        name: PREVIEW,
        ephemeral: true,
      });
      expectCleanExit(
        await runCli(deployArgs(await stageApp("v1"), PREVIEW, ["--replicas", "all"]), {}),
      );

      const coordinator = await coordinatorNode();
      const asked = nodes.find((node) => node.id !== coordinator.id) as Node;
      await untilServes(asked, previewHost(), "v1");

      const started = Date.now();
      const answer = await httpDelete(
        asked.apiPort,
        `/v1/environments/${PROJECT}/${PREVIEW}`,
        await operatorToken(),
      );
      observed.proxiedDelete = {
        askedNode: asked.id,
        coordinatorNode: coordinator.id,
        status: answer.status,
        ms: Date.now() - started,
        body: answer.body,
      };

      expectStatus(answer, 200);
      expect(JSON.parse(answer.body).deleted).toContain(environmentKey(PROJECT, PREVIEW));
      expect(await readJson(registry, environmentKey(PROJECT, PREVIEW))).toBeNull();

      const reapedAt = Date.now();
      for (const node of nodes) {
        await until(`${node.id} to stop running ${PREVIEW}`, DEADLINE_MS, async () => {
          const state = await stateOf(node);
          const running = state.processes.filter(
            (process) => process.state === "running" && process.id === `${PROJECT}--${PREVIEW}`,
          );
          return running.length === 0 ? state : null;
        });
      }
      observed.previewReapedMs = Date.now() - reapedAt;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "runs a labelled environment only on the node carrying the label, then spreads it when the selector is lifted",
    async () => {
      const labelled = nodes.find((node) => node.id === NODE_B) as Node;
      const plain = nodes.find((node) => node.id === NODE_A) as Node;

      const deployedAt = Date.now();
      const result = await runCli(
        deployArgs(
          await stageApp("v1"),
          TARGETED,
          ["--node-selector", FAST_LABEL, "--replicas", "all"],
          labelled,
        ),
        {},
      );
      expectCleanExit(result);

      await until(
        `both nodes to place ${TARGETED} on ${labelled.id} alone`,
        DEADLINE_MS,
        async () => {
          const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
          const named = states.map((state) => placedNodes(state, TARGETED));
          return named.every((ids) => ids?.length === 1 && ids[0] === labelled.id) ? states : null;
        },
      );
      const placedMs = Date.now() - deployedAt;

      const served = await untilServes(labelled, targetedHost(), "v1");
      expect(JSON.parse(served.body).version).toBe("v1");

      await until(`${plain.id} to run nothing for ${TARGETED}`, DEADLINE_MS, async () => {
        const state = await stateOf(plain);
        return state.processes.some(runsTargeted) ? null : state;
      });
      /* The node the selector excluded runs nothing for the host, and still
       * answers for it: its Traefik reads the FLEET's routing from it, and that
       * document names the holder's upstream because nothing local can serve. */
      const excludedAnswer = await untilServes(plain, targetedHost(), "v1");
      expect(JSON.parse(excludedAnswer.body).version).toBe("v1");
      expect((await stateOf(plain)).processes.some(runsTargeted)).toBe(false);

      const view = (await stateOf(plain)).placements.find(
        (entry) => entry.project === PROJECT && entry.env === TARGETED,
      );
      expect(view?.selector).toEqual({ tier: "fast" });

      const clearedAt = Date.now();
      const cleared = await runCli(envArgs("selector", TARGETED, plain, ["--clear"]), {});
      expectCleanExit(cleared);
      expect(cleared.output).toContain("no nodes any more");

      /* Serving is no longer what says the environment arrived: the excluded node
       * already answered for it by forwarding. The process on it is. */
      await until(`${TARGETED} to spread to both nodes`, DEADLINE_MS, async () => {
        const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
        if (!states.every((state) => placedNodes(state, TARGETED)?.length === 2)) return null;
        return states.every((state) => state.processes.some(runsTargeted)) ? states : null;
      });
      const spread = await untilServes(plain, targetedHost(), "v1");
      const spreadMs = Date.now() - clearedAt;

      expect(JSON.parse(spread.body).version).toBe("v1");
      expect(placedNodes(await stateOf(plain), TARGETED)).toEqual([NODE_A, NODE_B]);

      observed.nodeSelector = {
        environment: TARGETED,
        selector: FAST_LABEL,
        deployedThrough: labelled.id,
        placedOn: labelled.id,
        excluded: plain.id,
        placedMs,
        /* The excluded node's own ingress, answering out of the holder's process. */
        excludedAnswer: { status: excludedAnswer.status, body: excludedAnswer.body.slice(0, 120) },
        clearedThrough: plain.id,
        spreadMs,
        clearedOutput: cleared.output.trim().slice(0, 300),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "completes a deploy through a node that was never going to run it",
    async () => {
      const plain = nodes.find((node) => node.id === NODE_A) as Node;
      const labelled = nodes.find((node) => node.id === NODE_B) as Node;

      const startedAt = Date.now();
      const result = await runCli(
        deployArgs(
          await stageApp("v1"),
          AWAITED,
          ["--node-selector", FAST_LABEL, "--replicas", "all"],
          plain,
        ),
        {},
      );
      const deployedMs = Date.now() - startedAt;
      expectCleanExit(result);

      expect(result.output, daemonLogTail()).toContain("deployed");
      expect(deployedMs).toBeLessThan(90_000);

      await until(`${AWAITED} to be placed on ${labelled.id} alone`, DEADLINE_MS, async () => {
        const named = placedNodes(await stateOf(plain), AWAITED);
        return named?.length === 1 && named[0] === labelled.id ? named : null;
      });
      expect((await stateOf(plain)).processes.some(runsAwaited)).toBe(false);

      observed.deployThroughOtherNode = {
        environment: AWAITED,
        deployedThrough: plain.id,
        placedOn: labelled.id,
        deployedMs,
        output: result.output.trim().slice(-300),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "runs an environment scaled to one replica on exactly one node, and takes it off the other",
    async () => {
      expectCleanExit(await runCli(deployArgs(await stageApp("v1"), SOLO), {}));
      for (const node of nodes) await untilServes(node, soloHost(), "v1");

      const scaledAt = Date.now();
      await setReplicas(registry, PROJECT, SOLO, 1);

      const holder = await until(
        `exactly one node to be left running ${SOLO}`,
        DEADLINE_MS,
        async () => {
          const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
          const running = nodes.filter((_, index) => states[index].processes.some(runsSolo));
          if (running.length !== 1) return null;

          const named = states.map((state) => placedNodes(state, SOLO));
          if (named.some((nodes) => nodes?.length !== 1)) return null;
          if (new Set(named.map((nodes) => nodes?.[0])).size !== 1) return null;
          return named[0]?.[0] === running[0].id ? running[0] : null;
        },
      );
      const unassigned = nodes.find((node) => node.id !== holder.id) as Node;

      const served = await untilServes(holder, soloHost(), "v1");
      expect(JSON.parse(served.body).version).toBe("v1");

      await until(`${unassigned.id} to run nothing for ${SOLO}`, DEADLINE_MS, async () => {
        const state = await stateOf(unassigned);
        return state.processes.some(runsSolo) ? null : state;
      });
      /* Same contract as the selector case: the node scaling took the process off
       * keeps answering for the host, because the fleet document its own Traefik
       * polls names the one node left running it. */
      const unassignedAnswer = await untilServes(unassigned, soloHost(), "v1");
      expect(JSON.parse(unassignedAnswer.body).version).toBe("v1");
      expect((await stateOf(unassigned)).processes.some(runsSolo)).toBe(false);
      expect(placedNodes(await stateOf(unassigned), SOLO)).toEqual([holder.id]);

      soloHolder = holder;
      soloProcess = (await stateOf(holder)).processes.find(runsSolo) as ProcessStatus;
      observed.replicasOne = {
        heldBy: holder.id,
        unassigned: unassigned.id,
        scaledDownMs: Date.now() - scaledAt,
        /* The unassigned node's own ingress, answering out of the holder's process. */
        unassignedAnswer: {
          status: unassignedAnswer.status,
          body: unassignedAnswer.body.slice(0, 120),
        },
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "moves a single-replica environment off a node that was asked to stop, FAST",
    async () => {
      const leaving = soloHolder;
      const survivor = nodes.find((node) => node.id !== leaving.id) as Node;

      const stoppedAt = Date.now();
      const stopped = await run(
        "docker",
        /* Preserve enough grace for shutdown to write the draining state. */
        ["stop", "-t", "50", leaving.daemon.getId()],
        REPO_ROOT,
        { PATH: env.PATH ?? "" },
      );
      expect(stopped.code, stopped.output).toBe(0);
      leaving.running = false;

      await until(
        `${survivor.id} to take ${SOLO} over and serve it`,
        REASSIGN_DEADLINE_MS,
        async () => {
          const state = await stateOf(survivor);
          if (placedNodes(state, SOLO)?.includes(survivor.id) !== true) return null;
          if (!state.processes.some(runsSolo)) return null;

          const answer = await httpGet(survivor.httpPort, "/", { host: soloHost() });
          return answer.status === 200 && answer.body.includes('"v1"') ? answer : null;
        },
      );
      const drainedMs = Date.now() - stoppedAt;

      expect(drainedMs).toBeLessThan(NODE_LIVENESS_WINDOW_MS);
      expect(drainedMs).toBeLessThan(GRACEFUL_DRAIN_BUDGET_MS);

      const record = await readJson<NodeRecord>(registry, nodeKey(leaving.id));
      expect(record?.value.drainingAt, "the stopped node never recorded its drain").toBeDefined();
      expect(record?.value.heartbeatAt).toBeDefined();

      const drain: Record<string, unknown> = {
        stopped: leaving.id,
        tookOver: survivor.id,
        ms: drainedMs,
        livenessWindowMs: NODE_LIVENESS_WINDOW_MS,
        budgetMs: GRACEFUL_DRAIN_BUDGET_MS,
        drainingAt: record?.value.drainingAt,
        heartbeatAt: record?.value.heartbeatAt,
      };
      observed.gracefulDrain = drain;

      const restartedAt = Date.now();
      const started = await run("docker", ["start", leaving.daemon.getId()], REPO_ROOT, {
        PATH: env.PATH ?? "",
      });
      expect(started.code, started.output).toBe(0);
      leaving.running = true;

      const back = await until(
        `${leaving.id} to be serving again with no drain flag left on it`,
        DEADLINE_MS,
        async () => {
          const node = await readJson<NodeRecord>(registry, nodeKey(leaving.id));
          if (node === null || node.value.drainingAt !== undefined) return null;
          const answer = await httpGet(leaving.apiPort, "/.well-known/scafo/health", {});
          return answer.status === 200 ? node.value : null;
        },
      );
      expect(back.drainingAt).toBeUndefined();
      drain.restoredMs = Date.now() - restartedAt;

      soloHolder = await until(`${SOLO} to settle on one node again`, DEADLINE_MS, async () => {
        const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
        const running = nodes.filter((_, index) => states[index].processes.some(runsSolo));
        if (running.length !== 1) return null;
        const named = states.map((state) => placedNodes(state, SOLO));
        if (named.some((ids) => ids?.length !== 1 || ids[0] !== running[0].id)) return null;
        return running[0];
      });
      soloProcess = (await stateOf(soloHolder)).processes.find(runsSolo) as ProcessStatus;
      drain.settledBackOn = soloHolder.id;
    },
    REASSIGN_STEP_TIMEOUT_MS,
  );

  it(
    "retires an environment out of service, then refuses to delete it until it is forced",
    async () => {
      expectCleanExit(await runCli(deployArgs(await stageApp("v1"), SUNSET), {}));
      for (const node of nodes) await untilServes(node, sunsetHost(), "v1");
      await claimDomain(registry, SUNSET_DOMAIN, PROJECT, SUNSET);

      const retiredAt = Date.now();
      const retired = await runCli(envArgs("retire", SUNSET, nodes[0]), {});
      expectCleanExit(retired);
      expect(retired.output).toContain("retired");

      /* A retired environment leaves the fleet document entirely, so neither node
       * has an upstream to forward to and both fall through to Traefik's own 404. */
      for (const node of nodes) {
        await until(`${node.id} to stop serving ${SUNSET}`, DEADLINE_MS, async () => {
          const state = await stateOf(node);
          if (state.processes.some(runsSunset)) return null;
          const answer = await httpGet(node.httpPort, "/", { host: sunsetHost() });
          return answer.status === 404 && answer.body.includes("404 page not found")
            ? answer
            : null;
        });
      }
      const stoppedMs = Date.now() - retiredAt;

      await until(`the placement of ${SUNSET} to be removed`, DEADLINE_MS, async () =>
        (await readJson(registry, placementKey(PROJECT, SUNSET))) === null ? true : null,
      );

      const coordinator = await coordinatorNode();
      const asked = nodes.find((node) => node.id !== coordinator.id) as Node;

      const refused = await runCli(envArgs("delete", SUNSET, asked), {});
      expect(refused.code, refused.output).toBe(1);
      expect(refused.output).toContain("grace");
      expect(refused.output).toContain("force");
      expect(await readJson(registry, environmentKey(PROJECT, SUNSET))).not.toBeNull();

      const forced = await runCli(envArgs("delete", SUNSET, asked, ["--force"]), {});
      expectCleanExit(forced);
      expect(forced.output).toContain(environmentKey(PROJECT, SUNSET));

      expect(await readJson(registry, environmentKey(PROJECT, SUNSET))).toBeNull();
      expect(await readJson(registry, placementKey(PROJECT, SUNSET))).toBeNull();
      expect(await readJson(registry, domainKey(SUNSET_DOMAIN))).toBeNull();

      observed.retirement = {
        environment: SUNSET,
        retiredThrough: nodes[0].id,
        deletedThrough: asked.id,
        coordinator: coordinator.id,
        stoppedServingMs: stoppedMs,
        refusal: refused.output.trim().slice(0, 400),
        deleted: forced.output.trim().slice(0, 600),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "hands coordination to the survivor when the coordinator's node dies, and keeps serving",
    async () => {
      const coordinator = await coordinatorNode();
      const survivor = nodes.find((node) => node.id !== coordinator.id) as Node;
      const fenceBefore = (await stateOf(survivor)).coordinator?.fence ?? 0;

      const killedAt = Date.now();
      const killed = await run("docker", ["kill", coordinator.daemon.getId()], REPO_ROOT, {
        PATH: env.PATH ?? "",
      });
      expect(killed.code, killed.output).toBe(0);
      coordinator.running = false;

      const state = await until(
        `${survivor.id} to take the coordinator lease over`,
        DEADLINE_MS,
        async () => {
          const seen = await stateOf(survivor);
          return seen.coordinator?.self === true && (seen.coordinator.fence ?? 0) > fenceBefore
            ? seen
            : null;
        },
      );
      const failoverMs = Date.now() - killedAt;

      expect(state.coordinator?.node).toBe(survivor.id);
      expect(state.coordinator?.fence).toBeGreaterThan(fenceBefore);
      observed.failover = {
        died: coordinator.id,
        how: "SIGKILL, so nothing was released and the lease had to expire",
        tookOver: survivor.id,
        fenceBefore,
        fenceAfter: state.coordinator?.fence,
        ms: failoverMs,
        leaseTtlMs: LEASE_TTL_MS,
      };
      expect(failoverMs).toBeGreaterThanOrEqual(LEASE_TTL_MS - LEASE_TTL_MS / 3);
      expect(failoverMs).toBeLessThanOrEqual(3 * LEASE_TTL_MS);

      const answer = await untilServes(survivor, envHost(), "v1");
      expect(JSON.parse(answer.body).version).toBe("v1");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "carries the single-replica environment through the death of whichever node held it",
    async () => {
      const survivor = nodes.find((node) => node.running) as Node;
      const killedHeldIt = soloHolder.id !== survivor.id;
      const startedAt = Date.now();

      const settled = await until(
        `${survivor.id} to be the placed node for ${SOLO} and to be serving it`,
        REASSIGN_DEADLINE_MS,
        async () => {
          const state = await stateOf(survivor);
          if (placedNodes(state, SOLO)?.includes(survivor.id) !== true) return null;
          if (!state.processes.some(runsSolo)) return null;

          const answer = await httpGet(survivor.httpPort, "/", { host: soloHost() });
          if (answer.status !== 200 || !answer.body.includes('"v1"')) return null;
          return { state, answer };
        },
      );
      const process = settled.state.processes.find(runsSolo) as ProcessStatus;
      const restarted = process.startedAt !== soloProcess.startedAt;

      expect(placedNodes(settled.state, SOLO)).toEqual([survivor.id]);
      expect(JSON.parse(settled.answer.body).version).toBe("v1");
      expect(process.id).toBe(soloProcess.id);
      expect(process.state).toBe("running");
      expect(restarted).toBe(killedHeldIt);

      observed.soloAfterKill = {
        branch: killedHeldIt
          ? "the killed node held it, and the survivor took it over"
          : "the survivor held it, and kept serving it uninterrupted",
        heldBefore: soloHolder.id,
        survivor: survivor.id,
        restarted,
        ms: Date.now() - startedAt,
        deadlineMs: REASSIGN_DEADLINE_MS,
        process: { id: process.id, pid: process.pid, startedAt: process.startedAt },
        processBefore: { pid: soloProcess.pid, startedAt: soloProcess.startedAt },
      };
    },
    REASSIGN_STEP_TIMEOUT_MS,
  );
});

/**
 * Starts one Traefik and the daemon that shares its network namespace.
 *
 * The fixture points Traefik's http provider at `127.0.0.1:7400` — which is the
 * daemon, because of that shared namespace — and asks it with `prefer=self`, so
 * this node's own processes are what it uses while they are healthy and the rest
 * of the fleet is what it falls over to.
 *
 * `labels` is what the operator says this node IS, written `k=v,k2=v2`. It is
 * boot configuration: the daemon writes it into the node's registry record on
 * every registration, so it is set here and nowhere else.
 */
async function startNode(id: string, labels?: string): Promise<Node> {
  const staticConfig = (await readFile(join(FIXTURES, "traefik.yml"), "utf8")).replace(
    "${SCAFO_INGRESS_TOKEN}",
    INGRESS_TOKEN,
  );
  const ingress = await new GenericContainer(TRAEFIK_IMAGE)
    .withCopyContentToContainer([{ content: staticConfig, target: "/etc/traefik/traefik.yml" }])
    .withExposedPorts(TRAEFIK_HTTP_PORT, TRAEFIK_API_PORT, NODE_PORT)
    .withWaitStrategy(Wait.forHttp("/ping", TRAEFIK_API_PORT).forStatusCode(200))
    .withStartupTimeout(BOOT_DEADLINE_MS)
    .start();

  const bridgeAddress = ingress.getIpAddress(BRIDGE_NETWORK);
  const log: string[] = [];

  const daemon = await new GenericContainer(NODE_IMAGE)
    .withNetworkMode(`container:${ingress.getId()}`)
    .withBindMounts([{ source: REPO_ROOT, target: "/work", mode: "rw" }])
    .withWorkingDir("/work")
    .withEnvironment({
      SCAFO_S3_ENDPOINT: storeFromContainers,
      SCAFO_S3_BUCKET: BUCKET,
      SCAFO_S3_PREFIX: KEY_PREFIX,
      SCAFO_S3_ACCESS_KEY: ACCESS_KEY,
      SCAFO_S3_SECRET_KEY: SECRET_KEY,
      SCAFO_S3_REGION: REGION,
      SCAFO_NODE_ID: id,
      SCAFO_TRANSPORT: "none",
      SCAFO_STATE_DIR: `/var/lib/scafo-${id}`,
      SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
      SCAFO_INGRESS_DRIVER: "traefik",
      SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
      /* What the peers dial: the fleet document's upstreams are this address. */
      SCAFO_ADVERTISE: `${bridgeAddress}:${String(NODE_PORT)}`,
      SCAFO_BIND_HOST: "0.0.0.0",
      CELLD_ESBUILD: "/usr/local/bin/esbuild",
      ...(labels === undefined ? {} : { SCAFO_NODE_LABELS: labels }),
    })
    .withCommand(["node", "dist/cli/index.mjs", "sail", "--listen", `0.0.0.0:${String(NODE_PORT)}`])
    .withLogConsumer((stream: Readable) => {
      stream.on("data", (chunk) => log.push(String(chunk)));
      stream.on("err", (chunk) => log.push(String(chunk)));
    })
    .withWaitStrategy(Wait.forLogMessage(/listening on/))
    .withStartupTimeout(BOOT_DEADLINE_MS)
    .start();

  return {
    id,
    ingress,
    daemon,
    bridgeAddress,
    httpPort: ingress.getMappedPort(TRAEFIK_HTTP_PORT),
    apiPort: ingress.getMappedPort(NODE_PORT),
    log,
    running: true,
  };
}

function envHost(): string {
  return `${PROJECT}--${ENVIRONMENT}.${PLATFORM_DOMAIN}`;
}

function previewHost(): string {
  return `${PROJECT}--${PREVIEW}.${PLATFORM_DOMAIN}`;
}

function soloHost(): string {
  return `${PROJECT}--${SOLO}.${PLATFORM_DOMAIN}`;
}

function sunsetHost(): string {
  return `${PROJECT}--${SUNSET}.${PLATFORM_DOMAIN}`;
}

function targetedHost(): string {
  return `${PROJECT}--${TARGETED}.${PLATFORM_DOMAIN}`;
}

/** Whether a process on a node is one serving {@link TARGETED}. */
function runsTargeted(process: ProcessStatus): boolean {
  return process.state === "running" && process.id === `${PROJECT}--${TARGETED}`;
}

function runsAwaited(process: ProcessStatus): boolean {
  return process.state === "running" && process.id === `${PROJECT}--${AWAITED}`;
}

/** Whether a process on a node is one serving {@link SOLO}. */
function runsSolo(process: ProcessStatus): boolean {
  return process.state === "running" && process.id === `${PROJECT}--${SOLO}`;
}

/** Whether a process on a node is one serving {@link SUNSET}. */
function runsSunset(process: ProcessStatus): boolean {
  return process.state === "running" && process.id === `${PROJECT}--${SUNSET}`;
}

/** One `scafo env <action>` run from the host against `node`'s node API. */
function envArgs(action: string, environment: string, node: Node, extra: string[] = []): string[] {
  return [
    "env",
    action,
    "--project",
    PROJECT,
    "--env",
    environment,
    "--node",
    `http://127.0.0.1:${String(node.apiPort)}`,
    "--key",
    keyPath,
    ...extra,
  ];
}

/** The nodes a state says an environment was placed on, or null when it has no decision. */
function placedNodes(state: DaemonState, env: string): string[] | null {
  const placed = state.placements.find((view) => view.project === PROJECT && view.env === env);
  return placed?.nodes ?? null;
}

/** What one node currently believes about itself, as an authenticated caller sees it. */
async function stateOf(node: Node): Promise<DaemonState> {
  const answer = await httpGet(node.apiPort, "/v1/state", {
    authorization: `Bearer ${await operatorToken()}`,
  });
  if (answer.status !== 200) {
    throw new Error(`${node.id} answered /v1/state with ${String(answer.status)}: ${answer.body}`);
  }
  return JSON.parse(answer.body) as DaemonState;
}

/** The node currently holding the lease, waited for rather than assumed. */
async function coordinatorNode(): Promise<Node> {
  return until("a node to hold the coordinator lease", DEADLINE_MS, async () => {
    for (const node of nodes) {
      if (!node.running) continue;
      const state = await stateOf(node);
      if (state.coordinator?.self === true) return node;
    }
    return null;
  });
}

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

/** The flags one deploy of the fixture is run with, from the host through `via`. */
function deployArgs(
  dir: string,
  environment: string,
  extra: string[] = [],
  via: Node = nodes[0],
): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(via.apiPort)}`,
    "--project",
    PROJECT,
    "--env",
    environment,
    "--key",
    keyPath,
    ...extra,
  ];
}

function storeEnv(): Record<string, string> {
  return {
    SCAFO_S3_ENDPOINT: storeFromHost,
    SCAFO_S3_BUCKET: BUCKET,
    SCAFO_S3_PREFIX: KEY_PREFIX,
    SCAFO_S3_ACCESS_KEY: ACCESS_KEY,
    SCAFO_S3_SECRET_KEY: SECRET_KEY,
    SCAFO_S3_REGION: REGION,
  };
}

/** A copy of the fixture application with its version variable set to `version`. */
async function stageApp(version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `scafo-e2e-multi-app-${version}-`));
  tmpDirs.push(dir);
  await cp(join(FIXTURES, "app"), dir, { recursive: true });

  const config = join(dir, "wrangler.jsonc");
  const text = await readFile(config, "utf8");
  await writeFile(
    config,
    text.replace(/"APP_VERSION": "[^"]*"/, `"APP_VERSION": "${version}"`),
    "utf8",
  );
  return dir;
}

function buildIdOf(output: string): string {
  const build = /scafo: build ([\da-f]{8,64})/.exec(output)?.[1];
  if (build === undefined) throw new Error(`the deploy named no build:\n${output}`);
  return build;
}

/** A fresh single-use operator token; a spent one is refused as a replay. */
function operatorToken(): Promise<string> {
  return signNodeToken(operatorKey.privateKey, operatorKey.id);
}

/** Polls one node's ingress until it answers with the expected app version. */
async function untilServes(node: Node, host: string, version: string): Promise<HttpAnswer> {
  return until(`${node.id} to serve "${version}" on ${host}`, DEADLINE_MS, async () => {
    const answer = await httpGet(node.httpPort, "/", { host });
    if (answer.status !== 200) return null;
    return answer.body.includes(`"${version}"`) ? answer : null;
  });
}

async function until<T>(
  what: string,
  deadlineMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const giveUp = Date.now() + deadlineMs;
  let last: unknown = null;

  for (;;) {
    try {
      const value = await probe();
      if (value !== null) return value;
      last = null;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= giveUp) {
      const reason = last === null ? "" : `\nlast failure: ${describeFailure(last)}`;
      throw new Error(
        `timed out after ${String(deadlineMs)}ms waiting for ${what}${reason}\n${daemonLogTail()}`,
      );
    }
    await delay(POLL_MS);
  }
}

function expectCleanExit(result: CommandResult): void {
  expect(result.code, `${result.output}\n${daemonLogTail()}`).toBe(0);
}

function expectStatus(answer: HttpAnswer, status: number): void {
  expect(answer.status, `${answer.body}\n${daemonLogTail()}`).toBe(status);
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

/** The tail of both daemons' output: with two nodes, either may hold the reason. */
function daemonLogTail(limit: number = 8000): string {
  return nodes
    .map((node) => {
      const text = node.log.join("");
      const tail = text.length <= limit ? text : `…${text.slice(-limit)}`;
      return `--- ${node.id} container logs ---\n${tail}\n--- end ${node.id} container logs ---`;
    })
    .join("\n");
}

interface HttpAnswer {
  status: number;
  body: string;
}

/**
 * One GET, over `node:http` rather than `fetch` so the `Host` header can be set:
 * every routing assertion in this suite is about which host was asked for.
 */
function httpGet(port: number, path: string, headers: Record<string, string>): Promise<HttpAnswer> {
  return send(port, path, "GET", headers, undefined);
}

function httpDelete(port: number, path: string, token: string): Promise<HttpAnswer> {
  return send(port, path, "DELETE", { authorization: `Bearer ${token}` }, undefined);
}

function send(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<HttpAnswer> {
  return new Promise<HttpAnswer>((settle, fail) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => settle({ status: response.statusCode ?? 0, body: text }));
    });
    request.on("error", fail);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

interface CommandResult {
  code: number;
  output: string;
}

function runCli(args: string[], extraEnv: Record<string, string>): Promise<CommandResult> {
  return run(process.execPath, [CLI, ...args], REPO_ROOT, {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    ...extraEnv,
  });
}

function run(
  command: string,
  args: string[],
  cwd: string,
  childEnv: Record<string, string>,
): Promise<CommandResult> {
  return new Promise<CommandResult>((settle, fail) => {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));

    child.on("error", fail);
    child.on("close", (code) => settle({ code: code ?? -1, output }));
  });
}

/**
 * Creates the bucket with an anonymous PUT, retrying because SeaweedFS answers
 * on its S3 port before it is willing to serve bucket operations on it.
 */
async function createBucket(endpoint: string, bucket: string): Promise<void> {
  const giveUp = Date.now() + STORE_DEADLINE_MS;
  let last = "no attempt was made";

  for (;;) {
    try {
      const response = await fetch(`${endpoint}/${bucket}`, { method: "PUT" });
      if (response.ok || response.status === 409) return;
      last = `answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      last = describeFailure(error);
    }
    if (Date.now() >= giveUp) {
      throw new Error(`could not create bucket "${bucket}" at ${endpoint}; last: ${last}`);
    }
    await delay(POLL_MS);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}
