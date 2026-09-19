/*
 * One fresh installation: a network of its own, a store, the delay proxy every
 * client reaches it through, and N node containers.
 *
 * ONE PER CELL OF THE SWEEP. Nothing is reused between a profile×latency cell
 * and the next, because a benchmark whose second cell starts on the first one's
 * warm caches measures the order it ran in. Everything created here carries the
 * run's label and is removed by `removeLabelled`.
 */

import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureRandomNumber } from "unsecure/random";
import { safeJsonParse } from "unsecure/sanitize";
import { signNodeToken } from "../../src/core/auth/node-token.ts";
import type { OperatorKeyFile } from "../../src/cli/_operator-key.ts";
import type { DaemonState } from "../../src/daemon/app.ts";
import { delay, engine, engineOk, RUN_LABEL, run, type ContainerEngine } from "./_engine.ts";

/** The label one cell's own containers, network and volumes carry. */
export const CELL_LABEL: string = "scafo-scale-real-cell";

/** S3 port inside the store container, and the port the proxy stands in for it on. */
const STORE_PORT = 8333;
/** SeaweedFS's Prometheus endpoint, enabled so the store's own view is readable. */
const STORE_METRICS_PORT = 9327;
/** Where the proxy answers with its counters. */
const PROXY_STATS_PORT = 9099;
/** The node API listener inside a node container. */
const NODE_API_PORT = 7400;
/** Where every node container keeps what it must remember between boots. */
export const STATE_DIR: string = "/var/lib/scafo";

export const BUCKET: string = "scafo-scale-real";
export const KEY_PREFIX: string = "scale";
const ACCESS_KEY = "scafo";
const SECRET_KEY = "scafo-secret";
const REGION = "us-east-1";
export const PLATFORM_DOMAIN: string = "scafo.test";

const BOOT_DEADLINE_MS = 180_000;
const STORE_DEADLINE_MS = 180_000;
const POLL_MS = 500;

/** A machine size a cell emulates, as `--cpus`/`--memory` express it. */
export interface Profile {
  name: string;
  cpus: number;
  memoryGb: number;
}

export interface InstallationSettings {
  container: ContainerEngine;
  runId: string;
  /** Index of the cell in the sweep; names and the subnet are derived from it. */
  cell: number;
  profile: Profile;
  latencyMs: number;
  nodes: number;
  repoRoot: string;
  image: string;
  storeImage: string;
}

/** One node container of an installation. */
export interface NodeHandle {
  id: string;
  /** Container name, which is also what the engine is asked about. */
  name: string;
  /** Address the other containers reach this node's API at. */
  ip: string;
  /** Host port the published node API answers on. */
  apiPort: number;
  volume: string;
}

export interface Installation {
  settings: InstallationSettings;
  network: string;
  nodes: NodeHandle[];
  storeName: string;
  proxyName: string;
  /** The bucket as the host reaches it: through the proxy, like everything else. */
  storeFromHost: string;
  /** The bucket as a container reaches it. */
  storeFromContainers: string;
  proxyStatsPort: number;
  storeMetricsPort: number;
  /** When the first node container was created; the boot phase is measured from it. */
  nodesStartedAt: number;
  /** Where the operator key this installation's CLI runs with was written. */
  keyPath: string;
  operatorKey: OperatorKeyFile;
}

