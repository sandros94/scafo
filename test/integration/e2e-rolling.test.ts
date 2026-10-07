/*
 * An upgrade of every node of an installation between two Celld releases, run
 * the way upstream's own notes say to run it. Which way that is depends on the
 * pair, and the suite runs the one `_celld-contract.ts` allows for the two
 * images it is given:
 *
 * - A ROLLING PAIR upstream declared: stop one node, wait for its replacement to
 *   report healthy, then continue to the next node, deploying in between.
 * - ANY OTHER PAIR: stop the whole fleet first. The suite proves the refusal that
 *   makes this necessary — a node on the new release beside a live peer on the
 *   old one starts nothing and accepts no deploy — then stops the old peer and
 *   shows the new release take the application over, with a write the old
 *   release acknowledged under `fleet` durability still there.
 *
 * Opt-in twice over. `SCAFO_E2E=1`, and `SCAFO_E2E_ROLLING_IMAGE` naming a probe
 * image that carries the release the fleet moves FROM; `scafo-probe`, built from
 * the repo Dockerfile, is the release the fleet moves ONTO. Both images run the
 * same Scafo build, bind-mounted from the worktree, so the only thing that
 * differs between the old nodes and the new ones is Celld.
 *
 * Each node is a daemon container sharing the network namespace of a Traefik
 * container that holds its address and published ports, so a replacement comes
 * back at the same address, under the same node id, on the same state directory
 * — which is what replacing a machine's binary looks like.
 */

import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import {
  celldReleasesMayShareFleet,
  rollingReleaseList,
} from "../../src/core/registry/_celld-contract.ts";
import { NODE_LIVENESS_WINDOW_MS, nodeKey, readJson } from "../../src/core/registry/index.ts";
import type { NodeRecord } from "../../src/core/types/registry.ts";
import type { DaemonState, SupervisedProcess } from "../../src/daemon/app.ts";
import { DEFAULT_RECONCILE_INTERVAL_MS } from "../../src/daemon/reconcile.ts";
import {
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  type BucketSettings,
  collectLogs,
  type CommandResult,
  DEADLINE_MS,
  delay,
  deploymentOf,
  FIXTURES,
  httpGet,
  NODE_IMAGE,
  POLL_MS,
  registryAt,
  REPO_ROOT,
  run,
  runCli,
  SETUP_TIMEOUT_MS,
  stageApp,
  type StartedStore,
  startStore,
  storeEnv,
  reportObservations,
  until,
} from "./_harness.ts";

const E2E = process.env.SCAFO_E2E === "1";
/** The probe image carrying the release the fleet moves FROM. */
const OLD_IMAGE = process.env.SCAFO_E2E_ROLLING_IMAGE;
/** The repo's own probe image: the release the fleet moves ONTO. */
const NEW_IMAGE = NODE_IMAGE;

const TRAEFIK_IMAGE = "traefik:v3";
const TRAEFIK_API_PORT = 8080;
const NODE_PORT = 7400;
/**
 * The runtime port range every node runs with: exactly the two ports its one
 * application's process takes, so both can be published before the daemon has
 * chosen which is public, and the test reaches THAT node's process directly
 * rather than through an ingress that could fall over to the peer.
 */
const PORT_RANGE_START = 24_000;
const PORT_RANGE_END = 24_001;

const BUCKET_SETTINGS: BucketSettings = {
  bucket: "scafo-e2e-rolling",
  prefix: "e2e",
  accessKey: "scafo",
  secretKey: "scafo-secret",
  region: "us-east-1",
};
const PLATFORM_DOMAIN = "scafo.test";
const INGRESS_TOKEN = "e2e-rolling-ingress-token";
const APPLICATION = "app";
const HOST = `${APPLICATION}.${PLATFORM_DOMAIN}`;
const STATE_DIR = "/var/lib/scafo";

/** Each replacement waits out a graceful stop, then a boot and a first ready process. */
const STEP_TIMEOUT_MS = 300_000;

