/*
 * Two nodes of one installation against real infrastructure: one SeaweedFS
 * bucket holding the registry, and two Caddy+daemon pairs that have never been
 * told about each other. Everything they agree on, they agree on through the
 * bucket.
 *
 * The topology mirrors two real VPSes. Each Caddy and its daemon SHARE a network
 * namespace, exactly as in the single-node suite, so a node's runtime processes
 * are reached by its own ingress over loopback. What is new here is that the two
 * PAIRS are separate containers with separate addresses on the docker bridge:
 * anything the nodes do to each other has to cross a network, which is the whole
 * point of running two of them.
 *
 * Skipped unless SCAFO_E2E=1, because it is minutes rather than seconds:
 *
 *   SCAFO_E2E=1 pnpm vitest run test/integration/e2e-multinode.test.ts
 *
 * Every assertion polls until a deadline, and any timeout dumps BOTH daemons'
 * container logs — with two nodes, the account of what went wrong is as often on
 * the other one.
 *
 * NOTE on `SCAFO_BIND_HOST`: runtime processes bind loopback by default, which
 * no peer on another host can reach. Cross-node cell traffic therefore needs
 * them bound wider, and because that exposes an unauthenticated peer listener it
 * only happens where the operator has classified the network — `SCAFO_TRANSPORT`
 * below is that statement.
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
const CADDY_IMAGE = "caddy:2";
/** node24 + celld + esbuild; the same image the single-node suite needs. */
const NODE_IMAGE = "scafo-probe";

const STORE_PORT = 8333;
const CADDY_HTTP_PORT = 80;
const CADDY_ADMIN_PORT = 2019;
/** Published on each Caddy container, because its daemon has no network of its own. */
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
/** Long enough that only the explicit deletion ever removes it. */
const PREVIEW_IDLE_TTL_S = 3600;
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
 * Deployed under a node selector only ONE node satisfies, then let loose again.
 *
 * Which node that is, is not rendezvous hashing's decision here but the
 * operator's: node-b boots carrying {@link FAST_LABEL} and node-a carries no
 * label at all, so `--node-selector tier=fast --replicas all` has exactly one
 * eligible node however the digests fall.
 */
const TARGETED = "targeted";

/** The label node-b boots with, and the one {@link TARGETED} selects on. */
const FAST_LABEL = "tier=fast";

/**
 * Deployed THROUGH the node that cannot run it, under the same selector.
 *
 * The point is the deploy's own watch rather than the placement: a deploy is
 * held open until a process serving the build is ready, and the node
 * holding it open is not the node that starts it.
 */
const AWAITED = "awaited";

/** Deployed to both nodes, retired out of service, then force-deleted. */
const SUNSET = "sunset";
/** Claimed for {@link SUNSET}, so its deletion has a claim to release too. */
const SUNSET_DOMAIN = "sunset.example.test";

const NODE_A = "node-a";
const NODE_B = "node-b";

/* See the single-node suite: a user-defined network would make published ports
   answer from the wrong address, and the default bridge gives both what is
   needed — the containers reach each other, and the host reaches the ports. */
const BRIDGE_NETWORK = "bridge";

const SETUP_TIMEOUT_MS = 420_000;
const STEP_TIMEOUT_MS = 180_000;
/** Per-assertion ceiling; the reconcile interval is 5s, so this is many passes. */
const DEADLINE_MS = 120_000;
const BOOT_DEADLINE_MS = 60_000;
const STORE_DEADLINE_MS = 120_000;
const POLL_MS = 500;
/**
 * Ceiling for a reassignment that follows a node DYING.
 *
 * Longer than the others on purpose, and the arithmetic is the design: a killed
 * node keeps its last heartbeat, and stays live for three heartbeat intervals
 * (90s) after it. Only then may the coordinator hand its environments to anyone
 * — counting a node out sooner would move work off nodes that are merely slow.
 * So this covers that window, the coordinator tick that follows it, and the
 * reconcile pass and process start after that.
 */