/** Brings one installation up and leaves it serving. */
export async function startInstallation(
  settings: InstallationSettings,
  progress: (line: string) => void,
): Promise<Installation> {
  const container = settings.container;
  const prefix = `scafo-scale-${settings.runId}-${String(settings.cell)}`;
  /* The run's label removes everything at the end; the cell's removes this
     installation as soon as the next cell is due to start fresh. */
  const label = [
    "--label",
    `${RUN_LABEL}=${settings.runId}`,
    "--label",
    `${CELL_LABEL}=${settings.runId}-${String(settings.cell)}`,
  ];

  const { network, subnet } = await createNetwork(container, prefix, label);
  const address = (last: number): string => `${subnet}.${String(last)}`;

  const storeName = `${prefix}-store`;
  progress(`starting the store (${settings.storeImage})`);
  await engineOk(container, [
    "run",
    "-d",
    ...label,
    "--name",
    storeName,
    "--network",
    network,
    "--ip",
    address(10),
    "-p",
    `127.0.0.1::${String(STORE_METRICS_PORT)}`,
    settings.storeImage,
    "server",
    "-s3",
    `-metricsPort=${String(STORE_METRICS_PORT)}`,
  ]);
  await untilLog(container, storeName, /Start Seaweed S3 API Server/, STORE_DEADLINE_MS);

  const proxyName = `${prefix}-proxy`;
  progress(`starting the delay proxy at ${String(settings.latencyMs)}ms`);
  await engineOk(container, [
    "run",
    "-d",
    ...label,
    "--name",
    proxyName,
    "--network",
    network,
    "--ip",
    address(11),
    "-p",
    `127.0.0.1::${String(STORE_PORT)}`,
    "-p",
    `127.0.0.1::${String(PROXY_STATS_PORT)}`,
    "-v",
    `${settings.repoRoot}:/work:ro`,
    "-w",
    "/work",
    settings.image,
    "node",
    "scripts/scale-real/delay-proxy.mjs",
    "--listen",
    `0.0.0.0:${String(STORE_PORT)}`,
    "--upstream",
    `${address(10)}:${String(STORE_PORT)}`,
    "--stats",
    `0.0.0.0:${String(PROXY_STATS_PORT)}`,
    "--delay-ms",
    String(settings.latencyMs),
  ]);
  await untilLog(container, proxyName, /delay-proxy: listening/, BOOT_DEADLINE_MS);

  const proxyPort = await publishedPort(container, proxyName, STORE_PORT);
  const proxyStatsPort = await publishedPort(container, proxyName, PROXY_STATS_PORT);
  const storeMetricsPort = await publishedPort(container, storeName, STORE_METRICS_PORT);
  const storeFromHost = `http://127.0.0.1:${String(proxyPort)}`;
  const storeFromContainers = `http://${address(11)}:${String(STORE_PORT)}`;

  await createBucket(storeFromHost);

  const nodes: NodeHandle[] = [];
  const nodesStartedAt = Date.now();
  for (let index = 0; index < settings.nodes; index++) {
    const id = `node-${String.fromCodePoint(97 + index)}`;
    const name = `${prefix}-${id}`;
    const volume = `${prefix}-state-${id}`;
    const ip = address(20 + index);
    progress(
      `starting ${id} (${String(settings.profile.cpus)} cpus, ` +
        `${String(settings.profile.memoryGb)}GB)`,
    );

    await engineOk(container, ["volume", "create", ...label, volume]);
    await engineOk(container, [
      "run",
      "-d",
      ...label,
      "--name",
      name,
      "--network",
      network,
      "--ip",
      ip,
      "--cpus",
      String(settings.profile.cpus),
      "--memory",
      `${String(settings.profile.memoryGb)}g`,
      "-p",
      `127.0.0.1::${String(NODE_API_PORT)}`,
      "-v",
      `${settings.repoRoot}:/work:ro`,
      "-v",
      `${volume}:${STATE_DIR}`,
      "-w",
      "/work",
      ...envArgs({
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
        SCAFO_ADVERTISE: `${ip}:${String(NODE_API_PORT)}`,
        SCAFO_BIND_HOST: "0.0.0.0",
        SCAFO_LISTEN: `0.0.0.0:${String(NODE_API_PORT)}`,
        CELLD_ESBUILD: "/usr/local/bin/esbuild",
      }),
      settings.image,
      "node",
      "dist/cli/index.mjs",
      "sail",
    ]);

    nodes.push({
      id,
      name,
      ip,
      apiPort: await publishedPort(container, name, NODE_API_PORT),
      volume,
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "scafo-scale-real-key-"));
  const keyPath = join(dir, "operator.json");
  const keygen = await runCli(
    ["operator", "keygen", "--out", keyPath, "--register"],
    settings.repoRoot,
    storeEnv(storeFromHost),
  );
  if (keygen.code !== 0) throw new Error(`operator keygen failed:\n${keygen.output}`);
  const operatorKey = safeJsonParse<OperatorKeyFile>(await readFile(keyPath, "utf8"));

  return {
    settings,
    network,
    nodes,
    storeName,
    proxyName,
    storeFromHost,
    storeFromContainers,
    proxyStatsPort,
    storeMetricsPort,
    nodesStartedAt,
    keyPath,
    operatorKey,
  };
}

/**
 * Creates the cell's network on a subnet nothing else holds.
 *
 * ADDRESSES RATHER THAN NAMES, because a node's advertised address is written
 * into its registry record before it has one, and every peer and runtime process
 * of the fleet dials what that record says. Each container therefore gets its
 * address from this subnet at creation time.
 */
async function createNetwork(
  container: ContainerEngine,
  prefix: string,
  label: string[],
): Promise<{ network: string; subnet: string }> {
  const refusals: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const subnet = `10.${String(secureRandomNumber(100, 250))}.${String(secureRandomNumber(1, 250))}.0`;
    const created = await engine(container, [
      "network",
      "create",
      ...label,
      "--subnet",
      `${subnet}/24`,
      prefix,
    ]);
    if (created.code === 0) return { network: prefix, subnet: subnet.slice(0, -2) };
    refusals.push(created.output.trim().slice(0, 160));
    /* A name that is already taken is not a subnet collision, and retrying with
       another subnet would never fix it. */
    if (created.output.includes("already exists")) break;
  }
  throw new Error(`could not create a network for ${prefix}: ${refusals.join("; ")}`);
}

