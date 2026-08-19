/* `scalo deploy`: pack a built project, hand it to a node, and watch it land. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { DeployStatus } from "../../agent/deploys.ts";
import { ScaloError } from "../../core/error.ts";
import { parseReplicas } from "../../core/placement/replicas.ts";
import { packDirectory } from "../../drivers/archive/tar-zst.ts";
import { DEFAULT_KEY_PATH } from "./keygen.ts";
import { agentBaseUrl, agentRequest, type Authorize, operatorSigner } from "../_agent.ts";
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
  const agent = agentBaseUrl(text(flags.agent) as string);
  const project = text(flags.project) as string;
  const environment = text(flags.env) ?? "production";
  const fixed = text(flags.token);
  const mint =
    fixed === undefined ? await operatorSigner(text(flags.key) ?? DEFAULT_KEY_PATH) : null;
  const authorize = async (): Promise<string> => fixed ?? (await (mint as Authorize)());

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

  const accepted = await agentRequest(`${agent}/v1/deploys`, await authorize(), {
    method: "POST",
    body,
  });
  const status = (await accepted.json()) as DeployStatus;
  const location = accepted.headers.get("location") ?? `/v1/deploys/${status.id}`;

  console.log(`scalo: deploy ${status.id} ${status.state}`);
  await watch(new URL(location, `${agent}/`).href, authorize, status.state);
}

/** Polls a deploy, printing each state it moves into, until it settles. */
async function watch(url: string, authorize: Authorize, from: string): Promise<void> {
  let last = from;

  for (;;) {
    if (SETTLED.includes(last)) break;
    await delay(DEFAULT_POLL_MS);

    const status = (await (await agentRequest(url, await authorize())).json()) as DeployStatus;
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

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
