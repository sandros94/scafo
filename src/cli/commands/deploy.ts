/* `scafo deploy`: pack a built project directory, hand it to a node, and watch it land. */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import type { DeployStatus } from "../../daemon/deploys.ts";
import {
  DEPLOY_METADATA_HEADER,
  encodeDeployMetadata,
  type DeployMetadata,
} from "../../daemon/_intake.ts";
import type { StagedArtifact } from "../../core/types/deploy.ts";
import { isScafoError, ScafoError } from "../../core/error.ts";
import { parseReplicas } from "../../core/placement/replicas.ts";
import { parseLabelEntries } from "../../core/utils/labels.ts";
import { packDirectory } from "../../drivers/archive/tar-zst.ts";
import { resolveApplication } from "../_application.ts";
import {
  type ConfigEdit,
  editedConfig,
  isEmptyEdit,
  parseVarFlags,
  readConfiguredName,
} from "../_deploy-config.ts";
import { flagList } from "../_flags.ts";
import { nodeBaseUrl, nodeRequest, type Authorize, operatorSigner } from "../_node.ts";
import { resolveOperatorHome } from "../_home.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/** Time between two looks at a deploy's status. */
export const DEFAULT_POLL_MS: number = 1000;

/** States a deploy stops moving in. */
const SETTLED: string[] = ["deployed", "failed"];

const deployArgs: ArgsDef = {
  "dir": {
    type: "positional",
    required: false,
    default: ".",
    description: "The built project directory to pack",
  },
  "node": {
    type: "string",
    description: "Base URL of the node daemon; without it the chosen remote says where",
  },
  "remote": { type: "string", description: "Remote to deploy to, out of this operator's home" },
  "name": {
    type: "string",
    description: "Application to deploy into; without it the config's own name is used",
  },
  "env": { type: "string", description: "Deploy into the application <name>-<env> instead" },
  "var": {
    type: "string",
    multiple: true,
    valueHint: "KEY:VALUE",
    description:
      "Set a variable in the artifact's runtime config, overriding the config's own vars; " +
      "repeat for more. The value is split at the first colon, so it may contain colons. " +
      "A value written here is visible to the process list and the CI log of the machine " +
      "running this command, and the runtime stores it as plain text in the bucket",
  },
  "bundle": {
    type: "boolean",
    default: true,
    description: "Build the Worker entry on the node",
    negativeDescription: "Use a pre-bundled, self-contained Worker entry",
  },
  "replicas": {
    type: "string",
    description: "How many nodes serve this application: a whole number, or all",
  },
  "node-selector": {
    type: "string",
    multiple: true,
    valueHint: "key=value",
    description: "Label a node must carry to serve this application; one pair per flag",
  },
  "key": { type: "string", description: `Operator key to sign with: ${OPERATOR_KEY_FORMS}` },
  "config": {
    type: "string",
    description: "Path to scafo.config.jsonc, read for its remote pin",
  },
  "token": {
    type: "string",
    /* A node token is spent by the first request that presents it, so one passed
       in cannot also be used for the polling that follows; a workload token the
       application trusts is not spent, and watches the deploy to its end. */
    description:
      "Bearer token to present instead of signing one; a single-use node token cannot watch",
  },
};

