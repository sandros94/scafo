/*
 * What every end-to-end suite needs and none of them is about: the images and
 * deadlines they agree on, a bucket to point at, the fixture application staged
 * with a version in it, requests that can set a `Host` header, the built CLI run
 * the way an operator runs it, and a poll that fails with something worth
 * reading.
 *
 * Deliberately stateless — functions and constants, no module-level containers —
 * so a suite owns its own topology and this owns none of it. The topology is
 * exactly what differs between the suites (one node or two, Caddy or Traefik),
 * and it is the part worth reading in each of them.
 */

import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { S3Client } from "uns3";
import type { RegistryContext } from "../../src/core/registry/index.ts";
import { createUns3Store } from "../../src/drivers/store/uns3.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** Root of the worktree the suites build and bind-mount into the agent image. */
export const REPO_ROOT: string = resolve(HERE, "../..");
/** Fixtures every suite copies from: the application, and the ingress configs. */
export const FIXTURES: string = join(HERE, "_e2e-fixtures");
/** The built CLI, run as an operator's `scalo` would be. */
export const CLI: string = join(REPO_ROOT, "dist/cli/index.mjs");

export const STORE_IMAGE: string = "chrislusf/seaweedfs:4.42";
/** node24 + celld + esbuild; built locally, see the AGENTS.md note on the suites. */
export const AGENT_IMAGE: string = "scalo-v13-probe";
/** S3 port inside the store container. */
export const STORE_PORT: number = 8333;

/*
 * Every container stays on docker's default bridge, and the containers address
 * each other by address on it.
 *
 * Deliberately NOT a user-defined network: testcontainers attaches a container
 * given one to that network AND to the default bridge, and a container on two
 * networks answers a published-port connection from the wrong address, so the
 * host's connection is reset. The bridge alone gives both what these suites need
 * — the containers reach each other, and the host reaches the published ports.
 */
export const BRIDGE_NETWORK: string = "bridge";

export const SETUP_TIMEOUT_MS: number = 300_000;
export const STEP_TIMEOUT_MS: number = 180_000;
/** Per-assertion ceiling; the reconcile interval is 5s, so this is many passes. */
export const DEADLINE_MS: number = 120_000;
export const BOOT_DEADLINE_MS: number = 60_000;
/** SeaweedFS is the slowest thing here to become useful, by a wide margin. */
export const STORE_DEADLINE_MS: number = 120_000;
export const POLL_MS: number = 500;

/** The bucket credentials the suites and the nodes they start both use. */
export interface BucketSettings {
  bucket: string;
  prefix: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

/** A running store, addressed differently by the host and by the containers. */
export interface StartedStore {
  container: StartedTestContainer;
  /** Endpoint the test process, on the host, reaches the bucket at. */
  fromHost: string;
  /** Endpoint a container on the bridge reaches it at, by address rather than name. */
  fromContainers: string;
}

/**
 * Starts SeaweedFS, waits until its S3 gateway is really serving, and creates
 * the bucket the suite will use.
 */
export async function startStore(settings: BucketSettings): Promise<StartedStore> {
  const container = await new GenericContainer(STORE_IMAGE)
    .withCommand(["server", "-s3"])
    .withExposedPorts(STORE_PORT)
    /* The S3 gateway starts well after the port it will listen on is bound, so
       the port alone is not readiness — this line is. */
    .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/))
    .withStartupTimeout(STORE_DEADLINE_MS)
    .start();

  const fromHost = `http://${container.getHost()}:${String(container.getMappedPort(STORE_PORT))}`;
  /* By address rather than by name: an agent sharing the ingress container's
     namespace would resolve a name there, and an address needs no resolver. */
  const fromContainers = `http://${container.getIpAddress(BRIDGE_NETWORK)}:${String(STORE_PORT)}`;

  await createBucket(fromHost, settings.bucket);
  return { container, fromHost, fromContainers };
}

/** The registry as the test process reads it, straight from the bucket. */
export function registryAt(endpoint: string, settings: BucketSettings): RegistryContext {
  return {
    store: createUns3Store(
      new S3Client({
        endpoint,
        region: settings.region,
        credentials: { accessKeyId: settings.accessKey, secretAccessKey: settings.secretKey },
        bucketStyle: "path",
        defaultBucket: settings.bucket,
      }),
      { bucket: settings.bucket, prefix: settings.prefix },
    ),
  };
}

/** The bucket settings as the CLI and the agent read them from an environment. */
export function storeEnv(endpoint: string, settings: BucketSettings): Record<string, string> {
  return {
    SCALO_S3_ENDPOINT: endpoint,
    SCALO_S3_BUCKET: settings.bucket,
    SCALO_S3_PREFIX: settings.prefix,
    SCALO_S3_ACCESS_KEY: settings.accessKey,
    SCALO_S3_SECRET_KEY: settings.secretKey,
    SCALO_S3_REGION: settings.region,
  };
}

/**
 * Creates the bucket with an anonymous PUT, retrying because SeaweedFS answers
 * on its S3 port before it is willing to serve bucket operations on it.
 */
export async function createBucket(endpoint: string, bucket: string): Promise<void> {
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

/** A copy of the fixture application with its version variable set to `version`. */
export async function stageApp(version: string, keep: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `scalo-e2e-app-${version}-`));
  keep.push(dir);
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