/** One machine: the namespace that outlives its binary, and the daemon running in it now. */
interface Slot {
  id: string;
  holder: StartedTestContainer;
  daemon: StartedTestContainer;
  image: string;
  stateDir: string;
  bridgeAddress: string;
  apiPort: number;
  /** The current daemon's output; a replacement starts a fresh one. */
  log: string[];
}

let store: StartedStore;
let keyPath: string;
let operatorKey: OperatorKeyFile;
let a: Slot;
let b: Slot;

const tmpDirs: string[] = [];
const observed: Record<string, unknown> = {};

/**
 * Which upgrade the two images call for, decided before any case is collected so
 * every case name says what actually runs. Nothing is asked of Docker unless the
 * suite is opted into.
 */
const releases =
  E2E && OLD_IMAGE !== undefined
    ? { from: await celldIn(OLD_IMAGE), onto: await celldIn(NEW_IMAGE) }
    : undefined;
if (releases !== undefined && releases.from === releases.onto) {
  throw new Error(
    `SCAFO_E2E_ROLLING_IMAGE and ${NEW_IMAGE} both carry celld ${releases.from}; ` +
      `this suite needs the release the fleet moves from and a newer one`,
  );
}
const rolling = releases !== undefined && celldReleasesMayShareFleet(releases.from, releases.onto);
const oldCelld = releases?.from ?? "";
const newCelld = releases?.onto ?? "";
/** The pair a case name states: the one given, when that case is the one that runs. */
const givenPair = `${oldCelld} → ${newCelld}`;

/** Starts the bucket and both nodes on the old release; registers the operator key. */
async function setUpFleet(): Promise<void> {
  observed.releases = { from: oldCelld, onto: newCelld, rollingPairs: rollingReleaseList() };
  observed.mode = rolling ? "rolling" : "stop-the-world";

  store = await startStore(BUCKET_SETTINGS);
  a = await startSlot("node-a", OLD_IMAGE as string);
  b = await startSlot("node-b", OLD_IMAGE as string);

  const dir = await mkdtemp(join(tmpdir(), "scafo-e2e-rolling-key-"));
  tmpDirs.push(dir);
  keyPath = join(dir, "operator.json");
  expectCleanExit(
    await runCli(["operator", "keygen", "--out", keyPath, "--register"], bucketEnv()),
  );
  operatorKey = JSON.parse(await readFile(keyPath, "utf8")) as OperatorKeyFile;
}

async function tearDownFleet(): Promise<void> {
  for (const slot of [a, b]) {
    if (slot === undefined) continue;
    await slot.daemon.stop().catch(() => {});
    await slot.holder.stop().catch(() => {});
    /* Written by uid 10001 into directories only it may enter. */
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "0",
        "-v",
        `${slot.stateDir}:/state`,
        "--entrypoint",
        "sh",
        NEW_IMAGE,
        "-c",
        "rm -rf /state/..?* /state/.[!.]* /state/*",
      ],
      REPO_ROOT,
      { PATH: process.env.PATH ?? "" },
    ).catch(() => {});
    await rm(slot.stateDir, { recursive: true, force: true }).catch(() => {});
  }
  await store?.container.stop().catch(() => {});
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });

  reportObservations("e2e-rolling", observed);
}

