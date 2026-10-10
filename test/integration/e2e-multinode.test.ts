/*
 * End-to-end two-node path. Traefik and daemon share a namespace locally; peer traffic needs
 * explicit non-loopback transport.
 *
 * Each node's Traefik polls THAT node for the whole fleet's routing, preferring the node it
 * sits on. So an ingress colocated with a node that holds no process for a host still answers
 * for it, over the upstreams the fleet document names on the nodes that do.
 *
 * What runs here is what scafo owns. What only Celld decides — how it treats a lease a store
 * corrupted, whether a write it acknowledged comes back after both nodes die — is observed
 * when a Celld release is admitted, and only then: those cases are opt-in with
 * `SCAFO_E2E_CELLD_RELEASE=1` beside `SCAFO_E2E=1`, and their names say so.
 */

import { spawn } from "node:child_process";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { S3Client } from "uns3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonState, SupervisedProcess } from "../../src/daemon/app.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  applicationKey,
  claimDomain,
  domainKey,
  listNodes,
  NODE_LIVENESS_WINDOW_MS,
  placementKey,
  readJson,
  type RegistryContext,
  nodeKey,
} from "../../src/core/registry/index.ts";
import type { CelldLeaseReading } from "../../src/core/registry/celld-lease.ts";
import { celldNodeLeaseKey } from "../../src/core/registry/paths.ts";
import type { FleetRouting } from "../../src/core/types/ingress.ts";
import type { NodeFailure, NodeRecord } from "../../src/core/types/registry.ts";
import type { ProcessStatus } from "../../src/core/types/supervisor.ts";
import { createUns3Store } from "../../src/drivers/store/uns3.ts";
import {
  ADOPTION_BOUND_MS,
  collectLogs,
  reportObservations,
  startExplained,
  STORE_IMAGE,
} from "./_harness.ts";

const env = process.env;
const E2E = env.SCAFO_E2E === "1";
/** Also runs what is asked of each Celld release before it is admitted. */
const CELLD_RELEASE = env.SCAFO_E2E_CELLD_RELEASE === "1";
/** Appended to the name of every case that runs only at a Celld release. */
const AT_CELLD_RELEASE = "(at a Celld release: SCAFO_E2E_CELLD_RELEASE=1)";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const FIXTURES = join(HERE, "_e2e-fixtures");
const CLI = join(REPO_ROOT, "dist/cli/index.mjs");

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

const NODE_A = "node-a";
const NODE_B = "node-b";

/** The application every other name here shares a prefix with. */
const APPLICATION = "app";
/**
 * Deployed to a single node from the start, then moved off it by a graceful stop.
 *
 * Rendezvous hashing is deterministic, so this name alone decides which of the
 * two nodes holds it; which one that is, is not this test's to pick.
 */
const SOLO = "app-single";
/**
 * Deployed under a node selector only one node satisfies, THROUGH the node the
 * selector excludes, then let loose again.
 *
 * Which node that is, is not rendezvous hashing's decision here but the
 * operator's: node-b boots carrying {@link FAST_LABEL} and node-a carries no
 * label at all, so `--node-selector tier=fast --replicas all` has exactly one
 * eligible node however the digests fall.
 */
const TARGETED = "app-targeted";

/** The label node-b boots with, and the one {@link TARGETED} selects on. */
const FAST_LABEL = "tier=fast";

/** Carried through a SIGKILL of both nodes; nothing else touches it. */
const DURABLE = "app-durable";

/**
 * Counted up on both nodes, then carried through a SIGKILL of both while the
 * bucket was frozen. Only at a Celld release; deployed last, and nothing else
 * touches it.
 */
const ACKED = "app-acked";

/**
 * Deployed to both nodes, then made unable to start on {@link REFUSING_NODE}
 * alone: its runtime process there exits before it ever becomes ready, for as
 * long as the suite leaves a marker for it.
 */
const REFUSED = "app-refused";

/**
 * The node whose every Celld goes through {@link REFUSING_CELLD}, which runs the
 * real one unless a marker under {@link REFUSE_DIR} names the application.
 */
const REFUSING_NODE = NODE_A;
/** The wrapper, as the node's container sees the worktree bind-mounted at `/work`. */
const REFUSING_CELLD = "/work/test/integration/_e2e-fixtures/celld-refusing.sh";
/** Inside the node's container; the wrapper reads the same path. */
const REFUSE_DIR = "/tmp/scafo-e2e-refuse";

/**
 * Deployed to both nodes, then made unable to start on ONE of them by putting a
 * body Celld cannot use at that node's own Celld node lease. Only at a Celld
 * release: what Celld does with that object is upstream's, and whether it still
 * wedges is what says whether `scafo app lease` is still needed at all.
 *
 * WHY THE LEASE. It is the object a Celld process must read or create before it
 * has any authority at all, and the node name it is filed under is the scafo node
 * id — stable across restarts, deliberately. A store that holds a body there
 * which Celld cannot use therefore wedges that node's process on the same key,
 * every restart, for as long as the object stands.
 */
const WEDGED = "app-wedged";

/**
 * The body put at the wedged node's lease key: JSON that stops half way.
 *
 * TRUNCATED RATHER THAN NONSENSE, because that is the shape a store leaves
 * behind — a write that was cut off, or an object served short. It is not a lease
 * by upstream's own rule (`node` and `expires_ms`) and it is not JSON either.
 */
const TRUNCATED_LEASE = '{"node":"node-a","expires_ms":';

/** Deployed to both nodes, retired out of service, then force-deleted. */
const SUNSET = "app-sunset";
/** Claimed for {@link SUNSET}, so its deletion has a claim to release too. */
const SUNSET_DOMAIN = "sunset.example.test";

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
/**
 * How long the release-only durability case gives the warm-up counts to reach
 * the bucket before it freezes the bucket.
 *
 * A WAIT AND NOT AN ASSERTION, because nothing the fleet publishes says "the
 * bucket has this row now" — an upload is what the runtime does after it has
 * already answered. It only has to be long enough that the write taken while
 * the bucket is frozen is the ONLY one whose fate is in question.
 */
const BUCKET_UPLOAD_SETTLE_MS = 6_000;
/**
 * How long the bucket stays frozen.
 *
 * SHORT ON PURPOSE: a runtime process renews its own node lease against the
 * bucket every few seconds and fences itself after ten without it, so a longer
 * freeze would stop the processes for a reason that has nothing to do with what
 * this case is about. Everything inside the window is one HTTP GET and two
 * container kills.
 */
const FROZEN_BUDGET_MS = 8_000;
/** How long the bucket must have been taking writes before the nodes come back. */
const STORE_AWAKE_WINDOW_MS = 20_000;
/** Draining reassignment must finish before the liveness-expiry bound. */
const GRACEFUL_DRAIN_BUDGET_MS = 60_000;

/**
 * The coordinator lease TTL every node runs with, through the setting an
 * operator has; failover is bounded by a few of these.
 *
 * SHORTER THAN THE DEFAULT, and nothing here needs it longer: what a coordinator
 * decides is a function of the registry, so a lease that changes hands decides
 * nothing differently, and a shorter TTL only makes the coordinator renew and
 * the survivor take over sooner.
 */
const LEASE_TTL_MS = 6_000;