function envArgs(environment: Record<string, string>): string[] {
  return Object.entries(environment).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
}

/** The bucket settings as the CLI on the host reads them. */
export function storeEnv(endpoint: string): Record<string, string> {
  return {
    SCAFO_S3_ENDPOINT: endpoint,
    SCAFO_S3_BUCKET: BUCKET,
    SCAFO_S3_PREFIX: KEY_PREFIX,
    SCAFO_S3_ACCESS_KEY: ACCESS_KEY,
    SCAFO_S3_SECRET_KEY: SECRET_KEY,
    SCAFO_S3_REGION: REGION,
  };
}

/**
 * Re-reads the host port a node's API is published on, after the node has been
 * restarted.
 *
 * AN ENGINE PICKS A NEW EPHEMERAL HOST PORT EVERY TIME A CONTAINER STARTS when
 * the publish left the host side open, so the port the restart phase held before
 * the restart is somebody else's, or nobody's, afterwards. This is the only
 * thing the host reaches a node through, so it is re-read rather than assumed.
 */
export async function refreshApiPort(installation: Installation, node: NodeHandle): Promise<void> {
  node.apiPort = await publishedPort(installation.settings.container, node.name, NODE_API_PORT);
}

/** The host port an engine published a container port on. */
async function publishedPort(
  container: ContainerEngine,
  name: string,
  port: number,
): Promise<number> {
  const printed = await engineOk(container, ["port", name, String(port)]);
  const line = printed.split("\n")[0] ?? "";
  const parsed = Number.parseInt(line.slice(line.lastIndexOf(":") + 1), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} published no host port for ${String(port)}: ${printed}`);
  }
  return parsed;
}

/** Waits until a container's log carries `pattern`. */
async function untilLog(
  container: ContainerEngine,
  name: string,
  pattern: RegExp,
  deadlineMs: number,
): Promise<void> {
  await until(`${name} to log ${String(pattern)}`, deadlineMs, async () => {
    const logs = await engine(container, ["logs", name], { timeoutMs: 60_000 });
    return pattern.test(logs.output) ? true : null;
  });
}

/** Creates the bucket with an anonymous PUT, as the integration harness does. */
async function createBucket(endpoint: string): Promise<void> {
  await until("the bucket to be created", STORE_DEADLINE_MS, async () => {
    const response = await fetch(`${endpoint}/${BUCKET}`, {
      method: "PUT",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok || response.status === 409 ? true : null;
  });
}

/* ----------------------------------------------------------------- probing */

export interface HttpAnswer {
  status: number;
  body: string;
}

/** One request to a node's API on the host, with the `Host` header settable. */
export function httpSend(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string>,
): Promise<HttpAnswer> {
  return new Promise<HttpAnswer>((settle, fail) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => settle({ status: response.statusCode ?? 0, body: text }));
    });
    request.on("error", fail);
    request.end();
  });
}

/** A fresh single-use operator token; a spent one is refused as a replay. */
export function operatorToken(installation: Installation): Promise<string> {
  return signNodeToken(installation.operatorKey.privateKey, installation.operatorKey.id);
}

/** What one node currently believes about itself. */
export async function stateOf(installation: Installation, node: NodeHandle): Promise<DaemonState> {
  const answer = await httpSend(node.apiPort, "/v1/state", "GET", {
    authorization: `Bearer ${await operatorToken(installation)}`,
  });
  if (answer.status !== 200) {
    throw new Error(`${node.id} answered /v1/state with ${String(answer.status)}: ${answer.body}`);
  }
  return safeJsonParse<DaemonState>(answer.body);
}

/**
 * The public port each application is served on by one node, as the node itself
 * reports it.
 *
 * READ, NEVER ASSUMED: the range a node draws from is a setting, and a pair may
 * move when a persisted one is found taken. Every probe and every "did the port
 * move" finding of this benchmark starts here.
 */
export async function portsOn(
  installation: Installation,
  node: NodeHandle,
): Promise<Map<string, { port: number; internalPort: number }>> {
  const processes = (await stateOf(installation, node)).reconcile?.processes ?? [];
  return new Map(
    processes.map((entry) => [
      entry.application,
      { port: entry.port, internalPort: entry.internalPort },
    ]),
  );
}

export interface ServedAnswer {
  application: string;
  status: number;
  body: string;
}

/**
 * Asks one node's own runtime ports, from inside its container.
 *
 * There is no ingress in this benchmark — an ingress would be one more thing
 * being measured — so the processes are asked where they listen, over the
 * loopback of the container they run in.
 */
export async function servedOn(
  installation: Installation,
  node: NodeHandle,
  targets: Array<{ application: string; port: number }>,
): Promise<ServedAnswer[]> {
  if (targets.length === 0) return [];
  const script =
    `const targets=${JSON.stringify(targets)};` +
    `(async()=>{const out=[];for(const t of targets){` +
    `try{const r=await fetch("http://127.0.0.1:"+t.port+"/");` +
    `out.push({application:t.application,status:r.status,body:(await r.text()).slice(0,300)});}` +
    `catch(e){out.push({application:t.application,status:0,body:String(e)});}}` +
    `console.log(JSON.stringify(out));})()`;

  const result = await engine(
    installation.settings.container,
    ["exec", node.name, "node", "-e", script],
    { timeoutMs: 120_000 },
  );
  if (result.code !== 0) return targets.map((t) => ({ ...t, status: 0, body: result.output }));
  try {
    return safeJsonParse<ServedAnswer[]>(result.stdout.trim());
  } catch {
    return targets.map((t) => ({ ...t, status: 0, body: result.output }));
  }
}

/** Every runtime process running inside one node container, and its resident size. */
export async function celldProcessesOn(
  installation: Installation,
  node: NodeHandle,
): Promise<Array<{ pid: number; rssBytes: number }>> {
  const script =
    `const fs=require("node:fs");const out=[];` +
    `for(const pid of fs.readdirSync("/proc")){if(!/^\\d+$/.test(pid))continue;try{` +
    `if(fs.readFileSync("/proc/"+pid+"/comm","utf8").trim()!=="celld")continue;` +
    `const m=/VmRSS:\\s+(\\d+) kB/.exec(fs.readFileSync("/proc/"+pid+"/status","utf8"));` +
    `out.push({pid:Number(pid),rssBytes:m?Number(m[1])*1024:0});}catch{}}` +
    `console.log(JSON.stringify(out))`;

  const result = await engine(
    installation.settings.container,
    ["exec", node.name, "node", "-e", script],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) return [];
  try {
    return safeJsonParse<Array<{ pid: number; rssBytes: number }>>(result.stdout.trim());
  } catch {
    return [];
  }
}

/** What the engine says happened to one container: an OOM kill, and restarts. */
export async function containerHealth(
  installation: Installation,
  node: NodeHandle,
): Promise<{ oomKilled: boolean; restarts: number; running: boolean }> {
  const printed = await engine(installation.settings.container, [
    "inspect",
    "-f",
    "{{.State.OOMKilled}} {{.RestartCount}} {{.State.Running}}",
    node.name,
  ]);
  const [oom, restarts, running] = printed.stdout.trim().split(/\s+/);
  return {
    oomKilled: oom === "true",
    restarts: Number.parseInt(restarts ?? "0", 10) || 0,
    running: running === "true",
  };
}

/** The proxy's counters, as of now. */
export interface ProxyCounters {
  connections: number;
  bytesToStore: number;
  bytesFromStore: number;
  requests: Record<string, number>;
  unparsed: number;
}

export async function proxyCounters(installation: Installation): Promise<ProxyCounters> {
  const answer = await httpSend(installation.proxyStatsPort, "/stats", "GET", {});
  if (answer.status !== 200) throw new Error(`the proxy answered ${String(answer.status)}`);
  return safeJsonParse<ProxyCounters>(answer.body);
}

/** The store's own Prometheus counters, by metric name and labels. */
export async function storeMetrics(installation: Installation): Promise<Map<string, number>> {
  const answer = await httpSend(installation.storeMetricsPort, "/metrics", "GET", {});
  const found = new Map<string, number>();
  if (answer.status !== 200) return found;
  for (const line of answer.body.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    const at = line.lastIndexOf(" ");
    const name = line.slice(0, at).trim();
    const value = Number.parseFloat(line.slice(at + 1));
    if (name !== "" && Number.isFinite(value)) found.set(name, value);
  }
  return found;
}

/* ------------------------------------------------------------ the CLI and files */

/** Runs the built CLI the way an operator would. */
export function runCli(
  args: string[],
  repoRoot: string,
  extraEnv: Record<string, string>,
  timeoutMs?: number,
): ReturnType<typeof run> {
  return run(process.execPath, [join(repoRoot, "dist/cli/index.mjs"), ...args], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extraEnv },
    timeoutMs,
  });
}

/**
 * A copy of the end-to-end fixture application with its version variable set.
 *
 * The suites' own fixture rather than one of this script's: it is the smallest
 * application in the repository that says which deployment answered, which is
 * what the burst phase is judged by.
 */
export async function stageApp(repoRoot: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `scafo-scale-real-app-${version}-`));
  await cp(join(repoRoot, "test/integration/_e2e-fixtures/app"), dir, { recursive: true });

  const config = join(dir, "wrangler.jsonc");
  const text = await readFile(config, "utf8");
  await writeFile(config, text.replace(/"APP_VERSION": "[^"]*"/, `"APP_VERSION": "${version}"`));
  return dir;
}

/** Polls until `probe` returns a value, or the deadline runs out. */
export async function until<T>(
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
      const reason = last === null ? "" : `; last: ${describeFailure(last)}`;
      throw new DeadlineMissed(`${what} did not converge within ${String(deadlineMs)}ms${reason}`);
    }
    await delay(POLL_MS);
  }
}

/**
 * A wait that ran out.
 *
 * ITS OWN TYPE because a benchmark reports a deadline as a measurement that did
 * not converge and carries on to the next phase, while anything else is a defect
 * in this script and is allowed to end the cell.
 */
export class DeadlineMissed extends Error {
  override name = "DeadlineMissed";
}

export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

/**
 * Removes every container, network and volume carrying `label`.
 *
 * NOTHING ELSE IS EVER TOUCHED: the filter is the only thing that decides, and
 * every label this script writes belongs to the run that is removing them. Other
 * suites' containers, and other runs', are invisible here.
 */
export async function removeLabelled(
  container: ContainerEngine,
  label: string,
): Promise<{ containers: number; networks: number; volumes: number }> {
  const filter = ["--filter", `label=${label}`];
  const ids = async (args: string[]): Promise<string[]> =>
    (await engine(container, args)).stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

  const containers = await ids(["ps", "-aq", ...filter]);
  if (containers.length > 0) await engine(container, ["rm", "-f", ...containers]);

  const networks = await ids(["network", "ls", "-q", ...filter]);
  if (networks.length > 0) await engine(container, ["network", "rm", ...networks]);

  const volumes = await ids(["volume", "ls", "-q", ...filter]);
  if (volumes.length > 0) await engine(container, ["volume", "rm", "-f", ...volumes]);

  return { containers: containers.length, networks: networks.length, volumes: volumes.length };
}