export const deploy: CommandDef = defineCommand({
  meta: { name: "deploy", description: "Deploy a built project directory to a node" },
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
  const fixed = text(flags.token);

  /* Without --name the config says which application this is. Read first, so a
     directory that names none costs nothing but the refusal. */
  const application = resolveApplication({
    name: text(flags.name) ?? (await readConfiguredName(dir)),
    env: text(flags.env),
  });

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
  const meta = deployMetadataFrom(flags);
  const edit = configEditFrom(flags);
  /* Only what was asked for is edited. With neither flag the archive carries the
     directory's config byte for byte, which is what the node publishes. */
  const substitute = isEmptyEdit(edit) ? undefined : await editedConfig(dir, edit);

  console.log(`scafo: packing ${dir}`);
  const artifact = await packDirectory(dir, substitute === undefined ? undefined : { substitute });

  let accepted: Response;
  try {
    accepted = await uploadArtifact({
      nodeUrl,
      token: await authorize(),
      application,
      metadata: meta,
      artifact,
    });
  } finally {
    await artifact.dispose();
  }
  const status = (await accepted.json()) as DeployStatus;
  const location = accepted.headers.get("location") ?? `/v1/deploys/${status.id}`;

  console.log(`scafo: deploy ${status.id} ${status.state}`);
  await watchDeploy(new URL(location, `${nodeUrl}/`).href, authorize, status, {
    fixedToken: fixed !== undefined,
  });
}

/**
 * What the flags ask the directory's runtime config to say.
 *
 * `--var` is declared `multiple`, so the parser hands over every occurrence as
 * an array and an absent flag as an empty one. The comma means nothing here: a
 * value is whatever follows the first colon, commas and all.
 */
export function configEditFrom(flags: Record<string, unknown>): ConfigEdit {
  return {
    vars: parseVarFlags(flagList(flags.var), "--var"),
    /* citty turns `--no-bundle` into `bundle: false`; the negated name itself
       never reaches the parsed flags. */
    noBundle: flags.bundle === false,
  };
}

/** What the flags say about the deploy, in the shape the node's intake reads. */
export function deployMetadataFrom(flags: Record<string, unknown>): DeployMetadata {
  const wantedReplicas = text(flags.replicas);
  const replicas = wantedReplicas === undefined ? undefined : parseReplicas(wantedReplicas);
  const wantedSelector = flagList(flags["node-selector"]);
  const nodeSelector =
    wantedSelector.length === 0 ? undefined : parseLabelEntries(wantedSelector, "--node-selector");

  return {
    /* Only when they were asked for: a deploy that names no replica count and no
       selector must leave whatever the application already carries exactly as it
       is. Neither flag can lift a constraint — that is `scafo app selector`. */
    ...(replicas === undefined ? {} : { replicas }),
    ...(nodeSelector === undefined ? {} : { nodeSelector }),
  };
}

export interface DeployUploadOptions {
  nodeUrl: string;
  token: string;
  application: string;
  metadata: DeployMetadata;
  artifact: StagedArtifact;
  fetchFn?: typeof fetch;
}

/** Sends the file-backed artifact as the raw streaming deploy request body. */
export function uploadArtifact(opts: DeployUploadOptions): Promise<Response> {
  return nodeRequest(
    `${opts.nodeUrl}/v1/applications/${encodeURIComponent(opts.application)}/deploys`,
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

export interface DeployWatchOptions {
  /** True when `authorize` re-presents ONE token it was handed instead of minting one. */
  fixedToken?: boolean;
  /** Milliseconds between two looks; defaults to {@link DEFAULT_POLL_MS}. */
  pollMs?: number;
  /** How the polls are made; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Polls a deploy, printing each state it moves into, until it settles.
 *
 * @internal exported for its tests.
 */
export async function watchDeploy(
  url: string,
  authorize: Authorize,
  from: DeployStatus,
  opts?: DeployWatchOptions,
): Promise<DeployStatus> {
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const call = opts?.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn };
  let last = from;

  for (;;) {
    if (SETTLED.includes(last.state)) return last;
    await delay(pollMs);

    let status: DeployStatus;
    try {
      status = (await (await nodeRequest(url, await authorize(), call)).json()) as DeployStatus;
    } catch (error) {
      throw unwatchable(error, last, opts?.fixedToken === true);
    }
    if (status.state !== last.state) console.log(`scafo: deploy ${status.id} ${status.state}`);
    last = status;
    if (!SETTLED.includes(status.state)) continue;

    if (status.state === "failed") {
      /* The node's own code when it sent one: the refusal it made is what the
         caller has to act on, and a CLI that relabelled every failure as bad
         input would report "turn container classes on at that node" as a
         mistake in the artifact. A record an earlier build wrote without one
         says nothing about whose failure it was, so it is not the caller's. */
      throw new ScafoError(status.code ?? "internal", "Deploy failed", {
        detail: status.detail,
      });
    }
    if (status.deployment !== undefined) {
      console.log(`scafo: deployment ${status.deployment}`);
    }
    return status;
  }
}

/**
 * What an authentication failure DURING the polling means, which is not what one
 * during the upload meant.
 *
 * A node spends the `jti` of every token it accepts, so a `--token` that was
 * good enough to deploy with is already spent by the time the first poll
 * presents it again — the node refuses it as a replay. The deploy itself was
 * accepted and is running; only the watching stopped. Left as the bare
 * "Authentication failed" the node answered, that reads as the deploy having
 * been rejected, which is the opposite of what happened.
 *
 * Anything else is passed through untouched: it is the node's own answer, and
 * this is not the place to reinterpret it.
 */
function unwatchable(error: unknown, last: DeployStatus, fixedToken: boolean): unknown {
  if (!fixedToken || !isScafoError(error) || error.code !== "auth-invalid") return error;

  return new ScafoError("auth-invalid", "Deploy accepted, but it cannot be watched", {
    detail:
      `deploy ${last.id} was accepted by the node and is running; the token given to --token ` +
      `was then refused, and a scafo node token is spent by the first request that presents ` +
      `it. Sign with an operator key, or present a workload token the application's trust ` +
      `policy admits, to watch a deploy through to its outcome`,
    cause: error,
  });
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