describe.skipIf(releases === undefined || !rolling)(
  `a rolling pair of Celld releases, one node replaced at a time (${rolling ? givenPair : "not the pair given"})`,
  () => {
    beforeAll(setUpFleet, SETUP_TIMEOUT_MS);
    afterAll(tearDownFleet, SETUP_TIMEOUT_MS);

    it(
      "serves one application from two nodes on the old release",
      async () => {
        const result = await runCli(deployArgs(await stageApp("v1", tmpDirs), a), {});
        expectCleanExit(result);
        observed.v1 = deploymentOf(result.output);

        for (const slot of [a, b]) await untilServes(slot, "v1");
        expect(await celldOf(a)).toBe(oldCelld);
        expect(await celldOf(b)).toBe(oldCelld);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "starts the application on a replacement running the new release, beside a peer on the old one",
      async () => {
        const before = await readyProcess(b);
        const startedAt = Date.now();
        a = await replace(a, NEW_IMAGE);

        const served = await untilServes(a, "v1");
        observed.firstReplacement = {
          node: a.id,
          replacedInMs: Date.now() - startedAt,
          readyAt: served.process.readyAt,
        };

        /* THE ASSERTION THIS FEATURE EXISTS FOR: a node that compared Celld
           versions by equality would have refused this start as version-skew
           and kept refusing it for as long as the peer stayed on the old one. */
        expect(skewLines(a), a.log.join("")).toEqual([]);
        expect(served.state.reconcile?.failures ?? []).toEqual([]);
        expect(await celldOf(a)).toBe(newCelld);

        /* The peer never stopped: it is still the old release, still serving. */
        const peer = await untilServes(b, "v1");
        expect(await celldOf(b)).toBe(oldCelld);
        observed.peerDuringFirstReplacement = {
          node: b.id,
          processStartedBefore: before.startedAt,
          processStartedAfter: peer.process.startedAt,
        };
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "shows both releases in the fleet's version spread while the roll is half done",
      async () => {
        observed.mixedSpread = await celldSpread();
        expect(observed.mixedSpread).toBe(`celld: ${newCelld} on 1 node, ${oldCelld} on 1`);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "accepts a deploy through the new node while the peer is still on the old release, and both adopt it",
      async () => {
        const result = await runCli(deployArgs(await stageApp("v2", tmpDirs), a), {});
        expectCleanExit(result);
        expect(result.output).toContain("deployed");
        expect(result.output).not.toContain("version-skew");
        observed.v2 = deploymentOf(result.output);

        await untilServes(a, "v2");
        await untilServes(b, "v2");
        expect(await celldOf(b)).toBe(oldCelld);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "replaces the second node the same way, and ends with both on the new release",
      async () => {
        const startedAt = Date.now();
        b = await replace(b, NEW_IMAGE);

        await untilServes(b, "v2");
        observed.secondReplacement = { node: b.id, replacedInMs: Date.now() - startedAt };
        expect(skewLines(b), b.log.join("")).toEqual([]);
        await untilServes(a, "v2");

        expect(await celldOf(a)).toBe(newCelld);
        expect(await celldOf(b)).toBe(newCelld);
        observed.finalSpread = await celldSpread();
        expect(observed.finalSpread).toBe(`celld: ${newCelld} on 2 nodes`);
      },
      STEP_TIMEOUT_MS,
    );
  },
);

describe.skipIf(releases === undefined || rolling)(
  `Celld releases that may not share a fleet, every node stopped first (${releases !== undefined && !rolling ? givenPair : "not the pair given"})`,
  () => {
    /** The last count the old release acknowledged, read back on the new one. */
    let acknowledged: number;

    beforeAll(setUpFleet, SETUP_TIMEOUT_MS);
    afterAll(tearDownFleet, SETUP_TIMEOUT_MS);

    it(
      "serves one application from two nodes on the old release, and counts through its durable object on both",
      async () => {
        const result = await runCli(deployArgs(await stageApp("v1", tmpDirs), a), {});
        expectCleanExit(result);
        observed.v1 = deploymentOf(result.output);

        for (const slot of [a, b]) await untilServes(slot, "v1");
        expect(await celldOf(a)).toBe(oldCelld);
        expect(await celldOf(b)).toBe(oldCelld);

        /* One cell owns the counter whichever node is asked, so a count that keeps
           rising across both is a write each node's answer was acknowledged for
           under the fleet's default durability. */
        for (const slot of [a, b]) await untilCellAnswers(slot);
        const counts: Array<{ node: string; n: number }> = [];
        for (let round = 0; round < 2; round++) {
          for (const slot of [a, b]) counts.push({ node: slot.id, n: await countOnce(slot) });
        }
        for (let i = 1; i < counts.length; i++) {
          expect(counts[i]?.n, JSON.stringify(counts)).toBe((counts[i - 1]?.n as number) + 1);
        }
        acknowledged = counts.at(-1)?.n as number;
        observed.countsOnOldRelease = counts;
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "refuses to start the application, or take a deploy, on a replacement running the new release while a peer serves it on the old one",
      async () => {
        const startedAt = Date.now();
        a = await replace(a, NEW_IMAGE);
        expect(await celldOf(a)).toBe(newCelld);

        const refused = await until(
          `${a.id} to refuse "${APPLICATION}" as version-skew`,
          DEADLINE_MS,
          async () => {
            const state = await stateOf(a);
            const failure = state.reconcile?.failures.find(
              (entry) => entry.subject === APPLICATION && entry.code === "version-skew",
            );
            return failure !== undefined && skewLines(a).length > 0 ? failure : null;
          },
          { context: () => a.log.join("").slice(-6000) },
        );
        const refusedAfterMs = Date.now() - startedAt;

        /* Held for three more reconcile passes after the first refusal, polled
           throughout: no pass in that window starts a process for the application,
           because the peer on the old release is still live. */
        const heldMs = 3 * DEFAULT_RECONCILE_INTERVAL_MS;
        for (const endsAt = Date.now() + heldMs; Date.now() < endsAt; await delay(POLL_MS)) {
          const state = await stateOf(a);
          expect(
            state.processes.filter((entry) => entry.id === APPLICATION),
            a.log.join("").slice(-6000),
          ).toEqual([]);
        }
        expect(refused.detail).toContain(`${b.id} (celld ${oldCelld})`);

        /* The peer on the old release is untouched by the refusal. */
        await untilServes(b, "v1");
        expect(await celldOf(b)).toBe(oldCelld);
        const mixedSpread = await celldSpread();
        expect(mixedSpread).toBe(`celld: ${newCelld} on 1 node, ${oldCelld} on 1`);

        /* And a deploy through the new node is refused at intake, before anything
           is written into the application's fleet. */
        const deploy = await runCli(deployArgs(await stageApp("v2", tmpDirs), a), {});
        expect(deploy.code, deploy.output).not.toBe(0);
        expect(deploy.output).toContain("version-skew");
        expect(deploy.output).not.toContain("scafo: deployment ");

        observed.refusal = {
          node: a.id,
          refusedAfterMs,
          heldForMs: heldMs,
          reconcileFailure: refused,
          logLines: skewLines(a).slice(0, 3),
          mixedSpread,
          deployExit: deploy.code,
          deployOutput: deploy.output.trim().split("\n").slice(-4),
        };
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "starts the application on the new release once the old peer has stopped and aged out of the liveness window",
      async () => {
        const stoppedAt = Date.now();
        await stopDaemon(b);

        /*
         * A GRACEFULLY STOPPED NODE KEEPS ITS RECORD. Its shutdown writes
         * `drainingAt` and stops beating; nothing deletes the record or its
         * `serving`, and the skew gate counts a draining node for as long as its
         * last heartbeat is inside the liveness window. So the new node may start
         * the application only once that heartbeat is NODE_LIVENESS_WINDOW_MS
         * old — between one heartbeat interval less than that and the whole of it
         * after the stop — plus the reconcile pass that notices.
         */
        const peerRecord = await nodeRecordOf(b);
        expect(peerRecord?.drainingAt, "a graceful stop marks the node draining").toBeDefined();
        const lastBeat = Date.parse(peerRecord?.heartbeatAt ?? "");

        const served = await untilServes(a, "v1", NODE_LIVENESS_WINDOW_MS + DEADLINE_MS);
        expect(served.state.reconcile?.failures ?? []).toEqual([]);
        const startedAt = Date.parse(served.process.startedAt);
        expect(
          startedAt,
          "the new node started the application while the old peer's heartbeat was still live",
        ).toBeGreaterThanOrEqual(lastBeat + NODE_LIVENESS_WINDOW_MS - 1_000);

        observed.takeover = {
          node: a.id,
          takeoverInMs: Date.now() - stoppedAt,
          peerLastHeartbeatAt: peerRecord?.heartbeatAt,
          peerDrainingAt: peerRecord?.drainingAt,
          processStartedAt: served.process.startedAt,
          readyAt: served.process.readyAt,
          startedAfterPeerStopMs: startedAt - stoppedAt,
          startedAfterPeerLastBeatMs: startedAt - lastBeat,
          livenessWindowMs: NODE_LIVENESS_WINDOW_MS,
          recovery: recoveryLines(a),
        };
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "brings the second node back on the new release, and it serves too",
      async () => {
        const startedAt = Date.now();
        b = { ...b, ...(await startDaemon(b, NEW_IMAGE)) };
        await untilServes(b, "v1");
        expect(skewLines(b), b.log.join("")).toEqual([]);
        expect(await celldOf(b)).toBe(newCelld);
        observed.secondOnNewRelease = {
          node: b.id,
          servedInMs: Date.now() - startedAt,
          recovery: recoveryLines(b),
        };
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "gives back the count the old release acknowledged, through both nodes on the new one",
      async () => {
        const peeked: Record<string, number> = {};
        for (const slot of [a, b]) peeked[slot.id] = await untilCellAnswers(slot);
        const next = await countOnce(a);
        observed.readBack = { acknowledged, peeked, next };

        for (const slot of [a, b]) {
          expect(peeked[slot.id], `${slot.id} lost the acknowledged count`).toBe(acknowledged);
        }
        expect(next).toBe(acknowledged + 1);
      },
      STEP_TIMEOUT_MS,
    );

    it(
      "accepts a deploy through the new release that both nodes adopt, and ends with both on it",
      async () => {
        const result = await runCli(deployArgs(await stageApp("v2", tmpDirs), a), {});
        expectCleanExit(result);
        expect(result.output).not.toContain("version-skew");
        observed.v2 = deploymentOf(result.output);

        await untilServes(a, "v2");
        await untilServes(b, "v2");
        expect(await celldOf(a)).toBe(newCelld);
        expect(await celldOf(b)).toBe(newCelld);
        observed.finalSpread = await celldSpread();
        expect(observed.finalSpread).toBe(`celld: ${newCelld} on 2 nodes`);
      },
      STEP_TIMEOUT_MS,
    );
  },
);

/* ---------------------------------------------------------------- internals */

/** The release `celld --version` reports inside `image`. */
async function celldIn(image: string): Promise<string> {
  const result = await run(
    "docker",
    ["run", "--rm", "--entrypoint", "celld", image, "--version"],
    REPO_ROOT,
    { PATH: process.env.PATH ?? "" },
  );
  expectCleanExit(result);
  const release = /(\d+\.\d+\.\d+)/.exec(result.output)?.[1];
  if (release === undefined) throw new Error(`no release in: ${result.output}`);
  return release;
}

/** A machine: its namespace, its state directory, and a first daemon from `image`. */
async function startSlot(id: string, image: string): Promise<Slot> {
  const staticConfig = (await readFile(join(FIXTURES, "traefik.yml"), "utf8")).replace(
    "${SCAFO_INGRESS_TOKEN}",
    INGRESS_TOKEN,
  );
  const holder = await new GenericContainer(TRAEFIK_IMAGE)
    .withCopyContentToContainer([{ content: staticConfig, target: "/etc/traefik/traefik.yml" }])
    .withExposedPorts(TRAEFIK_API_PORT, NODE_PORT, PORT_RANGE_START, PORT_RANGE_END)
    .withWaitStrategy(Wait.forHttp("/ping", TRAEFIK_API_PORT).forStatusCode(200))
    .withStartupTimeout(BOOT_DEADLINE_MS)
    .start();

  const stateDir = await mkdtemp(join(tmpdir(), `scafo-e2e-rolling-state-${id}-`));
  /* Written from inside the container by uid 10001, which owns nothing here. */
  await chmod(stateDir, 0o777);

  const slot = {
    id,
    holder,
    stateDir,
    bridgeAddress: holder.getIpAddress(BRIDGE_NETWORK),
    apiPort: holder.getMappedPort(NODE_PORT),
  };
  return { ...slot, ...(await startDaemon(slot, image)) };
}

/** Starts one daemon from `image` in the slot's namespace, on its state directory. */
async function startDaemon(
  slot: Pick<Slot, "id" | "holder" | "stateDir" | "bridgeAddress">,
  image: string,
): Promise<Pick<Slot, "daemon" | "image" | "log">> {
  const log: string[] = [];
  const daemon = await new GenericContainer(image)
    .withNetworkMode(`container:${slot.holder.getId()}`)
    .withBindMounts([
      { source: REPO_ROOT, target: "/work", mode: "ro" },
      { source: slot.stateDir, target: STATE_DIR, mode: "rw" },
    ])
    .withWorkingDir("/work")
    .withEnvironment({
      ...storeEnv(store.fromContainers, BUCKET_SETTINGS),
      SCAFO_NODE_ID: slot.id,
      SCAFO_TRANSPORT: "none",
      SCAFO_STATE_DIR: STATE_DIR,
      SCAFO_PLATFORM_DOMAINS: PLATFORM_DOMAIN,
      SCAFO_INGRESS_TOKEN: INGRESS_TOKEN,
      SCAFO_ADVERTISE: `${slot.bridgeAddress}:${String(NODE_PORT)}`,
      SCAFO_BIND_HOST: "0.0.0.0",
      SCAFO_PORT_RANGE_START: String(PORT_RANGE_START),
      SCAFO_PORT_RANGE_END: String(PORT_RANGE_END),
      CELLD_ESBUILD: "/usr/local/bin/esbuild",
    })
    .withCommand(["node", "dist/cli/index.mjs", "sail", "--listen", `0.0.0.0:${String(NODE_PORT)}`])
    .withLogConsumer(collectLogs(log))
    .withWaitStrategy(Wait.forLogMessage(/listening on/))
    .withStartupTimeout(BOOT_DEADLINE_MS)
    .start();
  return { daemon, image, log };
}

/** Stops the slot's daemon with the grace a node's shutdown needs. */
async function stopDaemon(slot: Slot): Promise<void> {
  const stopped = await run("docker", ["stop", "-t", "50", slot.daemon.getId()], REPO_ROOT, {
    PATH: process.env.PATH ?? "",
  });
  expectCleanExit(stopped);
  await slot.daemon.stop().catch(() => {});
}

/**
 * Stops the slot's daemon, then starts its replacement from `image` under the
 * same id, address and state directory.
 */
async function replace(slot: Slot, image: string): Promise<Slot> {
  await stopDaemon(slot);
  return { ...slot, ...(await startDaemon(slot, image)) };
}

/** A node's record as the bucket holds it, whether or not the node is running. */
async function nodeRecordOf(slot: Slot): Promise<NodeRecord | undefined> {
  const found = await readJson<NodeRecord>(
    registryAt(store.fromHost, BUCKET_SETTINGS),
    nodeKey(slot.id),
  );
  return found?.value;
}

/** The `celld:` line of `scafo fleet nodes`: the fleet's version spread. */
async function celldSpread(): Promise<string | undefined> {
  const listed = await runCli(["fleet", "nodes"], bucketEnv());
  expectCleanExit(listed);
  return listed.output.split("\n").find((line) => line.startsWith("celld: "));
}

/** What a node believes about itself, as an authenticated operator reads it. */
async function stateOf(slot: Slot): Promise<DaemonState> {
  const answer = await httpGet(slot.apiPort, "/v1/state", {
    authorization: `Bearer ${await signNodeToken(operatorKey.privateKey, operatorKey.id)}`,
  });
  if (answer.status !== 200) throw new Error(`/v1/state: ${String(answer.status)} ${answer.body}`);
  return JSON.parse(answer.body) as DaemonState;
}

/** The Celld release a node's own registry record says it booted with. */
async function celldOf(slot: Slot): Promise<string | undefined> {
  return (await stateOf(slot)).node?.versions?.celld;
}

/** The node's process for the application, once it has answered for itself. */
async function readyProcess(slot: Slot): Promise<SupervisedProcess> {
  const found = (await stateOf(slot)).processes.find(isReady);
  if (found === undefined) throw new Error(`${slot.id} has no ready process for ${APPLICATION}`);
  return found;
}

/**
 * Waits until THIS node's own process is ready and answers `version`, asked on
 * its public port directly rather than through an ingress that could fall over
 * to the peer.
 */
async function untilServes(
  slot: Slot,
  version: string,
  deadlineMs: number = DEADLINE_MS,
): Promise<{ state: DaemonState; process: SupervisedProcess }> {
  return until(
    `${slot.id} (celld from ${slot.image}) to serve "${version}" from its own process`,
    deadlineMs,
    async () => {
      const state = await stateOf(slot);
      const ready = state.processes.find(isReady);
      const port = publicPortIn(state);
      if (ready === undefined || port === undefined) return null;

      const answer = await httpGet(slot.holder.getMappedPort(port), "/", { host: HOST });
      return answer.status === 200 && answer.body.includes(`"${version}"`)
        ? { state, process: ready }
        : null;
    },
    { context: () => slot.log.join("").slice(-6000) },
  );
}

/** The public port the node runs the application's process on, when it runs one. */
function publicPortIn(state: DaemonState): number | undefined {
  return state.reconcile?.processes.find((entry) => entry.application === APPLICATION)?.port;
}

/** One `/count` on the node's own process, which is one write; the number it answered. */
async function countOnce(slot: Slot): Promise<number> {
  const port = publicPortIn(await stateOf(slot));
  if (port === undefined) throw new Error(`${slot.id} runs no process for ${APPLICATION}`);
  const answer = await httpGet(slot.holder.getMappedPort(port), "/count", { host: HOST });
  const n = countOf(answer.body);
  if (answer.status !== 200 || n === null) {
    throw new Error(`${slot.id} answered /count with ${String(answer.status)} ${answer.body}`);
  }
  return n;
}

/**
 * Waits until the node's own process answers for the counter's cell, WITHOUT
 * counting (the fixture's `/peek`), and returns the count it holds.
 */
async function untilCellAnswers(slot: Slot): Promise<number> {
  return until(
    `${slot.id} to answer for the counter cell`,
    DEADLINE_MS,
    async () => {
      const port = publicPortIn(await stateOf(slot));
      if (port === undefined) return null;
      const answer = await httpGet(slot.holder.getMappedPort(port), "/peek", { host: HOST });
      return answer.status === 200 ? countOf(answer.body) : null;
    },
    { context: () => slot.log.join("").slice(-6000) },
  );
}

/** The count an answer from `/count` or `/peek` carries, or null when it carries none. */
function countOf(body: string): number | null {
  try {
    const n = (JSON.parse(body) as { n?: unknown }).n;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

/** What a node's runtime said about recovering its log session, for the report. */
function recoveryLines(slot: Slot): string[] {
  return slot.log
    .join("")
    .split("\n")
    .filter((line) => /recover|predecessor|tail|CLT|refusing|node_log/i.test(line))
    .slice(-40);
}

/** Whether a supervised process is the application's, running, and has answered for itself. */
function isReady(entry: SupervisedProcess): boolean {
  return entry.id === APPLICATION && entry.state === "running" && entry.ready === true;
}

/** Every line of a daemon's output that mentions a version-skew refusal. */
function skewLines(slot: Slot): string[] {
  return slot.log
    .join("")
    .split("\n")
    .filter((line) => line.includes("version-skew"));
}

function deployArgs(dir: string, via: Slot): string[] {
  return [
    "deploy",
    dir,
    "--node",
    `http://127.0.0.1:${String(via.apiPort)}`,
    "--name",
    APPLICATION,
    "--replicas",
    "all",
    "--key",
    keyPath,
  ];
}

function bucketEnv(): Record<string, string> {
  return storeEnv(store.fromHost, BUCKET_SETTINGS);
}

function expectCleanExit(result: CommandResult): void {
  expect(result.code, result.output).toBe(0);
}