const REASSIGN_DEADLINE_MS = 240_000;
const REASSIGN_STEP_TIMEOUT_MS = 300_000;
/**
 * Ceiling for a reassignment that follows a node being asked to STOP.
 *
 * The arithmetic is the whole claim draining makes: the node writes `drainingAt`
 * before it stops anything, so the coordinator counts it out on its next
 * assignment tick (a third of the 15s lease TTL) rather than after the 90s
 * liveness window. What is left is the shutdown itself, that tick, the
 * survivor's next reconcile pass (5s) and a process start with its readiness
 * gate. Generous for all of that, and still comfortably inside the window a
 * crash cannot beat.
 */
const GRACEFUL_DRAIN_BUDGET_MS = 60_000;

/** The lease TTL the daemon runs with; failover is bounded by a few of these. */
const LEASE_TTL_MS = 15_000;

/** One node: its ingress, its daemon, and everything the host needs to reach both. */
interface Node {
  id: string;
  caddy: StartedTestContainer;
  daemon: StartedTestContainer;
  /** Address the OTHER containers reach this pair at. */
  bridgeAddress: string;
  httpPort: number;
  adminPort: number;
  apiPort: number;
  /** Everything the daemon container has written, kept for failure messages. */
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
    /* Built first: the daemon containers run `dist/` off the bind-mounted
       worktree, so a stale build would test the previous commit. */
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

