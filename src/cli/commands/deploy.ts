/* `scafo deploy`: pack a built project, hand it to a node, and watch it land. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { DeployStatus } from "../../agent/deploys.ts";
import { ScafoError } from "../../core/error.ts";
import { parseReplicas } from "../../core/placement/replicas.ts";
import { parseLabels } from "../../core/utils/labels.ts";
import { packDirectory } from "../../drivers/archive/tar-zst.ts";
import { agentBaseUrl, agentRequest, type Authorize, operatorSigner } from "../_agent.ts";
import { agentOps, describeSplitChange } from "../_environments.ts";
import { resolveOperatorHome } from "../_home.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/** Time between two looks at a deploy's status. */
export const DEFAULT_POLL_MS: number = 1000;

/** States a deploy stops moving in. */
const SETTLED: string[] = ["routed", "deployed", "failed"];

const deployArgs: ArgsDef = {
  "dir": { type: "positional", description: "Directory holding the built project" },
  "agent": {
    type: "string",
    description: "Base URL of the node agent; without it the chosen fleet says where",
  },
  "fleet": { type: "string", description: "Fleet to deploy to, out of this operator's home" },
  "project": { type: "string", description: "Project slug to deploy into", required: true },
  "env": { type: "string", description: "Environment to deploy into (production)" },
  "script": { type: "string", description: "Name the runtime files the app under" },
  "flip": { type: "boolean", description: "Point the environment's alias at the new build" },
  "canary": {
    type: "string",
    description:
      "Send this percent of the environment's traffic to the new build, without flipping",
  },
  "runtime-configurable": {
    type: "boolean",
    description: "The build reads its configuration at runtime, not at build time",
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
  "config": { type: "string", description: "Path to scafo.config.jsonc, read for its fleet pin" },
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
  const agent = agentBaseUrl(requiredAgent(text(flags.agent) ?? resolved?.agentUrl));
  const signer = resolved === null ? null : operatorSigner(await resolved.readKey());
  const authorize = async (): Promise<string> => fixed ?? (await (signer as Authorize)());

  /* Read before the directory is packed, so a malformed flag costs nothing. */
  const wantedReplicas = text(flags.replicas);
  const replicas = wantedReplicas === undefined ? undefined : parseReplicas(wantedReplicas);
  const wantedSelector = text(flags["node-selector"]);
  const nodeSelector =
    wantedSelector === undefined ? undefined : parseLabels(wantedSelector, "--node-selector");
  const canary = readCanaryFlag(flags);

  console.log(`scafo: packing ${dir}`);
  const artifact = await packDirectory(dir);

  const meta = {
    project,
    environment,
    runtimeConfigurable: flags["runtime-configurable"] === true,
    /* A canary is the opposite of a flip and the two are refused together, so
       this is already false whenever one was asked for. */
    flip: flags.flip === true,
    ...(text(flags.script) === undefined ? {} : { script: text(flags.script) }),
    /* Only when they were asked for: a deploy that names no replica count and no
       selector must leave whatever the environment already carries exactly as it
       is. Neither flag can lift a constraint — that is `scafo env selector`. */
    ...(replicas === undefined ? {} : { replicas }),
    ...(nodeSelector === undefined ? {} : { nodeSelector }),
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

  console.log(`scafo: deploy ${status.id} ${status.state}`);
  const settled = await watch(new URL(location, `${agent}/`).href, authorize, status);
  if (canary === undefined) return;

  const build = settled.build;
  if (build === undefined) {
    throw new ScafoError("invalid-input", "Nothing to send the canary traffic to", {
      detail: `deploy ${settled.id} settled as "${settled.state}" without recording a build`,
    });
  }

  /*
   * The environment's own traffic is divided only AFTER the build exists, and
   * the node weighs it against whatever the alias points at right then. A first
   * deploy has no alias to weigh against and is refused there, naming --flip:
   * an application's first build goes into service outright, and there is no
   * such thing as easing traffic onto the only thing that serves it.
   */
  const target = { project, env: environment };
  const record = await agentOps({ url: agent, authorize }).canary(target, {
    build,
    weight: canary,
  });
  console.log(describeSplitChange(target, record));
}

/** Polls a deploy, printing each state it moves into, until it settles. */
async function watch(url: string, authorize: Authorize, from: DeployStatus): Promise<DeployStatus> {
  let last = from;

  for (;;) {
    if (SETTLED.includes(last.state)) return last;
    await delay(DEFAULT_POLL_MS);

    const status = (await (await agentRequest(url, await authorize())).json()) as DeployStatus;
    if (status.state !== last.state) console.log(`scafo: deploy ${status.id} ${status.state}`);
    last = status;
    if (!SETTLED.includes(status.state)) continue;

    for (const warning of status.warnings)
      console.warn(`scafo: ${warning.code}: ${warning.detail}`);
    if (status.state === "failed") {
      throw new ScafoError("invalid-input", "Deploy failed", { detail: status.detail });
    }
    if (status.build !== undefined) console.log(`scafo: build ${status.build}`);
    return status;
  }
}

/**
 * The percent `--canary` asks for, or undefined when it was not given.
 *
 * REFUSED ALONGSIDE `--flip`, because they are opposite intentions: a flip makes
 * the new build the whole of what the environment serves, a canary deliberately
 * leaves the current one serving most of it. A command carrying both says
 * nothing about which was meant. The RANGE is the registry's to judge, so the
 * refusal reads the same however the split was set.
 */
function readCanaryFlag(flags: Record<string, unknown>): number | undefined {
  const stated = text(flags.canary);
  if (stated === undefined) return undefined;

  if (flags.flip === true) {
    throw new ScafoError("invalid-input", "Conflicting arguments", {
      detail:
        `--flip puts the new build in front of all of this environment's traffic and ` +
        `--canary ${stated} puts it in front of some; pass one of them`,
    });
  }
  if (!/^\d+$/.test(stated)) {
    throw new ScafoError("invalid-input", "Invalid canary weight", {
      detail: `--canary "${stated}" must be a whole number of percent, such as --canary 10`,
    });
  }
  return Number(stated);
}

/** Where the deploy is sent, which nothing here can guess at. */
function requiredAgent(url: string | undefined): string {
  if (url !== undefined) return url;

  throw new ScafoError("invalid-input", "No node to deploy to", {
    detail:
      `pass --agent <url>, or register the fleet this belongs to with ` +
      `"scafo fleet add <name> --endpoint <url>" so that it says where`,
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
