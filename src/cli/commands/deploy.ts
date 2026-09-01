/* `scafo deploy`: pack a built project, hand it to a node, and watch it land. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { DeployStatus } from "../../daemon/deploys.ts";
import {
  DEPLOY_METADATA_HEADER,
  encodeDeployMetadata,
  type DeployMetadata,
} from "../../daemon/_intake.ts";
import type { StagedArtifact } from "../../core/types/deploy.ts";
import { ScafoError } from "../../core/error.ts";
import { parseReplicas } from "../../core/placement/replicas.ts";
import { parseLabels } from "../../core/utils/labels.ts";
import { packDirectory } from "../../drivers/archive/tar-zst.ts";
import { nodeBaseUrl, nodeRequest, type Authorize, operatorSigner } from "../_node.ts";
import { resolveOperatorHome } from "../_home.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/** Time between two looks at a deploy's status. */
export const DEFAULT_POLL_MS: number = 1000;

/** States a deploy stops moving in. */
const SETTLED: string[] = ["deployed", "failed"];

const deployArgs: ArgsDef = {
  "dir": { type: "positional", description: "Directory holding the built project" },
  "node": {
    type: "string",
    description: "Base URL of the node daemon; without it the chosen remote says where",
  },
  "remote": { type: "string", description: "Remote to deploy to, out of this operator's home" },
  "project": { type: "string", description: "Project slug to deploy into", required: true },
  "env": { type: "string", description: "Environment to deploy into (production)" },
  "script": { type: "string", description: "Name the runtime files the app under" },
  "no-bundle": {
    type: "boolean",
    description: "Use a pre-bundled, self-contained Worker entry",
  },
  "replicas": {
    type: "string",
    description: "How many nodes serve this environment: a whole number, or all",
  },
  "node-selector": {
    type: "string",
    description: "Labels a node must carry to serve this environment (region=eu-west-1,tier=fast)",
  },
  "key": { type: "string", description: `Operator key to sign with: ${OPERATOR_KEY_FORMS}` },
  "config": {
    type: "string",
    description: "Path to scafo.config.jsonc, read for its remote pin",
  },
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
  const project = text(flags.project) as string;
  const environment = text(flags.env) ?? "production";
  const fixed = text(flags.token);

  /*
   * A token stands in for the whole operator identity — it is what a CI job
   * holds INSTEAD of a key — so nothing is resolved for one beyond the address,
   * which the flag has to carry because a workload has no operator home.
   */
  const resolved =
    fixed === undefined
      ? await resolveOperator({
          home: resolveOperatorHome(),
          env: process.env,
          flags: operatorFlags(flags),
          readFile: readTextFile,
        })
      : null;
  const nodeUrl = nodeBaseUrl(requiredNode(text(flags.node) ?? resolved?.nodeUrl));
  const signer = resolved === null ? null : operatorSigner(await resolved.readKey());
  const authorize = async (): Promise<string> => fixed ?? (await (signer as Authorize)());

  /* Read before the directory is packed, so a malformed flag costs nothing. */
  const wantedReplicas = text(flags.replicas);
  const replicas = wantedReplicas === undefined ? undefined : parseReplicas(wantedReplicas);
  const wantedSelector = text(flags["node-selector"]);
  const nodeSelector =
    wantedSelector === undefined ? undefined : parseLabels(wantedSelector, "--node-selector");
  console.log(`scafo: packing ${dir}`);
  const artifact = await packDirectory(dir);

  const meta = {
    environment,
    script: text(flags.script) ?? project,
    ...(flags["no-bundle"] === true ? { noBundle: true as const } : {}),
    /* Only when they were asked for: a deploy that names no replica count and no
       selector must leave whatever the environment already carries exactly as it
       is. Neither flag can lift a constraint — that is `scafo env selector`. */
    ...(replicas === undefined ? {} : { replicas }),
    ...(nodeSelector === undefined ? {} : { nodeSelector }),
  };

  let accepted: Response;
  try {
    accepted = await uploadArtifact({
      nodeUrl,
      token: await authorize(),
      project,
      metadata: meta,
      artifact,
    });
  } finally {
    await artifact.dispose();
  }
  const status = (await accepted.json()) as DeployStatus;
  const location = accepted.headers.get("location") ?? `/v1/deploys/${status.id}`;

  console.log(`scafo: deploy ${status.id} ${status.state}`);
  await watch(new URL(location, `${nodeUrl}/`).href, authorize, status);
}

export interface DeployUploadOptions {
  nodeUrl: string;
  token: string;
  project: string;
  metadata: DeployMetadata;
  artifact: StagedArtifact;
  fetchFn?: typeof fetch;
}

/** Sends the file-backed artifact as the raw streaming deploy request body. */
export function uploadArtifact(opts: DeployUploadOptions): Promise<Response> {
  return nodeRequest(
    `${opts.nodeUrl}/v1/projects/${encodeURIComponent(opts.project)}/deploys`,
    opts.token,
    {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        [DEPLOY_METADATA_HEADER]: encodeDeployMetadata(opts.metadata),
      },
      body: opts.artifact.open(),
      duplex: "half",
      ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
    },
  );
}

/** Polls a deploy, printing each state it moves into, until it settles. */
async function watch(url: string, authorize: Authorize, from: DeployStatus): Promise<DeployStatus> {
  let last = from;

  for (;;) {
    if (SETTLED.includes(last.state)) return last;
    await delay(DEFAULT_POLL_MS);

    const status = (await (await nodeRequest(url, await authorize())).json()) as DeployStatus;
    if (status.state !== last.state) console.log(`scafo: deploy ${status.id} ${status.state}`);
    last = status;
    if (!SETTLED.includes(status.state)) continue;

    if (status.state === "failed") {
      throw new ScafoError("invalid-input", "Deploy failed", { detail: status.detail });
    }
    if (status.build !== undefined) console.log(`scafo: build ${status.build}`);
    return status;
  }
}

/** Where the deploy is sent, which nothing here can guess at. */
function requiredNode(url: string | undefined): string {
  if (url !== undefined) return url;

  throw new ScafoError("invalid-input", "No node to deploy to", {
    detail:
      `pass --node <url>, or register the installation this belongs to with ` +
      `"scafo remote add <name> --endpoint <url>" so that it says where`,
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