    /* Started one after the other rather than together: the first node to
       arrive bootstraps the registry, and a second one racing that bootstrap is
       a different test than this one.

       Only node-b is labelled, so the two are genuinely different KINDS of node
       — which is what a heterogeneous fleet is, and what a selector is for. */
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
      /* Stopped before its Caddy: the daemon lives in Caddy's namespace. */
      await node.daemon.stop().catch(() => {});
      await node.caddy.stop().catch(() => {});
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
          `${node.id} to answer /v1/health`,
          BOOT_DEADLINE_MS,
          async () => {
            const answer = await httpGet(node.apiPort, "/v1/health", {});
            return answer.status === 200 ? answer : null;
          },
        );
        expect(JSON.parse(health.body)).toMatchObject({ ok: true, node: node.id });
      }

      /* Two records, not one: the nodes share a bucket and nothing else, so a
         second node overwriting the first's entry would be invisible until
         something tried to reach it. */
      expect(await listNodes(registry)).toEqual(expect.arrayContaining([NODE_A, NODE_B]));

      for (const node of nodes) {
        const record = await readJson<NodeRecord>(registry, nodeKey(node.id));
        /* What makes one node reachable from the other, and therefore what the
           coordinator hop is addressed to. */
        expect(record?.value.addresses, node.id).toEqual({
          internal: node.bridgeAddress,
          apiPort: NODE_PORT,
        });
      }
      /* What the operator said each node IS, written from its own configuration
         on every registration. Only node-b was told anything, and a node told
         nothing carries no labels rather than an empty set — which is what makes
         it satisfy no selector at all. */
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
      expect(result.output, daemonLogTail()).toContain("routed");
      buildV1 = buildIdOf(result.output);
      observed.buildV1 = buildV1;

      /*
       * The deploy was accepted by node-a alone. Node-b learns what to serve
       * from the registry and starts its own process for it, so both ingresses
       * answer for the same host — which is what a second node is for.
       */
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
      /* Both processes have to be up and peered before the counter means
         anything; the first answer from each node is what says they are. */
      for (const node of nodes) {
        await until(`${node.id} to answer /count`, DEADLINE_MS, async () => {
          const answer = await httpGet(node.httpPort, "/count", { host: envHost() });
          return answer.status === 200 && typeof countOf(answer.body) === "number" ? answer : null;
        });
      }

      /*
       * The assertion this whole topology exists for. One cell owns the counter;
       * a request that lands on the node that does not own it is routed to the
       * one that does, over the peer listeners. Two independent counters — the
       * failure this catches — would repeat numbers instead of climbing.
       */
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
      /* Consecutive, in fact: nothing else is calling it, so a gap would mean a
         request went somewhere this test cannot see. */
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
      /* Both nodes read the same lease, so they agree on who it names — the one
         answering is simply the only one that says `self`. */
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
      /* Created from the host so it is ephemeral from the start: `ephemeral` is
         part of an environment's identity and a deploy would have made a
         long-lived one. The idle window is long, so nothing but this test's own
         request ever deletes it. */
      await createEnvironment(registry, PROJECT, {
        name: PREVIEW,
        ephemeral: true,
        idleTtlS: PREVIEW_IDLE_TTL_S,
      });
      /*
       * `--replicas all` because an ephemeral environment otherwise defaults to
       * ONE node, and this step is about the proxied delete rather than about
       * placement: the node the deletion is asked of has to be one that actually
       * runs a process for it. It also puts the flag itself through the CLI
       * against an environment that already exists.
       */
      expectCleanExit(
        await runCli(deployArgs(await stageApp("v1"), PREVIEW, ["--replicas", "all"]), {}),
      );

      const coordinator = await coordinatorNode();
      const asked = nodes.find((node) => node.id !== coordinator.id) as Node;
      /* A process for it must exist somewhere before the deletion is worth
         anything: it is what the reap has to take away afterwards. */
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

      /* The node the operator asked does not hold the lease and cannot delete
         anything; it forwarded the request and handed back what came out. */
      expectStatus(answer, 200);
      expect(JSON.parse(answer.body).deleted).toContain(environmentKey(PROJECT, PREVIEW));
      /* Gone from the bucket, which is the only place it ever existed. */
      expect(await readJson(registry, environmentKey(PROJECT, PREVIEW))).toBeNull();

      /* And the nodes converge on it: an environment that is gone from the
         registry is one nothing should still be running a process for. */
      const reapedAt = Date.now();
      for (const node of nodes) {
        await until(`${node.id} to stop running ${PREVIEW}`, DEADLINE_MS, async () => {
          const state = await stateOf(node);
          const running = state.processes.filter(
            (process) =>
              process.state === "running" && process.id.startsWith(`${PROJECT}--${PREVIEW}--`),
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
      /*
       * The multi-cloud story, at two nodes. node-b booted carrying
       * `tier=fast`; node-a carries nothing. So which node runs this is the
       * OPERATOR's decision here rather than rendezvous hashing's, and
       * `--replicas all` means every MATCHING node rather than every node —
       * the selector narrows the candidates before the replica count is read.
       */
      const labelled = nodes.find((node) => node.id === NODE_B) as Node;
      const plain = nodes.find((node) => node.id === NODE_A) as Node;

      /* Deployed through the labelled node, which is the shortest path to a
         running build and no longer the constraint it once was: a deploy
         now watches the node its placement named, wherever the upload landed.
         The case below is about exactly that; this one is about the selector. */
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

      /* Both nodes read the same decision out of the same bucket, and it names
         the labelled node alone. */
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

      /* The labelled node's own ingress serves it. */
      const served = await untilServes(labelled, targetedHost(), "v1");
      expect(JSON.parse(served.body).version).toBe("v1");

      /* And the unlabelled one runs no process for it — and still answers for
         it: the host lands on its daemon, which forwards the held request to the
         labelled node. A selector decides where a process may run, never which
         door reaches it. */
      await until(`${plain.id} to run nothing for ${TARGETED}`, DEADLINE_MS, async () => {
        const state = await stateOf(plain);
        return state.processes.some(runsTargeted) ? null : state;
      });
      const forwarded = await until(
        `${plain.id} to forward ${TARGETED} to the labelled node`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(plain.httpPort, "/", { host: targetedHost() });
          return answer.status === 200 && answer.body.includes('"v1"') ? answer : null;
        },
      );
      expect(JSON.parse(forwarded.body).version).toBe("v1");
      expect((await stateOf(plain)).processes.some(runsTargeted)).toBe(false);

      /* The constraint is reported beside the decision, so an operator looking at
         a one-node placement can see that one node is what was asked for. */
      const view = (await stateOf(plain)).placements.find(
        (entry) => entry.project === PROJECT && entry.env === TARGETED,
      );
      expect(view?.selector).toEqual({ tier: "fast" });

      /*
       * Lifting the constraint, asked of the node that is NOT running it: a
       * selector change is a plain record update any node carries out, and it
       * takes effect on the coordinator's next assignment pass rather than here.
       */
      const clearedAt = Date.now();
      const cleared = await runCli(envArgs("selector", TARGETED, plain, ["--clear"]), {});
      expectCleanExit(cleared);
      expect(cleared.output).toContain("no nodes any more");

      await until(`${TARGETED} to spread to both nodes`, DEADLINE_MS, async () => {
        const states = await Promise.all(nodes.map(async (node) => stateOf(node)));
        return states.every((state) => placedNodes(state, TARGETED)?.length === 2) ? states : null;
      });
      /* And the node that was excluded starts serving it, which is the whole
         claim: the constraint was what kept it off, and nothing else. */
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
        excludedAnswer: { status: forwarded.status, body: forwarded.body.slice(0, 120) },
        clearedThrough: plain.id,
        spreadMs,
        clearedOutput: cleared.output.trim().slice(0, 300),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "reports a deploy routed through the node that was never going to run it",
    async () => {
      /*
       * THE ASYMMETRY THIS IS FOR. Intake is independent of placement — any node
       * accepts an upload — but placement is the coordinator's decision, taken
       * after the deploy has landed. So the node holding the deploy open is
       * routinely not the node that starts the build, and a deploy that watched
       * only its OWN processes reported `deploy-not-routed` after the full
       * two-minute budget while the build had been serving on the other node for
       * seconds. Same build, same fleet: 2s one way, 124s the other.
       *
       * The selector is what makes the placement certain rather than a hash's
       * decision: only node-b carries the label, so node-a can never be the one
       * running this, and it is node-a the deploy is sent to.
       */
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
      const routedMs = Date.now() - startedAt;
      expectCleanExit(result);

      /* The deploy settles at `routed` rather than at `deployed` with a warning:
         the node it was sent to went and asked the node the placement named. */
      expect(result.output, daemonLogTail()).toContain("routed");
      expect(result.output).not.toContain("deploy-not-routed");
      /* Comfortably inside the 120s budget, which is what "watched the wrong
         node until it gave up" would have spent. */
      expect(routedMs).toBeLessThan(90_000);

      /* And the claim rests on the placement really being elsewhere. */
      await until(`${AWAITED} to be placed on ${labelled.id} alone`, DEADLINE_MS, async () => {
        const named = placedNodes(await stateOf(plain), AWAITED);
        return named?.length === 1 && named[0] === labelled.id ? named : null;
      });
      expect((await stateOf(plain)).processes.some(runsAwaited)).toBe(false);

      observed.deployThroughOtherNode = {
        environment: AWAITED,
        deployedThrough: plain.id,
        placedOn: labelled.id,
        routedMs,
        output: result.output.trim().slice(-300),
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "runs an environment scaled to one replica on exactly one node, and takes it off the other",
    async () => {
      /* Deployed to every node first — a long-lived environment defaults to
         "all" — so what follows is a scale DOWN of something already running,
         which is the case that has to take a process away from a node. */
      expectCleanExit(await runCli(deployArgs(await stageApp("v1"), SOLO), {}));
      for (const node of nodes) await untilServes(node, soloHost(), "v1");

      const scaledAt = Date.now();
      await setReplicas(registry, PROJECT, SOLO, 1);

      /*
       * Which node keeps it is rendezvous hashing's decision and not this
       * test's, so both branches are written for. What IS asserted is that the
       * two nodes agree: one placement, naming one node, and that node is the
       * only one with a process.
       */
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

      /* The node it was placed on serves it through its own ingress. */
      const served = await untilServes(holder, soloHost(), "v1");
      expect(JSON.parse(served.body).version).toBe("v1");

      /* And the other one stops RUNNING it without stopping ANSWERING for it:
         the host lands on its daemon, which forwards the held request to the
         node the placement names. Scaling down decides where a process runs,
         never which door reaches it. */
      await until(`${unassigned.id} to run nothing for ${SOLO}`, DEADLINE_MS, async () => {
        const state = await stateOf(unassigned);
        return state.processes.some(runsSolo) ? null : state;
      });
      const forwarded = await until(
        `${unassigned.id} to forward ${SOLO} to its holder`,
        DEADLINE_MS,
        async () => {
          const answer = await httpGet(unassigned.httpPort, "/", { host: soloHost() });
          return answer.status === 200 && answer.body.includes('"v1"') ? answer : null;
        },
      );
      expect(JSON.parse(forwarded.body).version).toBe("v1");
      expect((await stateOf(unassigned)).processes.some(runsSolo)).toBe(false);
      expect(placedNodes(await stateOf(unassigned), SOLO)).toEqual([holder.id]);

      soloHolder = holder;
      soloProcess = (await stateOf(holder)).processes.find(runsSolo) as ProcessStatus;
      observed.replicasOne = {
        heldBy: holder.id,
        unassigned: unassigned.id,
        scaledDownMs: Date.now() - scaledAt,
        forwardedAnswer: { status: forwarded.status, body: forwarded.body.slice(0, 120) },
      };
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "moves a single-replica environment off a node that was asked to stop, FAST",
    async () => {
      /*
       * The counterpart to the kill test below, and the whole point of draining.
       * A node that is KILLED keeps its last heartbeat and stays a placement
       * candidate for the liveness window — 90s in which its environments are
       * assigned to a process that is already gone. A node asked to stop writes
       * `drainingAt` before it stops anything else, and the coordinator counts it
       * out on its very next assignment pass instead.
       *
       * `docker stop` rather than `docker kill`: the difference IS the test.
       */
      const leaving = soloHolder;
      const survivor = nodes.find((node) => node.id !== leaving.id) as Node;

      const stoppedAt = Date.now();
      const stopped = await run(
        "docker",
        /* Ample grace, so a slow shutdown is never SIGKILLed halfway through the
           drain write this test is about. */
        ["stop", "-t", "30", leaving.daemon.getId()],
        REPO_ROOT,
        { PATH: env.PATH ?? "" },
      );
      expect(stopped.code, stopped.output).toBe(0);
      leaving.running = false;

      /* Measured from the moment the operator asked, which is what an operator
         actually waits through: the shutdown itself is part of the window. */
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

      /* The bound that says draining did something: a crash CANNOT be noticed
         before the liveness window has run out, so anything under it is time
         the graceful path bought back. */
      expect(drainedMs).toBeLessThan(NODE_LIVENESS_WINDOW_MS);
      /* And the useful bound: about one assignment tick, one reconcile pass and
         one process start, rather than "somewhat better than a crash". */
      expect(drainedMs).toBeLessThan(GRACEFUL_DRAIN_BUDGET_MS);

      /* The node said so itself, rather than being counted out. */
      const record = await readJson<NodeRecord>(registry, nodeKey(leaving.id));
      expect(record?.value.drainingAt, "the stopped node never recorded its drain").toBeDefined();
      expect(record?.value.heartbeatAt).toBeDefined();

      /* Held by reference and filled in as the step goes on; the report is
         printed from `observed` once every test has run. */
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

      /* Brought back for the tests that follow, which need two nodes again. The
         boot rewrites the record wholesale, so the drain flag goes with it and
         placement gives the node work once more — which is the other half of the
         feature, and is asserted here rather than assumed. */
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
          const answer = await httpGet(leaving.apiPort, "/v1/health", {});
          return answer.status === 200 ? node.value : null;
        },
      );
      expect(back.drainingAt).toBeUndefined();
      drain.restoredMs = Date.now() - restartedAt;

      /* Rendezvous hashing is deterministic, so the fleet settles back to the
         same decision it made before — and the tests after this one can go on
         reading `soloHolder` and `soloProcess` as they did. */
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
      /* A custom domain, so the deletion has a claim to release as well as a
         record to remove. */
      await claimDomain(registry, SUNSET_DOMAIN, PROJECT, SUNSET);

      /* Retirement is a plain record update, so it is asked of whichever node
         the operator happens to have a URL for. */
      const retiredAt = Date.now();
      const retired = await runCli(envArgs("retire", SUNSET, nodes[0]), {});
      expectCleanExit(retired);
      expect(retired.output).toContain("retired");

      /* It leaves by the same door a reassignment uses: no process, no route —
         and its host falls through each Caddy's catch-all to the daemon, which
         answers a retired name with the one 404 every refusal wears. Safe to
         poll: a retired environment refuses to wake and nothing is stamped. */
      for (const node of nodes) {
        await until(`${node.id} to stop serving ${SUNSET}`, DEADLINE_MS, async () => {
          const state = await stateOf(node);
          if (state.processes.some(runsSunset)) return null;
          const answer = await httpGet(node.httpPort, "/", { host: sunsetHost() });
          return answer.status === 404 && answer.body.includes("urn:scafo:not-found")
            ? answer
            : null;
        });
      }
      const stoppedMs = Date.now() - retiredAt;

      /* And the coordinator takes the placement with it: an environment nothing
         serves is one no decision should still name nodes for. */
      await until(`the placement of ${SUNSET} to be removed`, DEADLINE_MS, async () =>
        (await readJson(registry, placementKey(PROJECT, SUNSET))) === null ? true : null,
      );

      /*
       * Asked of the node that is NOT the coordinator, on purpose: the refusal
       * and the forced deletion both have to survive the hop to whoever holds
       * the lease — including the `force` in the query, which a forward that
       * carried only the path would silently drop.
       */
      const coordinator = await coordinatorNode();
      const asked = nodes.find((node) => node.id !== coordinator.id) as Node;

      const refused = await runCli(envArgs("delete", SUNSET, asked), {});
      expect(refused.code, refused.output).toBe(1);
      /* The refusal has to name the way forward, not just the rule it enforced. */
      expect(refused.output).toContain("grace");
      expect(refused.output).toContain("force");
      expect(await readJson(registry, environmentKey(PROJECT, SUNSET))).not.toBeNull();

      const forced = await runCli(envArgs("delete", SUNSET, asked, ["--force"]), {});
      expectCleanExit(forced);
      expect(forced.output).toContain(environmentKey(PROJECT, SUNSET));

      /* Gone from the bucket, which is the only place it ever existed — record,
         placement and the claim that named it. */
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

      /*
       * SIGKILL rather than a graceful stop, and the difference is the whole
       * test: a node that is asked to stop gives the lease up on its way out,
       * and the handover that follows proves nothing about a node that DIES.
       * Killed outright, it releases nothing, so the survivor can only take over
       * by outwaiting the lease — which is the guarantee being measured.
       */
      const killedAt = Date.now();
      const killed = await run("docker", ["kill", coordinator.daemon.getId()], REPO_ROOT, {
        PATH: env.PATH ?? "",
      });
      expect(killed.code, killed.output).toBe(0);
      coordinator.running = false;

      /* Bounded by the lease: the survivor cannot take it until the dead
         holder's TTL has run out, and takes it on one of the ticks after that. */
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
      /* The fence only ever moves forward, and a takeover is what moves it: the
         node that died can no longer act on the fence it held. */
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
      /*
       * Bounded at both ends, and the arithmetic is the design:
       *
       * The dead node renewed every TTL/3, so at the moment it was killed its
       * lease had between TTL - TTL/3 and TTL left to run. A survivor that took
       * over sooner than that would have overwritten a lease its holder still
       * had time on — which is the one thing the fence exists to prevent. Taking
       * much longer than a TTL plus a tick would mean nothing was watching.
       */
      expect(failoverMs).toBeGreaterThanOrEqual(LEASE_TTL_MS - LEASE_TTL_MS / 3);
      expect(failoverMs).toBeLessThanOrEqual(3 * LEASE_TTL_MS);

      /* Availability, which is the other half of what a second node is for: the
         application never stopped being served while all this happened. */
      const answer = await untilServes(survivor, envHost(), "v1");
      expect(JSON.parse(answer.body).version).toBe("v1");
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "carries the single-replica environment through the death of whichever node held it",
    async () => {
      const survivor = nodes.find((node) => node.running) as Node;
      /* Which node rendezvous hashing gave it to is not this suite's to choose,
         so both outcomes are waited for by the same probe and told apart by one
         fact at the end. */
      const killedHeldIt = soloHolder.id !== survivor.id;
      const startedAt = Date.now();

      /*
       * Nothing about a takeover is instant, and that is the design: a killed
       * node keeps its last heartbeat and stays live for three heartbeat
       * intervals, because counting a node out is what moves work away from it
       * and a node that is merely slow must survive that. Once it does fall out,
       * the survivor — the coordinator by then — decides again over the fleet it
       * can actually see. When the survivor already held it, the same probe
       * passes immediately and nothing moved at all.
       */
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
      /*
       * The one fact the two branches disagree on, asserted as one. If the dead
       * node held it, this process is a new one the survivor started after the
       * reassignment. If the survivor held it all along, it is the SAME process
       * it started before the kill — never stopped, never restarted, which is
       * what "kept serving uninterrupted" has to mean.
       */
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

/* ------------------------------------------------------------------ helpers */

/**
 * Starts one Caddy and the daemon that shares its network namespace.
 *
 * `labels` is what the operator says this node IS, written `k=v,k2=v2`. It is
 * boot configuration: the daemon writes it into the node's registry record on
 * every registration, so it is set here and nowhere else.
 */
async function startNode(id: string, labels?: string): Promise<Node> {
  const caddy = await new GenericContainer(CADDY_IMAGE)
    .withCopyFilesToContainer([
      { source: join(FIXTURES, "caddy.json"), target: "/etc/caddy/config.json" },
    ])
    .withCommand(["caddy", "run", "--config", "/etc/caddy/config.json"])
    .withExposedPorts(CADDY_HTTP_PORT, CADDY_ADMIN_PORT, NODE_PORT)
    .withWaitStrategy(
      Wait.forHttp(`/config/apps/http/servers/scafo/routes`, CADDY_ADMIN_PORT).forStatusCode(200),
    )
    .start();

  const bridgeAddress = caddy.getIpAddress(BRIDGE_NETWORK);
  const log: string[] = [];

  const daemon = await new GenericContainer(NODE_IMAGE)
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
      SCAFO_NODE_ID: id,
      /* Both the daemon listener and the runtime processes bind every interface
         here, and the peer listener authenticates nobody: on a private docker
         network that is the trusted-network case, stated rather than assumed. */
      SCAFO_TRANSPORT: "none",
      /* Distinct per node, and container-local: the working directory is this
         repository bind-mounted at /work, and an identity must never be written
         into a checkout — let alone one two nodes would then share. */
      SCAFO_STATE_DIR: `/var/lib/scafo-${id}`,
      SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
      SCAFO_CADDY_ADMIN: `http://127.0.0.1:${String(CADDY_ADMIN_PORT)}`,
      /* The address on the bridge, which is what the other node dials — both for
         the node API and, with the internal port, for cell traffic. */
      SCAFO_ADVERTISE: `${bridgeAddress}:${String(NODE_PORT)}`,
      /* THE multi-node setting. Runtime processes bind loopback by default,
         which nothing on the other node can reach; the advertised address above
         is only useful if something is listening on it. */
      SCAFO_BIND_HOST: "0.0.0.0",
      ESBUILD_BINARY_PATH: "/usr/local/bin/esbuild",
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
    caddy,
    daemon,
    bridgeAddress,
    httpPort: caddy.getMappedPort(CADDY_HTTP_PORT),
    adminPort: caddy.getMappedPort(CADDY_ADMIN_PORT),
    apiPort: caddy.getMappedPort(NODE_PORT),
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
  return process.state === "running" && process.id.startsWith(`${PROJECT}--${TARGETED}--`);
}

function runsAwaited(process: ProcessStatus): boolean {
  return process.state === "running" && process.id.startsWith(`${PROJECT}--${AWAITED}--`);
}

/** Whether a process on a node is one serving {@link SOLO}. */
function runsSolo(process: ProcessStatus): boolean {
  return process.state === "running" && process.id.startsWith(`${PROJECT}--${SOLO}--`);
}

/** Whether a process on a node is one serving {@link SUNSET}. */
function runsSunset(process: ProcessStatus): boolean {
  return process.state === "running" && process.id.startsWith(`${PROJECT}--${SUNSET}--`);
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
    "--runtime-configurable",
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

/** The tail of BOTH daemons' output: with two nodes, either may hold the reason. */
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