/** The build id the CLI printed for a settled deploy. */
export function buildIdOf(output: string): string {
  const build = /scalo: build ([\da-f]{8,64})/.exec(output)?.[1];
  if (build === undefined) throw new Error(`the deploy named no build:\n${output}`);
  return build;
}

export interface HttpAnswer {
  status: number;
  body: string;
}

/**
 * One GET, over `node:http` rather than `fetch` so the `Host` header can be set:
 * every routing assertion in these suites is about which host was asked for.
 */
export function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<HttpAnswer> {
  return send(port, path, "GET", headers, undefined);
}

export function httpPost(
  port: number,
  path: string,
  body: unknown,
  token: string,
): Promise<HttpAnswer> {
  return send(
    port,
    path,
    "POST",
    { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    JSON.stringify(body),
  );
}

export function send(
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

/**
 * Requests one traffic-split assertion sends through an ingress.
 *
 * TWO FULL WEIGHT CYCLES, and the number is load-bearing rather than a round
 * one. The weights of a split sum to 100, and BOTH ingresses walk a cycle of
 * exactly that length — so any 200 consecutive requests contain exactly twice
 * each leg's weight, whatever point in the cycle the sample happens to start at.
 * The measurement is therefore exact rather than statistical.
 *
 * A SHORTER SAMPLE IS NOT MERELY NOISIER, IT IS WRONG, and the two ingresses
 * disagree about how. Pinned by reading the response sequence off each
 * container for an even split:
 *
 *   Caddy 2.11.4   AAAA…(50)…AAAA BBBB…(50)…BBBB   — one BLOCK per leg
 *   Traefik 3.7.10 ABABABABABABABABABABABABABAB…   — perfectly interleaved
 *
 * Caddy's `weighted_round_robin` hands a leg its whole weight in consecutive
 * requests before moving on, so a 40-request window can land entirely inside one
 * block and see a single build, or straddle a boundary and report 9/31 for a
 * 50/50 — which is what a first attempt at this assertion did. Traefik's
 * weighted service is smooth and would have passed either way. Neither is wrong;
 * they are correct over a cycle and say nothing in particular over less than one.
 */
export const SPLIT_SAMPLE: number = 200;

/**
 * The least share of {@link SPLIT_SAMPLE} a leg of an even split must take.
 *
 * DELIBERATELY GENEROUS — the sample above makes an even split land on exactly
 * half, so this leaves a wide margin. What is being asserted is that both builds
 * are really serving, which is to say that the split reached the registry, the
 * planner, two processes, the routing and the ingress. How precisely a policy
 * divides the traffic is the ingress's own business, and is pinned exactly
 * against both containers in their driver suites.
 */
export const SPLIT_MIN_SHARE: number = 0.25;

/** {@link SPLIT_MIN_SHARE} of {@link SPLIT_SAMPLE}, as whole requests. */
export const SPLIT_MIN_REQUESTS: number = Math.ceil(SPLIT_SAMPLE * SPLIT_MIN_SHARE);

/**
 * Sends `count` requests to one host and counts which application version
 * answered each, so a weighted split can be read off the wire.
 *
 * A request that did not answer 200 is counted under its status rather than
 * dropped: a sample that quietly ignored the failures would report a clean split
 * while half of it was 502s.
 */
export async function sampleVersions(
  port: number,
  host: string,
  count: number = SPLIT_SAMPLE,
): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};

  for (let i = 0; i < count; i++) {
    const answer = await httpGet(port, "/", { host });
    const version =
      answer.status === 200 ? versionIn(answer.body) : `status ${String(answer.status)}`;
    seen[version] = (seen[version] ?? 0) + 1;
  }
  return seen;
}

/** The version the fixture application reported, or what was wrong with the body. */
function versionIn(body: string): string {
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "no version";
  } catch {
    return "not json";
  }
}

export interface UntilOptions {
  /**
   * What to attach to a deadline that ran out — the agent container's logs, in
   * every suite. A timeout says only that something did not happen; this is the
   * account of what the node was doing instead.
   */
  context?: () => string;
}

/** Polls until `probe` returns a value, or the deadline runs out. */
export async function until<T>(
  what: string,
  deadlineMs: number,
  probe: () => Promise<T | null>,
  opts?: UntilOptions,
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
      const context = opts?.context === undefined ? "" : `\n${opts.context()}`;
      throw new Error(
        `timed out after ${String(deadlineMs)}ms waiting for ${what}${reason}${context}`,
      );
    }
    await delay(POLL_MS);
  }
}

/** A failure as a message, whether or not the thrown value was an `Error`. */
export function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

export interface CommandResult {
  code: number;
  output: string;
}

/** Runs the built CLI the way an operator would, with a deliberately clean environment. */
export function runCli(args: string[], extraEnv: Record<string, string>): Promise<CommandResult> {
  return run(process.execPath, [CLI, ...args], REPO_ROOT, {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...extraEnv,
  });
}

export function run(
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

/** Builds `dist/`, which the agent container runs off the bind-mounted worktree. */
export async function buildRepo(): Promise<void> {
  const built = await run("pnpm", ["build"], REPO_ROOT, process.env as Record<string, string>);
  if (built.code !== 0) throw new Error(`"pnpm build" failed:\n${built.output}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}
