/* Shared E2E fixtures, commands, and polling. Suites own their topology. */

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

/** Root of the worktree the suites build and bind-mount into the node image. */
export const REPO_ROOT: string = resolve(HERE, "../..");
/** Fixtures every suite copies from: the application, and the ingress configs. */
export const FIXTURES: string = join(HERE, "_e2e-fixtures");
/** The built CLI, run as an operator's `scafo` would be. */
export const CLI: string = join(REPO_ROOT, "dist/cli/index.mjs");

export const STORE_IMAGE: string = "chrislusf/seaweedfs:4.42";
/** The `probe` target of the repo Dockerfile: `docker build --target probe -t scafo-probe .` */
export const NODE_IMAGE: string = "scafo-probe";
/** S3 port inside the store container. */
export const STORE_PORT: number = 8333;

/*
 * Every container stays on docker's default bridge, and the containers address
 * each other by address on it.
 *
 * Deliberately not a user-defined network: testcontainers attaches a container
 * given one to that network and to the default bridge, and a container on two
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
/** A blocked local tunnel must not consume the whole store readiness budget. */
export const STORE_ATTEMPT_TIMEOUT_MS: number = 10_000;
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
  /* By address rather than by name: a daemon sharing the ingress container's
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

/** The bucket settings as the CLI and the daemon read them from an environment. */
export function storeEnv(endpoint: string, settings: BucketSettings): Record<string, string> {
  return {
    SCAFO_S3_ENDPOINT: endpoint,
    SCAFO_S3_BUCKET: settings.bucket,
    SCAFO_S3_PREFIX: settings.prefix,
    SCAFO_S3_ACCESS_KEY: settings.accessKey,
    SCAFO_S3_SECRET_KEY: settings.secretKey,
    SCAFO_S3_REGION: settings.region,
  };
}

/**
 * Creates the bucket with an anonymous PUT, retrying because SeaweedFS answers
 * on its S3 port before it is willing to serve bucket operations on it.
 */
export interface CreateBucketOptions {
  /** Test seam; production callers use the platform fetch. */
  fetchFn?: typeof fetch;
  /** Whole readiness budget; only tests should make it shorter. */
  deadlineMs?: number;
  /** One blocked connection's share of the readiness budget. */
  attemptTimeoutMs?: number;
}

export async function createBucket(
  endpoint: string,
  bucket: string,
  opts: CreateBucketOptions = {},
): Promise<void> {
  const giveUp = Date.now() + (opts.deadlineMs ?? STORE_DEADLINE_MS);
  const fetchFn = opts.fetchFn ?? fetch;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? STORE_ATTEMPT_TIMEOUT_MS;
  let last = "no attempt was made";

  for (;;) {
    const remainingMs = giveUp - Date.now();
    if (remainingMs <= 0)
      throw new Error(`could not create bucket "${bucket}" at ${endpoint}; last: ${last}`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("bucket request timed out")),
      Math.min(attemptTimeoutMs, remainingMs),
    );
    try {
      const response = await fetchFn(`${endpoint}/${bucket}`, {
        method: "PUT",
        signal: controller.signal,
      });
      if (response.ok || response.status === 409) return;
      last = `answered ${String(response.status)}: ${(await response.text()).slice(0, 200)}`;
    } catch (error) {
      last = describeFailure(error);
    } finally {
      clearTimeout(timeout);
    }
    if (Date.now() >= giveUp) {
      throw new Error(`could not create bucket "${bucket}" at ${endpoint}; last: ${last}`);
    }
    await delay(POLL_MS);
  }
}

/** A copy of the fixture application with its version variable set to `version`. */
export async function stageApp(version: string, keep: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `scafo-e2e-app-${version}-`));
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
  const build = /scafo: build ([\da-f]{8,64})/.exec(output)?.[1];
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

export interface UntilOptions {
  /**
   * What to attach to a deadline that ran out — the daemon container's logs, in
   * every suite. A timeout says only that something did not happen; this is the
   * account of what the node was doing instead.
   */
  context?: () => string | Promise<string>;
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
      const context = opts?.context === undefined ? "" : `\n${await opts.context()}`;
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

export interface CommandOptions {
  /** Bounds one host command so an end-to-end assertion can report its next state. */
  timeoutMs?: number;
}

/** Runs the built CLI the way an operator would, with a deliberately clean environment. */
export function runCli(
  args: string[],
  extraEnv: Record<string, string>,
  opts: CommandOptions = {},
): Promise<CommandResult> {
  return run(
    process.execPath,
    [CLI, ...args],
    REPO_ROOT,
    {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...extraEnv,
    },
    opts,
  );
}

export function run(
  command: string,
  args: string[],
  cwd: string,
  childEnv: Record<string, string>,
  opts: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((settle, fail) => {
    const child = spawn(command, args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });

    let output = "";
    let settled = false;
    const timeoutMs = opts.timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      settle(result);
    };
    const failOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      fail(error);
    };
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          code: -1,
          output: `${output}${output === "" || output.endsWith("\n") ? "" : "\n"}command timed out after ${String(timeoutMs)}ms`,
        });
      }, timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));

    child.on("error", failOnce);
    child.on("close", (code) => finish({ code: code ?? -1, output }));
  });
}

/** Builds `dist/`, which the daemon container runs off the bind-mounted worktree. */
export async function buildRepo(): Promise<void> {
  const built = await run("pnpm", ["build"], REPO_ROOT, process.env as Record<string, string>);
  if (built.code !== 0) throw new Error(`"pnpm build" failed:\n${built.output}`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}
