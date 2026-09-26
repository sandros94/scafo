/*
 * A rolling upgrade between two Celld releases upstream declared may share a
 * fleet, run the way upstream's own notes say to run it: stop one node, wait for
 * its replacement to report healthy, then continue to the next node.
 *
 * Opt-in twice over. `SCAFO_E2E=1`, and `SCAFO_E2E_ROLLING_IMAGE` naming a probe
 * image that carries the OTHER release of a pair `_celld-contract.ts` lists;
 * `scafo-probe`, built from the repo Dockerfile, is the release the fleet moves
 * ONTO. Both images run the same Scafo build, bind-mounted from the worktree, so
 * the only thing that differs between the old nodes and the new ones is Celld.
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
import type { DaemonState, SupervisedProcess } from "../../src/daemon/app.ts";
import {
  BOOT_DEADLINE_MS,
  BRIDGE_NETWORK,
  type BucketSettings,
  collectLogs,
  type CommandResult,
  DEADLINE_MS,
  deploymentOf,
  FIXTURES,
  httpGet,
  NODE_IMAGE,
  REPO_ROOT,
  run,
  runCli,
  SETUP_TIMEOUT_MS,
  stageApp,
  type StartedStore,
  startStore,
  storeEnv,
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
let oldCelld: string;
let newCelld: string;
let a: Slot;
let b: Slot;

const tmpDirs: string[] = [];
const observed: Record<string, unknown> = {};

describe.skipIf(!E2E || OLD_IMAGE === undefined)(
  "a rolling pair of Celld releases, one node replaced at a time",
  () => {
    beforeAll(async () => {
      oldCelld = await celldIn(OLD_IMAGE as string);
      newCelld = await celldIn(NEW_IMAGE);
      if (oldCelld === newCelld || !celldReleasesMayShareFleet(oldCelld, newCelld)) {
        throw new Error(
          `SCAFO_E2E_ROLLING_IMAGE carries celld ${oldCelld} and ${NEW_IMAGE} carries ` +
            `${newCelld}; this suite needs the two halves of a pair this build lists ` +
            `(${rollingReleaseList()})`,
        );
      }
      observed.releases = { from: oldCelld, onto: newCelld };

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
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
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

      console.log(`\n[e2e-rolling] raw observations\n${JSON.stringify(observed, null, 2)}`);
    }, SETUP_TIMEOUT_MS);

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
        const listed = await runCli(["fleet", "nodes"], bucketEnv());
        expectCleanExit(listed);
        const spread = listed.output.split("\n").find((line) => line.startsWith("celld: "));
        observed.mixedSpread = spread;
        expect(spread, listed.output).toBe(`celld: ${newCelld} on 1 node, ${oldCelld} on 1`);
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

        const listed = await runCli(["fleet", "nodes"], bucketEnv());
        expectCleanExit(listed);
        const spread = listed.output.split("\n").find((line) => line.startsWith("celld: "));
        observed.finalSpread = spread;
        expect(spread, listed.output).toBe(`celld: ${newCelld} on 2 nodes`);
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

/**
 * Stops the slot's daemon with the grace a node's shutdown needs, then starts its
 * replacement from `image` under the same id, address and state directory.
 */
async function replace(slot: Slot, image: string): Promise<Slot> {
  const stopped = await run("docker", ["stop", "-t", "50", slot.daemon.getId()], REPO_ROOT, {
    PATH: process.env.PATH ?? "",
  });
  expectCleanExit(stopped);
  await slot.daemon.stop().catch(() => {});
  return { ...slot, ...(await startDaemon(slot, image)) };
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
): Promise<{ state: DaemonState; process: SupervisedProcess }> {
  return until(
    `${slot.id} (celld from ${slot.image}) to serve "${version}" from its own process`,
    DEADLINE_MS,
    async () => {
      const state = await stateOf(slot);
      const ready = state.processes.find(isReady);
      const port = state.reconcile?.processes.find(
        (entry) => entry.application === APPLICATION,
      )?.port;
      if (ready === undefined || port === undefined) return null;

      const answer = await httpGet(slot.holder.getMappedPort(port), "/", { host: HOST });
      return answer.status === 200 && answer.body.includes(`"${version}"`)
        ? { state, process: ready }
        : null;
    },
    { context: () => slot.log.join("").slice(-6000) },
  );
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