/**
 * Where a node keeps what it must remember between boots, inside its container.
 *
 * A HOST DIRECTORY IS MOUNTED HERE, because the runtime work directories live
 * under it: a write is acknowledged once a peer holds it on the follower disk
 * kept there, before the bucket has it, and a node recovers it at boot from what
 * its predecessor of the same name left. A state directory that only existed
 * inside the container would make the durability case prove nothing about a
 * deployment where the container is re-created.
 */
const STATE_DIR = "/var/lib/scafo";

/** Mode the mounted directory is given, so the image's uid 10001 may write it. */
const STATE_DIR_MODE = 0o777;

/** One node's ingress, daemon, and host-facing ports. */
interface Node {
  id: string;
  ingress: StartedTestContainer;
  daemon: StartedTestContainer;
  /** The host directory mounted at {@link STATE_DIR}; it outlives the container. */
  stateDir: string;
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
let versionV1: string;
/** The one node placement gave {@link SOLO} to; which one is not this test's to pick. */
let soloHolder: Node;

const tmpDirs: string[] = [];
/** Raw observations the report is written from; printed once at the end. */
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E)("two nodes of one installation, end to end", () => {
  beforeAll(async () => {
    store = await new GenericContainer(STORE_IMAGE)
      .withCommand(["server", "-s3"])
      .withExposedPorts(STORE_PORT)
      .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/))
      .withStartupTimeout(STORE_DEADLINE_MS)
      .start();

    storeFromHost = `http://${store.getHost()}:${String(store.getMappedPort(STORE_PORT))}`;
    storeFromContainers = `http://${store.getIpAddress(BRIDGE_NETWORK)}:${String(STORE_PORT)}`;
    await createBucket(storeFromHost, BUCKET);

    nodes = [
      await startNode(NODE_A, { celldBin: REFUSING_CELLD }),
      await startNode(NODE_B, { labels: FAST_LABEL }),
    ];

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
    /* The node wrote these as uid 10001 into directories only it may enter, so
       they are removed from inside a container that may enter them. */
    for (const node of nodes) {
      await run(
        "docker",
        [
          "run",
          "--rm",
          "--user",
          "0",
          "-v",
          `${node.stateDir}:/state`,
          "--entrypoint",
          "sh",
          NODE_IMAGE,
          "-c",
          "rm -rf /state/..?* /state/.[!.]* /state/*",
        ],
        REPO_ROOT,
        { PATH: env.PATH ?? "" },
      ).catch(() => {});
      await rm(node.stateDir, { recursive: true, force: true }).catch(() => {});
    }
    for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

    reportObservations("e2e-multinode", observed);
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
      const result = await runCli(deployArgs(await stageApp("v1"), APPLICATION), {});
      observed.deployV1Ms = Date.now() - started;
      observed.deployV1Output = result.output;

      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      versionV1 = deploymentOf(result.output);
      observed.versionV1 = versionV1;

      const servedAt: Record<string, number> = {};
      for (const node of nodes) {
        const at = Date.now();
        await untilServes(node, hostOf(APPLICATION), "v1");
        servedAt[node.id] = Date.now() - at;
      }
      observed.servedAfterDeployMs = servedAt;
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "has the node that did NOT accept a deploy serving it seconds later",
    async () => {
      /*
       * A deploy lands on ONE node. The others are told nothing directly: their
       * next reconcile pass sees the application's deployment revision move, and
       * each asks its own runtime process to adopt the fleet's pointer at once
       * rather than waiting out that process's own thirty-second poll. This
       * measures the node that took no part in the deploy.
       */
      const accepting = nodes[0] as Node;
      const peer = nodes.find((node) => node.id !== accepting.id) as Node;

      const result = await runCli(deployArgs(await stageApp("v2"), APPLICATION, [], accepting), {});
      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      const deployedAt = Date.now();

      await untilServes(peer, hostOf(APPLICATION), "v2");
      const adoptedMs = Date.now() - deployedAt;
      observed.peerAdoptedMs = { node: peer.id, ms: adoptedMs };
      console.log(
        `e2e: ${peer.id}, which did not accept the deploy, served v2 ` +
          `${String(adoptedMs)}ms after it was deployed`,
      );
      expect(
        adoptedMs,
        `${String(adoptedMs)}ms from "deployed" to ${peer.id} serving v2`,
      ).toBeLessThan(ADOPTION_BOUND_MS);
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

  /*
   * THE ONE PLACE `scafo app lease` reads a lease Celld itself wrote, through the
   * real CLI against a real store. What it judges is Celld's own record, so a
   * release that changed its shape or its key reads here as anything but `held`.
   */
  it(
    "reads the node lease Celld wrote for a running application as held, at the key scafo derives",
    async () => {
      const node = nodes[0] as Node;
      const shown = await runCli(
        ["app", "lease", "show", "--name", APPLICATION, "--node", node.id, "--json"],
        /* Silenced so the output is the JSON document alone. */
        { ...storeEnv(), SCAFO_SILENCE_WARNINGS: "1" },
      );
      expectCleanExit(shown);

      const report = JSON.parse(shown.output) as { leases: CelldLeaseReading[] };
      expect(report.leases).toHaveLength(1);
      expect(report.leases[0], shown.output).toMatchObject({
        application: APPLICATION,
        node: node.id,
        key: celldNodeLeaseKey(APPLICATION, node.id),
        verdict: "held",
      });
      observed.leaseShow = report.leases[0];
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "runs a labelled application only on the node carrying the label, deployed through the node it excludes, then spreads it when the selector is lifted",
    async () => {
      const labelled = nodes.find((node) => node.id === NODE_B) as Node;
      const plain = nodes.find((node) => node.id === NODE_A) as Node;

      /* Through the node the selector excludes: the node that accepts a deploy
         publishes it and records it whether or not it will ever run it. */
      const deployedAt = Date.now();
      const result = await runCli(
        deployArgs(
          await stageApp("v1"),
          TARGETED,
          ["--node-selector", FAST_LABEL, "--replicas", "all"],
          plain,
        ),
        {},
      );
      const deployedMs = Date.now() - deployedAt;
      expectCleanExit(result);
      expect(result.output, daemonLogTail()).toContain("deployed");
      expect(deployedMs).toBeLessThan(90_000);

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

      const served = await untilServes(labelled, hostOf(TARGETED), "v1");
      expect(JSON.parse(served.body).version).toBe("v1");

      await until(`${plain.id} to run nothing for ${TARGETED}`, DEADLINE_MS, async () => {
        const state = await stateOf(plain);
        return state.processes.some(runsTargeted) ? null : state;
      });
      /* The node the selector excluded runs nothing for the host, and still
       * answers for it: its Traefik reads the FLEET's routing from it, and that
       * document names the holder's upstream because nothing local can serve. */
      const excludedAnswer = await untilServes(plain, hostOf(TARGETED), "v1");
      expect(JSON.parse(excludedAnswer.body).version).toBe("v1");
      expect((await stateOf(plain)).processes.some(runsTargeted)).toBe(false);

      const view = (await stateOf(plain)).placements.find(
        (entry) => entry.application === TARGETED,
      );
      expect(view?.selector).toEqual({ tier: "fast" });

      const clearedAt = Date.now();
      const cleared = await runCli(appArgs("selector", TARGETED, plain, ["--clear"]), {});
      expectCleanExit(cleared);
      expect(cleared.output).toContain("no nodes any more");

      /* Serving is no longer what says the application arrived: the excluded node
       * already answered for it by forwarding. The process on it is. */
      await until(`${TARGETED} to spread to both nodes`, DEADLINE_MS, async () => {
        const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
        if (!states.every((state) => placedNodes(state, TARGETED)?.length === 2)) return null;
        return states.every((state) => state.processes.some(runsTargeted)) ? states : null;
      });
      const spread = await untilServes(plain, hostOf(TARGETED), "v1");
      const spreadMs = Date.now() - clearedAt;

      expect(JSON.parse(spread.body).version).toBe("v1");
      expect(placedNodes(await stateOf(plain), TARGETED)).toEqual([NODE_A, NODE_B]);

      observed.nodeSelector = {
        application: TARGETED,
        selector: FAST_LABEL,
        deployedThrough: plain.id,
        placedOn: labelled.id,
        excluded: plain.id,
        deployedMs,
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
    "runs a single-replica application on exactly one node, and answers for it on the other",
    async () => {
      const deployedAt = Date.now();
      expectCleanExit(
        await runCli(deployArgs(await stageApp("v1"), SOLO, ["--replicas", "1"]), {}),
      );

      const holder = await until(
        `exactly one node to be running ${SOLO}`,
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

      const served = await untilServes(holder, hostOf(SOLO), "v1");
      expect(JSON.parse(served.body).version).toBe("v1");

      await until(`${unassigned.id} to run nothing for ${SOLO}`, DEADLINE_MS, async () => {
        const state = await stateOf(unassigned);
        return state.processes.some(runsSolo) ? null : state;
      });
      /* Same contract as the selector case: the node placement left out keeps
       * answering for the host, because the fleet document its own Traefik polls
       * names the one node running it. */
      const unassignedAnswer = await untilServes(unassigned, hostOf(SOLO), "v1");
      expect(JSON.parse(unassignedAnswer.body).version).toBe("v1");
      expect((await stateOf(unassigned)).processes.some(runsSolo)).toBe(false);
      expect(placedNodes(await stateOf(unassigned), SOLO)).toEqual([holder.id]);

      soloHolder = holder;
      observed.replicasOne = {
        heldBy: holder.id,
        unassigned: unassigned.id,
        placedMs: Date.now() - deployedAt,
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
    "moves a single-replica application off a node that was asked to stop, FAST",
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

          const answer = await httpGet(survivor.httpPort, "/", { host: hostOf(SOLO) });
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

      const settled = await until(`${SOLO} to settle on one node again`, DEADLINE_MS, async () => {
        const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
        const running = nodes.filter((_, index) => states[index].processes.some(runsSolo));
        if (running.length !== 1) return null;
        const named = states.map((state) => placedNodes(state, SOLO));
        if (named.some((ids) => ids?.length !== 1 || ids[0] !== running[0].id)) return null;
        return running[0];
      });
      drain.settledBackOn = settled.id;
    },
    REASSIGN_STEP_TIMEOUT_MS,
  );

  it(
    "retires an application out of service, then refuses to delete it until it is forced",
    async () => {
      expectCleanExit(await runCli(deployArgs(await stageApp("v1"), SUNSET), {}));
      for (const node of nodes) await untilServes(node, hostOf(SUNSET), "v1");
      await claimDomain(registry, SUNSET_DOMAIN, SUNSET);

      const retiredAt = Date.now();
      const retired = await runCli(appArgs("retire", SUNSET, nodes[0]), {});
      expectCleanExit(retired);
      expect(retired.output).toContain("retired");

      /* A retired application leaves the fleet document entirely, so neither node
       * has an upstream to forward to and both fall through to Traefik's own 404. */
      for (const node of nodes) {
        await until(`${node.id} to stop serving ${SUNSET}`, DEADLINE_MS, async () => {
          const state = await stateOf(node);
          if (state.processes.some(runsSunset)) return null;
          const answer = await httpGet(node.httpPort, "/", { host: hostOf(SUNSET) });
          return answer.status === 404 && answer.body.includes("404 page not found")
            ? answer
            : null;
        });
      }
      const stoppedMs = Date.now() - retiredAt;

      await until(`the placement of ${SUNSET} to be removed`, DEADLINE_MS, async () =>
        (await readJson(registry, placementKey(SUNSET))) === null ? true : null,
      );

      const coordinator = await coordinatorNode();
      const asked = nodes.find((node) => node.id !== coordinator.id) as Node;

      const refused = await runCli(appArgs("delete", SUNSET, asked), {});
      expect(refused.code, refused.output).toBe(1);
      expect(refused.output).toContain("grace");
      expect(refused.output).toContain("force");
      expect(await readJson(registry, applicationKey(SUNSET))).not.toBeNull();
      /* Retirement stops the processes and keeps what they left on disk: the
         application may come back, and a peer may still need those writes. */
      for (const node of nodes) {
        expect(await holdsLocalState(node, SUNSET), `${node.id} dropped it on retirement`).toBe(
          true,
        );
      }

      const forced = await runCli(appArgs("delete", SUNSET, asked, ["--force"]), {});
      expectCleanExit(forced);
      expect(forced.output).toContain(applicationKey(SUNSET));

      expect(await readJson(registry, applicationKey(SUNSET))).toBeNull();
      expect(await readJson(registry, placementKey(SUNSET))).toBeNull();
      expect(await readJson(registry, domainKey(SUNSET_DOMAIN))).toBeNull();
      /* The application whose name every one of these prefixes is untouched. */
      expect(await readJson(registry, applicationKey(APPLICATION))).not.toBeNull();

      /* Deletion is what lets each node go: the pass that finds the application
         gone from the registry runs nothing for it and removes its local state. */
      const deletedAt = Date.now();
      for (const node of nodes) {
        await until(`${node.id} to let ${SUNSET} go`, DEADLINE_MS, async () => {
          const state = await stateOf(node);
          if (state.processes.some(runsSunset)) return null;
          return (await holdsLocalState(node, SUNSET)) ? null : state;
        });
      }
      const letGoMs = Date.now() - deletedAt;

      observed.retirement = {
        application: SUNSET,
        retiredThrough: nodes[0].id,
        deletedThrough: asked.id,
        coordinator: coordinator.id,
        stoppedServingMs: stoppedMs,
        refusal: refused.output.trim().slice(0, 400),
        deleted: forced.output.trim().slice(0, 600),
        localStateRemovedMs: letGoMs,
      };
    },
    STEP_TIMEOUT_MS,
  );

  /*
   * THE DEFECT THIS CASE EXISTS FOR. A process that can never become ready stays
   * up for as long as it takes to give up and then exits, over and over. Judged by
   * how long each run lasted, every one of those runs "lasted": the node stayed
   * live, the application stayed `serving`, and the dead port stayed in the
   * routing every ingress reads. Readiness is what tells the two apart.
   *
   * The process is made to fail by the Celld this node was pointed at, which
   * exits before it is ready for as long as a marker names the application: what
   * makes a runtime fail is Celld's business, and what scafo does about it is
   * this case's.
   */
  it(
    "takes an application out of the routing on the node whose process cannot become ready, and puts it back once it can",
    async () => {
      const both = await bothNodesRunning();
      expectCleanExit(
        await runCli(deployArgs(await stageApp("v1"), REFUSED, ["--replicas", "all"]), {}),
      );
      for (const node of both) await untilServes(node, hostOf(REFUSED), "v1");

      const broken = both.find((node) => node.id === REFUSING_NODE) as Node;
      const healthy = both.find((node) => node.id !== broken.id) as Node;

      const readyEverywhere = await untilReadyAndServedOnBoth(REFUSED);
      const brokenState = readyEverywhere[both.indexOf(broken)] as DaemonState;
      const brokenPort = portOf(brokenState, REFUSED);
      await untilBothUpstreams(healthy, REFUSED);

      const pid = processOf(brokenState, REFUSED)?.pid;
      if (pid === undefined) throw new Error(`${broken.id} runs no process for ${REFUSED}`);

      /* The marker first and the kill second, so the run that replaces the
         killed one is already a run that cannot get going. */
      const marker = `${REFUSE_DIR}/${REFUSED}`;
      expectCleanExit(
        await docker([
          "exec",
          broken.daemon.getId(),
          "sh",
          "-c",
          `mkdir -p ${REFUSE_DIR} && touch ${marker} && kill -9 ${String(pid)}`,
        ]),
      );
      const refusedAt = Date.now();

      const failure = await untilTakenOutOfRouting({
        broken,
        healthy,
        application: REFUSED,
        brokenPort,
      });
      /* The runtime's own words, carried in the record so nobody has to log
         into the failing machine: here, the wrapper's one line. */
      expect(failure.lastError ?? "").toContain(`refusing to start celld for ${REFUSED}`);
      const health = processesOf(await stateOf(broken), REFUSED).map((entry) => entry.health);
      expect(health, `what ${broken.id} says of its own process`).toContain("crash-looping");
      const takenOutMs = Date.now() - refusedAt;

      /* The healthy node is untouched: it keeps serving, and the failing node's
         own ingress answers for the host out of the healthy node's process. */
      const healthyRecord = await readJson<NodeRecord>(registry, nodeKey(healthy.id));
      expect(
        healthyRecord?.value.serving?.[REFUSED],
        `${healthy.id} stopped serving`,
      ).toBeDefined();
      expect(healthyRecord?.value.failing?.[REFUSED]).toBeUndefined();
      await untilServes(healthy, hostOf(REFUSED), "v1");
      await untilServes(broken, hostOf(REFUSED), "v1");

      expectCleanExit(await docker(["exec", broken.daemon.getId(), "rm", marker]));
      const clearedAt = Date.now();

      await untilBackInService(broken, REFUSED);
      await untilBothUpstreams(healthy, REFUSED);
      await untilServes(broken, hostOf(REFUSED), "v1");

      observed.refused = {
        application: REFUSED,
        brokenNode: broken.id,
        healthyNode: healthy.id,
        failing: failure,
        takenOutMs,
        backMs: Date.now() - clearedAt,
      };
    },
    REASSIGN_STEP_TIMEOUT_MS,
  );

  /*
   * ONLY AT A CELLD RELEASE: what Celld does with a lease a store corrupted is
   * upstream's, and this case is how each release is asked whether `scafo app
   * lease` is still the way out of it.
   */
  it.skipIf(!CELLD_RELEASE)(
    `takes an application out of the routing on the node whose Celld lease is truncated, and puts it back when the lease is dropped ${AT_CELLD_RELEASE}`,
    async () => {
      const both = await bothNodesRunning();
      expectCleanExit(
        await runCli(deployArgs(await stageApp("v1"), WEDGED, ["--replicas", "all"]), {}),
      );
      for (const node of both) await untilServes(node, hostOf(WEDGED), "v1");

      const broken = both[0] as Node;
      const healthy = both.find((node) => node.id !== broken.id) as Node;

      const readyEverywhere = await untilReadyAndServedOnBoth(WEDGED);
      const brokenPort = portOf(readyEverywhere[0] as DaemonState, WEDGED);
      await untilBothUpstreams(healthy, WEDGED);

      const pid = processOf(readyEverywhere[0] as DaemonState, WEDGED)?.pid;
      if (pid === undefined) throw new Error(`${broken.id} runs no process for ${WEDGED}`);

      /*
       * The process is killed first and the lease written second: a running Celld
       * renews its own lease every few seconds, so a body written under it would
       * simply be overwritten by the process this case is about.
       */
      const leaseKey = celldNodeLeaseKey(WEDGED, broken.id);
      const leaseBefore = await registry.store.get(leaseKey);
      expectCleanExit(await docker(["exec", broken.daemon.getId(), "sh", "-c", `kill -9 ${pid}`]));
      await registry.store.put(leaseKey, TRUNCATED_LEASE);
      const wedgedAt = Date.now();

      /*
       * WHAT CELLD DOES WITH IT is the question, and the answer is observed
       * rather than assumed: it may exit and be restarted for ever, or it may
       * overwrite the object and carry on. Whether it recovers by itself is what
       * decides whether `scafo app lease` is needed at all on a conforming store.
       */
      const outcome = await until(
        `${broken.id} to either report ${WEDGED} as failing or get it serving again`,
        REASSIGN_DEADLINE_MS,
        async () => {
          const record = await readJson<NodeRecord>(registry, nodeKey(broken.id));
          if (record?.value.failing?.[WEDGED] !== undefined) return "crash-looping" as const;

          const state = await stateOf(broken);
          const lease = await registry.store.get(leaseKey);
          if (processOf(state, WEDGED)?.ready === true && lease?.body !== TRUNCATED_LEASE) {
            return "recovered-on-its-own" as const;
          }
          return null;
        },
      );

      const wedged: Record<string, unknown> = {
        application: WEDGED,
        brokenNode: broken.id,
        healthyNode: healthy.id,
        leaseKey,
        leaseBefore: leaseBefore?.body ?? null,
        wrote: TRUNCATED_LEASE,
        outcome,
        observedMs: Date.now() - wedgedAt,
        celldSaid: celldLinesOn(broken, WEDGED),
      };
      observed.wedgedLease = wedged;
      console.log(
        `e2e: celld on a truncated node lease at "${leaseKey}" (SeaweedFS): ${outcome}\n` +
          String(wedged.celldSaid),
      );

      /* The healthy node is untouched in either branch: its own lease is its own
         key, and the application keeps answering there throughout. */
      const healthyRecord = await readJson<NodeRecord>(registry, nodeKey(healthy.id));
      expect(healthyRecord?.value.serving?.[WEDGED], `${healthy.id} stopped serving`).toBeDefined();
      expect(await upstreamNodes(healthy, hostOf(WEDGED))).toContain(healthy.id);
      await untilServes(healthy, hostOf(WEDGED), "v1");

      /* Each branch proves its own half — see the two functions — and BOTH end
         with the node serving the application again, which is asserted here. */
      wedged.conclusion =
        outcome === "crash-looping"
          ? await tookItOutAndTheLeaseDropPutItBack({
              broken,
              healthy,
              brokenPort,
              leaseKey,
              note: wedged,
            })
          : await celldRepairedItsOwnLease({ broken, leaseKey });

      const back = await readJson<NodeRecord>(registry, nodeKey(broken.id));
      expect(back?.value.serving?.[WEDGED], `${broken.id} never published it again`).toBeDefined();
      expect(back?.value.failing?.[WEDGED]).toBeUndefined();
      await untilBothUpstreams(healthy, WEDGED);
      await untilServes(broken, hostOf(WEDGED), "v1");
    },
    REASSIGN_STEP_TIMEOUT_MS,
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

      /* v2, because the deploy that measured peer adoption put it there: what
         this step is about is that a coordinator's death interrupts nothing the
         survivor is serving. */
      const answer = await untilServes(survivor, hostOf(APPLICATION), "v2");
      expect(JSON.parse(answer.body).version).toBe("v2");
    },
    STEP_TIMEOUT_MS,
  );

  /*
   * LATE, AND ON AN APPLICATION OF ITS OWN. It kills both nodes at once, which is
   * not a state any case before it would survive being run in.
   */
  it(
    "brings each runtime process back under its own name, directories and ports after both nodes are killed, every host answered by its own application",
    async () => {
      const both = await bothNodesRunning();
      await deployAnsweringAsItself(DURABLE, both);

      /* The two halves of what makes a restart recoverable, read off the
         process that is running: the name it will come back under, and the
         directories it is working out of. */
      const environs: Record<string, Record<string, string>> = {};
      for (const node of both) environs[node.id] = await celldEnvironOn(node, DURABLE);
      for (const node of both) {
        expect(environs[node.id], node.id).toMatchObject({
          CELLD_NODE: node.id,
          CELLD_WATCH: `${STATE_DIR}/celld/${DURABLE}/work`,
          CELLD_ASSET_CACHE_DIR: `${STATE_DIR}/celld/${DURABLE}/assets`,
        });
      }

      /* The ports every application of this suite holds on every node, read
         off the nodes themselves rather than assumed: a port that changed
         hands across a restart is a host answered by another application's
         process, whatever the routing then says. */
      const portsBefore: Record<string, Record<string, string>> = {};
      for (const node of both) portsBefore[node.id] = await portsOn(node);
      for (const node of both) {
        expect(Object.keys(portsBefore[node.id] ?? {}), node.id).toContain(DURABLE);
      }

      /* A write through each node, so the fleet has had something to put on
         the follower disk; what the counter answers is Celld's. */
      for (const node of both) await countOnce(node, DURABLE);

      /* The work directory is the follower disk, on the state volume mounted
         at STATE_DIR; a fleet that has taken writes has put something in it. */
      const held: Record<string, number> = {};
      for (const node of both) {
        held[node.id] = await workDirEntriesOn(node, DURABLE);
        expect(held[node.id], `${node.id} wrote nothing under ${STATE_DIR}`).toBeGreaterThan(0);
      }

      await killBoth(both);
      const restartedAt = Date.now();
      await bothNodesRunning();

      /* Every application comes back on the ports it had, so the `serving` the
         node record still carries from before the kill is CORRECT: nothing had
         to be re-announced for a peer or an ingress to route rightly. */
      for (const node of both) {
        const kept = portsBefore[node.id] ?? {};
        const back = await until(
          `${node.id} to run its applications again`,
          REASSIGN_DEADLINE_MS,
          async () => {
            const now = await portsOn(node);
            return Object.keys(kept).every((application) => application in now) ? now : null;
          },
        );
        for (const [application, pair] of Object.entries(kept)) {
          expect(back[application], `${node.id} moved ${application} across the restart`).toBe(
            pair,
          );
        }
      }

      /* Asked of each node who is answering: a host answered by another
         application's process is the one thing a port that changed hands
         would show. */
      const misdelivered: string[] = [];
      for (const node of both) {
        await until(`${node.id} to answer ${hostOf(DURABLE)} as itself`, REASSIGN_DEADLINE_MS, () =>
          answersAsItself(node, DURABLE, misdelivered),
        );
      }

      observed.restart = {
        application: DURABLE,
        portsBefore: JSON.stringify(portsBefore),
        killed: both.map((node) => node.id),
        answeringAgainMs: Date.now() - restartedAt,
        workDirEntriesBefore: held,
        celldEnv: environs,
      };
      expect(misdelivered, "a host was answered by another application's process").toEqual([]);
    },
    REASSIGN_STEP_TIMEOUT_MS,
  );

  /*
   * LAST, ON AN APPLICATION OF ITS OWN, AND ONLY AT A CELLD RELEASE. Whether a
   * write a peer acknowledged before the bucket had it survives both nodes dying
   * is Celld's durability; what scafo owns of it — the name, the directories and
   * the ports a process comes back to — is the case before this one. It freezes
   * the bucket under both nodes, which no case before it would survive.
   */
  it.skipIf(!CELLD_RELEASE)(
    `gives back the write it acknowledged while the bucket was frozen, after both nodes were killed ${AT_CELLD_RELEASE}`,
    async () => {
      const both = await bothNodesRunning();
      await deployAnsweringAsItself(ACKED, both);
      /* The counter's cell belongs to whichever node activates it first. It is
         activated on the SECOND node, and every request below goes through the
         first: the acknowledged write then exists on the asking node's follower
         disk only, and after the restart the cell has to come back through a
         node that never owned it — the harder of the two recoveries. */
      await untilCellAnswers(both[1], ACKED);
      await untilCellAnswers(both[0], ACKED);

      const warmUp: number[] = [];
      for (let round = 0; round < 2; round++) {
        for (const node of both) warmUp.push(await countOnce(node, ACKED));
      }
      for (let i = 1; i < warmUp.length; i++) expect(warmUp[i]).toBe((warmUp[i - 1] as number) + 1);

      /* Long enough that the only write whose fate is in question is the one
         taken while the bucket is frozen. */
      await delay(BUCKET_UPLOAD_SETTLE_MS);

      /* The route to the counter's cell is resolved from the bucket when the
         node taking the request does not already hold it, and this case is
         about the WRITE rather than about that lookup: `/peek` resolves it
         here, where the bucket still answers, and writes nothing. */
      await untilCellAnswers(both[0], ACKED);

      const frozenAt = Date.now();
      expectCleanExit(await docker(["pause", store.getId()]));
      let acknowledged: number;
      try {
        acknowledged = await countOnce(both[0], ACKED);
        await killBoth(both);
      } finally {
        expectCleanExit(await docker(["unpause", store.getId()]));
      }
      const frozenMs = Date.now() - frozenAt;
      await untilStoreTakesWrites();

      expect(acknowledged).toBe((warmUp.at(-1) as number) + 1);
      /* A runtime process fences itself ten seconds after it last reached the
         bucket, so a longer freeze would be testing something else. */
      expect(frozenMs, "the bucket was frozen for too long to be this case").toBeLessThan(
        FROZEN_BUDGET_MS,
      );

      const restartedAt = Date.now();
      await bothNodesRunning();

      const misdelivered: string[] = [];
      const serving = await until(
        `${ACKED} to be served again by a node that has its cell`,
        REASSIGN_DEADLINE_MS,
        async () => {
          for (const node of both) {
            /* Asked who is answering before it is asked for the number: a host
               answered by another application's process would hand back THAT
               application's counter, and no recovery could be judged by it. */
            if ((await answersAsItself(node, ACKED, misdelivered)) === null) continue;
            const answer = await httpGet(node.httpPort, "/peek", { host: hostOf(ACKED) });
            if (answer.status === 200 && typeof countOf(answer.body) === "number") return node;
          }
          return null;
        },
      );
      const recoveredMs = Date.now() - restartedAt;

      /* The whole case, in one number: the next write the fleet takes follows
         the one it acknowledged, rather than repeating it. */
      const next = await countOnce(serving, ACKED);

      observed.durability = {
        application: ACKED,
        warmUp,
        acknowledgedWhileFrozen: acknowledged,
        frozenMs,
        killed: both.map((node) => node.id),
        recoveredMs,
        servedBy: serving.id,
        next,
      };
      console.log(
        `e2e: acknowledged n=${String(acknowledged)} with the bucket frozen; after both nodes ` +
          `were killed and restarted the next count was n=${String(next)}`,
      );

      if (misdelivered.length > 0) {
        console.log(
          `e2e: ${String(misdelivered.length)} answers for ${hostOf(ACKED)} came from ANOTHER ` +
            `application after the restart, e.g. ${misdelivered[0] ?? ""}`,
        );
      }
      if (next !== acknowledged + 1) {
        /* What the runtime said about its own recovery is the only account of
           why a write is missing, and the containers are gone once this fails. */
        for (const node of both) {
          const logs = await docker(["logs", node.daemon.getId()]);
          const told = logs.output
            .split("\n")
            .filter((line) =>
              /node_log|recover|predecessor|fenc|bounded loss|discard|WARN|ERROR|Counter|cell|restor|activat|epoch|404|NoSuchKey/i.test(
                line,
              ),
            )
            .slice(-120)
            .join("\n");
          console.log(`e2e: ${node.id} on its own recovery:\n${told}`);
        }
        /* Whether the missing state is gone or only elsewhere: both nodes asked
           again, half a minute on, without writing. */
        await delay(30_000);
        for (const node of both) {
          const later = await httpGet(node.httpPort, "/peek", { host: hostOf(ACKED) });
          console.log(`e2e: ${node.id} peeks ${later.body} thirty seconds later`);
        }
        const keys = await registry.store.list(`fleets/${ACKED}/`);
        console.log(
          `e2e: bucket holds ${String(keys.length)} keys for ${ACKED}:\n${keys.slice(0, 80).join("\n")}`,
        );
      }
      expect(next, "an acknowledged write was lost across the restart").toBe(acknowledged + 1);
      expect(misdelivered, "a host was answered by another application's process").toEqual([]);
    },
    REASSIGN_STEP_TIMEOUT_MS,
  );
});

/**
 * Every node of this suite up and answering, started again where a case stopped
 * or killed it. Cases deliberately stop nodes and leave them stopped; the ones
 * that need both ask for them here.
 */
async function bothNodesRunning(): Promise<Node[]> {
  for (const node of nodes) {
    if (node.running) continue;
    expectCleanExit(await docker(["start", node.daemon.getId()]));
    node.running = true;
  }
  for (const node of nodes) {
    await until(`${node.id} to answer health`, REASSIGN_DEADLINE_MS, async () => {
      const answer = await httpGet(node.apiPort, "/.well-known/scafo/health", {});
      return answer.status === 200 ? answer : null;
    });
  }
  return nodes;
}

/**
 * Waits until the bucket has taken writes without interruption for
 * {@link STORE_AWAKE_WINDOW_MS}.
 *
 * SeaweedFS answers its S3 port throughout a `docker pause`, but its master
 * evicts the volume server whose heartbeat went stale while it was frozen and
 * then refuses writes with "no available server" until it registers again —
 * seconds AFTER the unpause, so one write that succeeds is not the store being
 * back. That is the store recovering, not the fleet, and a node restarted into
 * it fails for a reason this case is not about.
 */
async function untilStoreTakesWrites(): Promise<void> {
  const key = "_e2e-store-awake";
  let since: number | null = null;

  await until("the bucket to take writes again", DEADLINE_MS, async () => {
    try {
      await registry.store.put(key, "awake");
      since ??= Date.now();
    } catch (error) {
      since = null;
      throw error;
    }
    return Date.now() - since >= STORE_AWAKE_WINDOW_MS ? true : null;
  });
  await registry.store.del(key).catch(() => {});
}

/** SIGKILLs both daemons at once: nothing is released and nothing is drained. */
async function killBoth(both: Node[]): Promise<void> {
  expectCleanExit(await docker(["kill", "-s", "KILL", ...both.map((node) => node.daemon.getId())]));
  for (const node of both) node.running = false;
}

/**
 * Deploys `application` to both nodes with its own name as a variable, and waits
 * until each answers for it with that name.
 *
 * Every other application of the suite answers `/` with the fixture's default,
 * so an answer for this host says WHICH application's process produced it, and
 * that a `--var` reached the runtime.
 */
async function deployAnsweringAsItself(application: string, both: Node[]): Promise<void> {
  expectCleanExit(
    await runCli(
      deployArgs(
        await stageApp("v1"),
        application,
        ["--replicas", "all", "--var", `GREETING:${application}`],
        both[0],
      ),
      {},
    ),
  );
  const misdelivered: string[] = [];
  for (const node of both) {
    await until(`${node.id} to answer ${hostOf(application)} as itself`, DEADLINE_MS, () =>
      answersAsItself(node, application, misdelivered),
    );
  }
  expect(misdelivered, "a host was answered by another application's process").toEqual([]);
}

/**
 * `node`'s answer for `application`'s host when it came from that application's
 * own process; null otherwise, noting in `misdelivered` an answer that came from
 * another application's.
 */
async function answersAsItself(
  node: Node,
  application: string,
  misdelivered: string[],
): Promise<HttpAnswer | null> {
  const front = await httpGet(node.httpPort, "/", { host: hostOf(application) });
  if (front.status !== 200) return null;
  if (!front.body.includes(`"greeting":"${application}"`)) {
    misdelivered.push(`${node.id}: ${front.body}`);
    return null;
  }
  return front;
}

/** One `/count`, which is one write; the number it answered with. */
async function countOnce(node: Node, application: string): Promise<number> {
  const answer = await httpGet(node.httpPort, "/count", { host: hostOf(application) });
  expectStatus(answer, 200);
  const n = countOf(answer.body);
  if (n === null) throw new Error(`${node.id} answered /count with ${answer.body}`);
  return n;
}

/** Waits until the counter's cell answers, WITHOUT counting: see the fixture's `/peek`. */
async function untilCellAnswers(node: Node, application: string): Promise<void> {
  await until(`${node.id} to answer for the counter cell`, DEADLINE_MS, async () => {
    const answer = await httpGet(node.httpPort, "/peek", { host: hostOf(application) });
    return answer.status === 200 && typeof countOf(answer.body) === "number" ? answer : null;
  });
}

/**
 * The ports each application is served on by `node`, as the node itself reports
 * them: `"<public>/<internal>"` per application name.
 */
async function portsOn(node: Node): Promise<Record<string, string>> {
  const processes = (await stateOf(node)).reconcile?.processes ?? [];
  return Object.fromEntries(
    processes.map((entry) => [
      entry.application,
      `${String(entry.port)}/${String(entry.internalPort)}`,
    ]),
  );
}

/** The environment of the runtime process `node` runs for `application`. */
async function celldEnvironOn(node: Node, application: string): Promise<Record<string, string>> {
  const process = (await stateOf(node)).processes.find((entry) => runs(entry, application));
  if (process?.pid === undefined) {
    throw new Error(`${node.id} runs no process for ${application}`);
  }

  /* Read off the RUNNING process rather than off a spec: a variable the node
     derived but never handed over would read the same in a spec. */
  const read = await docker([
    "exec",
    node.daemon.getId(),
    "cat",
    `/proc/${String(process.pid)}/environ`,
  ]);
  expectCleanExit(read);

  const environ: Record<string, string> = {};
  for (const entry of read.output.split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) environ[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return environ;
}

/** How many entries the work directory of one application holds on `node`. */
async function workDirEntriesOn(node: Node, application: string): Promise<number> {
  const listed = await docker([
    "exec",
    node.daemon.getId(),
    "ls",
    "-A",
    `${STATE_DIR}/celld/${application}/work`,
  ]);
  expectCleanExit(listed);
  return listed.output.split("\n").filter((line) => line.trim() !== "").length;
}

/** Whether `node` still keeps `application`'s local state directory. */
async function holdsLocalState(node: Node, application: string): Promise<boolean> {
  const found = await docker([
    "exec",
    node.daemon.getId(),
    "test",
    "-d",
    `${STATE_DIR}/celld/${application}`,
  ]);
  /* Only `test`'s own two answers: an exec that failed is no answer at all. */
  if (found.code !== 0 && found.code !== 1) {
    throw new Error(`${node.id} could not be asked about ${application}: ${found.output}`);
  }
  return found.code === 0;
}

/** One docker command, run the way every other step of this suite runs one. */
function docker(args: string[]): Promise<CommandResult> {
  return run("docker", args, REPO_ROOT, { PATH: env.PATH ?? "" });
}

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
 * every registration, so it is set here and nowhere else. `celldBin` is the
 * Celld the node runs, through the setting an operator has for it.
 */
async function startNode(
  id: string,
  opts: { labels?: string; celldBin?: string } = {},
): Promise<Node> {
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

  const stateDir = await mkdtemp(join(tmpdir(), `scafo-e2e-state-${id}-`));
  /* Written from inside the container by uid 10001, which owns nothing here. */
  await chmod(stateDir, STATE_DIR_MODE);

  const daemon = await startExplained(
    new GenericContainer(NODE_IMAGE)
      .withNetworkMode(`container:${ingress.getId()}`)
      .withBindMounts([
        { source: REPO_ROOT, target: "/work", mode: "ro" },
        { source: stateDir, target: STATE_DIR, mode: "rw" },
      ])
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
        SCAFO_STATE_DIR: STATE_DIR,
        SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
        SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
        /* What the peers dial: the fleet document's upstreams are this address. */
        SCAFO_ADVERTISE: `${bridgeAddress}:${String(NODE_PORT)}`,
        SCAFO_BIND_HOST: "0.0.0.0",
        SCAFO_COORDINATOR_LEASE_TTL_MS: String(LEASE_TTL_MS),
        CELLD_ESBUILD: "/usr/local/bin/esbuild",
        ...(opts.labels === undefined ? {} : { SCAFO_NODE_LABELS: opts.labels }),
        ...(opts.celldBin === undefined ? {} : { SCAFO_CELLD_BIN: opts.celldBin }),
      })
      .withCommand([
        "node",
        "dist/cli/index.mjs",
        "sail",
        "--listen",
        `0.0.0.0:${String(NODE_PORT)}`,
      ])
      .withLogConsumer(collectLogs(log))
      .withWaitStrategy(Wait.forLogMessage(/listening on/))
      .withStartupTimeout(BOOT_DEADLINE_MS),
    { log, what: `node ${id}` },
  );

  return {
    id,
    ingress,
    daemon,
    stateDir,
    bridgeAddress,
    httpPort: ingress.getMappedPort(TRAEFIK_HTTP_PORT),
    apiPort: ingress.getMappedPort(NODE_PORT),
    log,
    running: true,
  };
}

/** The host one application is served at under the platform domain. */
function hostOf(application: string): string {
  return `${application}.${PLATFORM_DOMAIN}`;
}

/** Whether a process on a node is one serving {@link TARGETED}. */
function runsTargeted(process: ProcessStatus): boolean {
  return runs(process, TARGETED);
}

/** Whether a process on a node is one serving {@link SOLO}. */
function runsSolo(process: ProcessStatus): boolean {
  return runs(process, SOLO);
}

/** Whether a process on a node is one serving {@link SUNSET}. */
function runsSunset(process: ProcessStatus): boolean {
  return runs(process, SUNSET);
}

/** Whether `process` is the running runtime of `application`. */
function runs(process: ProcessStatus, application: string): boolean {
  return process.state === "running" && process.id === application;
}

/** One `scafo app <action>` run from the host against `node`'s node API. */
function appArgs(action: string, application: string, node: Node, extra: string[] = []): string[] {
  return [
    "app",
    action,
    "--name",
    application,
    "--node",
    `http://127.0.0.1:${String(node.apiPort)}`,
    "--key",
    keyPath,
    ...extra,
  ];
}

/**
 * Waits until both nodes run `application` as a ready process and publish it in
 * their records' `serving`: the state the readiness cases take one node out of.
 * Answers both states, in the order of {@link nodes}.
 */
async function untilReadyAndServedOnBoth(application: string): Promise<DaemonState[]> {
  return until(
    `both nodes to publish ${application} as ready and served`,
    DEADLINE_MS,
    async () => {
      const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
      if (!states.every((state) => processOf(state, application)?.ready === true)) return null;
      const records = await Promise.all(
        nodes.map(async (node) => readJson<NodeRecord>(registry, nodeKey(node.id))),
      );
      return records.every((record) => record?.value.serving?.[application] !== undefined)
        ? states
        : null;
    },
  );
}

/**
 * Waits until the routing `node` renders names BOTH nodes as answering for
 * `application`'s host.
 *
 * WAITED FOR RATHER THAN ASSERTED. A node's own `serving` reaches the document it
 * renders only once its beat has landed and its registry view has re-read the
 * node records, which is a reconcile interval away.
 */
async function untilBothUpstreams(node: Node, application: string): Promise<void> {
  await until(
    `the routing ${node.id} renders to name both nodes for ${hostOf(application)}`,
    DEADLINE_MS,
    async () => {
      const named = await upstreamNodes(node, hostOf(application));
      return named.length === 2 && named[0] === NODE_A && named[1] === NODE_B ? named : null;
    },
  );
}

/**
 * Waits until `broken` says it cannot keep `application` running and the fleet's
 * routing has stopped sending its host there; answers what the record says.
 *
 * The node reports the application under `failing` and takes it out of
 * `serving`, and the routing the healthy node renders names that node alone,
 * with nothing anywhere routed to the port that answers nothing.
 */
async function untilTakenOutOfRouting(opts: {
  broken: Node;
  healthy: Node;
  application: string;
  /** The port the failing process held, which nothing may still be routed to. */
  brokenPort: number;
}): Promise<NodeFailure> {
  const { broken, healthy, application } = opts;

  const failingRecord = await until(
    `${broken.id} to drop ${application} from what it serves`,
    REASSIGN_DEADLINE_MS,
    async () => {
      const record = await readJson<NodeRecord>(registry, nodeKey(broken.id));
      if (record === null) return null;
      if (record.value.failing?.[application] === undefined) return null;
      return record.value.serving?.[application] === undefined ? record.value : null;
    },
  );
  const failure = failingRecord.failing?.[application] as NodeFailure;
  expect(failure.restarts).toBeGreaterThanOrEqual(3);

  const withoutBroken = await until(
    `the fleet routing to stop naming ${broken.id} for ${hostOf(application)}`,
    DEADLINE_MS,
    async () => {
      const named = await upstreamNodes(healthy, hostOf(application));
      return named.includes(broken.id) ? null : named;
    },
  );
  expect(withoutBroken).toEqual([healthy.id]);

  /* Matched with the broken node's address: each node draws its ports on its
     own, so the peer may serve a healthy application on the same port number. */
  const document = await routingOf(healthy);
  const addresses = document.routes.flatMap((route) =>
    route.upstreams.map((upstream) => upstream.address),
  );
  const deadAddress = `${broken.bridgeAddress}:${String(opts.brokenPort)}`;
  expect(
    addresses.filter((address) => address === deadAddress),
    "a dead port is still routed to",
  ).toEqual([]);

  return failure;
}

/**
 * Waits until `node` runs `application` as a ready process again, publishes it
 * in `serving`, and no longer reports it under `failing`.
 */
async function untilBackInService(node: Node, application: string): Promise<void> {
  await until(
    `${node.id} to get ${application} ready and published again`,
    REASSIGN_DEADLINE_MS,
    async () => {
      const state = await stateOf(node);
      if (processOf(state, application)?.ready !== true) return null;
      const record = await readJson<NodeRecord>(registry, nodeKey(node.id));
      if (record?.value.serving?.[application] === undefined) return null;
      return record.value.failing?.[application] === undefined ? record.value : null;
    },
  );
}

/**
 * Celld read the truncated lease, replaced it, and carried on: nothing had to be
 * dropped, and what scafo reported was the transient absence it should be.
 */
async function celldRepairedItsOwnLease(opts: { broken: Node; leaseKey: string }): Promise<string> {
  const lease = await registry.store.get(opts.leaseKey);
  expect(lease?.body, "the lease Celld wrote over the truncated one").not.toBe(TRUNCATED_LEASE);
  expect(lease?.body, "Celld left the truncated lease and still came up").toContain("expires_ms");

  return (
    `celld recovered from a truncated node lease at "${opts.leaseKey}" without help, ` +
    `so "scafo app lease drop" was not needed on this store`
  );
}

/**
 * Celld could not get past the lease. The node says what it cannot keep running,
 * takes the application out of what it serves, and the routing the fleet
 * publishes stops naming that node's port for the host — and then the operator's
 * own `scafo app lease drop`, run as the real CLI against this bucket, is what
 * gets the process serving again.
 */
async function tookItOutAndTheLeaseDropPutItBack(opts: {
  broken: Node;
  healthy: Node;
  /** The port the wedged process held, which nothing may still be routed to. */
  brokenPort: number;
  leaseKey: string;
  /** Raw observations this branch adds to the report. */
  note: Record<string, unknown>;
}): Promise<string> {
  const { broken, healthy, note } = opts;

  note.failing = await untilTakenOutOfRouting({
    broken,
    healthy,
    application: WEDGED,
    brokenPort: opts.brokenPort,
  });

  /* The operator's own hands, through the REAL CLI against this bucket. */
  const shown = await runCli(
    ["app", "lease", "show", "--name", WEDGED, "--node", broken.id, "--json"],
    storeEnv(),
  );
  expectCleanExit(shown);
  /* The key it diagnosed, always; WHAT it made of the body is an observation the
     report carries rather than something this case dictates to Celld. */
  expect(shown.output).toContain(opts.leaseKey);
  note.leaseShow = shown.output.trim().slice(0, 1200);

  const dropped = await runCli(
    ["app", "lease", "drop", "--name", WEDGED, "--node", broken.id, "--yes"],
    storeEnv(),
  );
  expectCleanExit(dropped);
  expect(dropped.output).toContain(opts.leaseKey);
  note.leaseDrop = dropped.output.trim().slice(0, 1200);

  const droppedAt = Date.now();
  await untilBackInService(broken, WEDGED);
  note.recoveredAfterDropMs = Date.now() - droppedAt;

  return (
    `celld could not recover from a truncated node lease at "${opts.leaseKey}" by ` +
    `itself; "scafo app lease drop" is what got the process serving again`
  );
}

/** Every entry a node's `/v1/state` lists for an application, whatever its state. */
function processesOf(state: DaemonState, application: string): SupervisedProcess[] {
  return state.processes.filter((entry) => entry.id === application);
}

/** One node's running process for an application, as `/v1/state` reports it. */
function processOf(state: DaemonState, application: string): SupervisedProcess | undefined {
  return state.processes.find((entry) => entry.id === application && entry.state === "running");
}

/** The public port a node's reconcile loop says it serves an application on. */
function portOf(state: DaemonState, application: string): number {
  const found = (state.reconcile?.processes ?? []).find(
    (entry) => entry.application === application,
  );
  if (found === undefined) throw new Error(`no process for ${application}`);
  return found.port;
}

/** The fleet's routing as one node renders it, read the way an ingress reads it. */
async function routingOf(node: Node): Promise<FleetRouting> {
  const answer = await httpGet(node.apiPort, "/v1/ingress/routes", {
    authorization: `Bearer ${INGRESS_TOKEN}`,
  });
  if (answer.status !== 200) {
    throw new Error(
      `${node.id} answered the routing with ${String(answer.status)}: ${answer.body}`,
    );
  }
  return JSON.parse(answer.body) as FleetRouting;
}

/** The nodes that routing names as answering for one host, in the order it names them. */
async function upstreamNodes(node: Node, host: string): Promise<string[]> {
  const document = await routingOf(node);
  const route = document.routes.find((entry) => entry.host === host);
  return (route?.upstreams ?? []).map((upstream) => upstream.node).sort();
}

/**
 * What the wedged node's own log says about one application, which is the only
 * account of what Celld did with the object put under it.
 */
function celldLinesOn(node: Node, application: string, limit: number = 40): string {
  return node.log
    .join("")
    .split("\n")
    .filter(
      (line) =>
        line.includes(application) ||
        /lease|authority|node_log|fenc|expired|ERROR|WARN|panic|exited with code/i.test(line),
    )
    .slice(-limit)
    .join("\n");
}

/** The nodes a state says an application was placed on, or null when it has no decision. */
function placedNodes(state: DaemonState, application: string): string[] | null {
  const placed = state.placements.find((view) => view.application === application);
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
  application: string,
  extra: string[] = [],
  via: Node = nodes[0],
): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(via.apiPort)}`,
    "--name",
    application,
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

function deploymentOf(output: string): string {
  const version = /scafo: deployment ([\da-f]{8,64})/.exec(output)?.[1];
  if (version === undefined) throw new Error(`the deploy named no deployment:\n${output}`);
  return version;
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
