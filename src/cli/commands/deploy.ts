/* `scalo deploy`: pack a built project, hand it to a node, and watch it land. */

import { readFile } from "node:fs/promises";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { DeployStatus } from "../../agent/deploys.ts";
import { signNodeToken } from "../../core/auth/node-token.ts";
import { fromProblem, ScaloError } from "../../core/error.ts";
import type { ProblemDetails } from "../../core/error.ts";
import { parseReplicas } from "../../core/placement/replicas.ts";
import { packDirectory } from "../../drivers/archive/tar-zst.ts";
import type { OperatorKeyFile } from "./keygen.ts";
import { DEFAULT_KEY_PATH } from "./keygen.ts";
import { reportFailure } from "../_utils.ts";

/** Time between two looks at a deploy's status. */
export const DEFAULT_POLL_MS: number = 1000;

/** States a deploy stops moving in. */
const SETTLED: string[] = ["routed", "deployed", "failed"];

const deployArgs: ArgsDef = {
  "dir": { type: "positional", description: "Directory holding the built project" },
  "agent": { type: "string", description: "Base URL of the node agent", required: true },
  "project": { type: "string", description: "Project slug to deploy into", required: true },
  "env": { type: "string", description: "Environment to deploy into (production)" },
  "script": { type: "string", description: "Name the runtime files the app under" },
  "flip": { type: "boolean", description: "Point the environment's alias at the new build" },
  "runtime-configurable": {
    type: "boolean",
    description: "The build reads its configuration at runtime, not at build time",
  },
  "replicas": {
    type: "string",
    description: "How many nodes serve this environment: a whole number, or all",
  },
  "key": { type: "string", description: `Operator key file to sign with (${DEFAULT_KEY_PATH})` },
  "token": {
    type: "string",
    /* A node token is spent by the first request that presents it, so one passed
       in cannot also be used for the polling that follows. */
    description: "Bearer token to present instead of signing one; single-use tokens will not poll",
  },
};

export const deploy: CommandDef = defineCommand({
  meta: { name: "deploy", description: "Deploy a built project to a node" },
  args: deployArgs,
  async run({ args }): Promise<void> {
    try {
      await runDeploy(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

async function runDeploy(flags: Record<string, unknown>): Promise<void> {
  const dir = text(flags.dir) ?? ".";
  const agent = (text(flags.agent) as string).replace(/\/$/, "");
  const project = text(flags.project) as string;
  const environment = text(flags.env) ?? "production";
  const fixed = text(flags.token);
  const mint = fixed === undefined ? await signer(text(flags.key) ?? DEFAULT_KEY_PATH) : null;
  const authorize = async (): Promise<string> => fixed ?? (await (mint as () => Promise<string>)());

  /* Read before the directory is packed, so a malformed flag costs nothing. */
  const wantedReplicas = text(flags.replicas);
  const replicas = wantedReplicas === undefined ? undefined : parseReplicas(wantedReplicas);

  console.log(`scalo: packing ${dir}`);
  const artifact = await packDirectory(dir);

  const meta = {
    project,
    environment,
    runtimeConfigurable: flags["runtime-configurable"] === true,
    flip: flags.flip === true,
    ...(text(flags.script) === undefined ? {} : { script: text(flags.script) }),
    /* Only when it was asked for: a deploy that names no replica count must
       leave whatever the environment already carries exactly as it is. */
    ...(replicas === undefined ? {} : { replicas }),
  };

  const body = new FormData();
  body.set("meta", JSON.stringify(meta));
  body.set("artifact", new Blob([artifact as BlobPart]), "artifact.tar.zst");

  const accepted = await request(`${agent}/v1/deploys`, await authorize(), {
    method: "POST",
    body,
  });
  const status = (await accepted.json()) as DeployStatus;
  const location = accepted.headers.get("location") ?? `/v1/deploys/${status.id}`;

  console.log(`scalo: deploy ${status.id} ${status.state}`);
  await watch(new URL(location, `${agent}/`).href, authorize, status.state);
}

/** Polls a deploy, printing each state it moves into, until it settles. */
async function watch(url: string, authorize: () => Promise<string>, from: string): Promise<void> {
  let last = from;

  for (;;) {
    if (SETTLED.includes(last)) break;
    await delay(DEFAULT_POLL_MS);

    const status = (await (await request(url, await authorize())).json()) as DeployStatus;
    if (status.state !== last) {
      last = status.state;
      console.log(`scalo: deploy ${status.id} ${status.state}`);
    }
    if (!SETTLED.includes(status.state)) continue;

    for (const warning of status.warnings)
      console.warn(`scalo: ${warning.code}: ${warning.detail}`);
    if (status.state === "failed") {
      throw new ScaloError("invalid-input", "Deploy failed", { detail: status.detail });
    }
    if (status.build !== undefined) console.log(`scalo: build ${status.build}`);
    break;
  }
}

/**
 * Signs one token per request from a key file.
 *
 * A fresh token every time is not caution but necessity: a node spends the `jti`
 * of each token it accepts, so the second request to present the same one is
 * refused as a replay.
 */
async function signer(path: string): Promise<() => Promise<string>> {
  let file: OperatorKeyFile;
  try {
    file = JSON.parse(await readFile(path, "utf8")) as OperatorKeyFile;
  } catch (error) {
    throw new ScaloError("invalid-input", "Operator key could not be read", {
      detail: `"${path}" is not a key file written by "scalo keygen"`,
      cause: error,
    });
  }
  return () => signNodeToken(file.privateKey, file.id);
}

/**
 * One call to the agent, with a failure answer turned back into the failure it
 * describes.
 *
 * The problem document's own code is kept rather than replaced. It is the stable
 * half of the contract, and a CI job acts on it: `trust-mismatch` says the token
 * is fine and the project does not admit it — a policy to fix — while
 * `auth-invalid` says the token itself did not hold up. Flattening both into one
 * code here would hand the caller the one thing the API is careful to keep
 * distinguishable, already thrown away.
 *
 * An answer that carries no problem document at all is only an HTTP status, so
 * it becomes the generic failure it is.
 */
async function request(url: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  if (response.ok) return response;

  /* Whatever answered may not have been a node at all — a proxy, a gateway, an
     error page — so the body is only used when it looks like a problem
     document, and is otherwise the bare status it really is. */
  const body: unknown = await response.json().catch(() => null);
  const problem = body as Partial<ProblemDetails> | null;
  if (typeof problem?.type !== "string" || typeof problem.title !== "string") {
    throw new ScaloError("invalid-input", `Agent answered ${String(response.status)}`, {
      status: response.status,
      detail: `${init?.method ?? "GET"} ${url}`,
    });
  }
  throw fromProblem({ ...(problem as ProblemDetails), status: response.status });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
