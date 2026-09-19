/*
 * `scafo health`: ask the node on this machine whether it is serving, from the
 * configuration that node itself boots from.
 *
 * A probe carrying an address of its own reports a healthy node as down the
 * moment the operator moves its listener — onto the tunnel, which is where
 * `--transport wireguard` puts it by default, or onto any other address the
 * node was told to bind. This command resolves `node.listen` exactly as
 * `scafo sail` resolves it and asks whatever that says, so the probe follows
 * the listener rather than having to be told about it a second time. That is
 * what makes it the image's HEALTHCHECK.
 *
 * What it cannot follow on its own is a setting that never left the daemon's
 * command line: it reads the environment and the config file, so a node whose
 * listener was chosen with `--listen` wants that flag here too — or, better,
 * the setting written where both processes can read it.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { ScafoError } from "../../core/error.ts";
import { formatHostPort } from "../../core/utils/host.ts";
import type { DaemonHealth } from "../../daemon/app.ts";
import {
  type DaemonConfig,
  loadDaemonConfig,
  localDialHost,
  parseHostPort,
} from "../../daemon/config.ts";
import { API_HEALTH_PATH } from "../../drivers/ingress/traefik.ts";
import { configFlags } from "../_flags.ts";
import { describeUnexpected, readTextFile, reportFailure } from "../_utils.ts";

/**
 * How long the node has to answer.
 *
 * Shorter than every timeout this command runs under — Docker's HEALTHCHECK
 * `--timeout` and the manifests' probe deadlines — so a node that has stopped
 * answering is reported by this command, with the address it was asked at,
 * rather than killed mid-request by whatever ran it.
 */
const ANSWER_TIMEOUT_MS = 2000;

/*
 * The settings that decide where the daemon bound, taken exactly as `scafo sail`
 * takes them; nothing else it accepts moves the listener. The bucket is here
 * because the loader answers with a whole node configuration and asks for those
 * four, which every environment a node runs in already carries.
 */
const healthArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
  "listen": { type: "string", description: "host:port the node API binds to" },
  "transport": { type: "string", description: "What carries peer traffic (wireguard, none)" },
  "wg-address": {
    type: "string",
    description: "This node's tunnel address with its prefix length (10.83.0.1/24)",
  },
};

export const health: CommandDef = defineCommand({
  meta: { name: "health", description: "Ask this machine's node whether it is serving" },
  args: healthArgs,
  async run({ args }): Promise<void> {
    try {
      await runHealth(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

async function runHealth(flags: Record<string, unknown>): Promise<void> {
  const config = await loadDaemonConfig({
    configPath: typeof flags.config === "string" ? flags.config : undefined,
    flags: configFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  const answer = await probeHealth(healthUrl(config.node));

  /* One line, and the listener is in it: what a probe reports is read where
     there is nothing else to look at — `docker inspect`, a unit's status, a
     terminal — so it says which address answered and what is running there. */
  console.log(`scafo: healthy ${config.node.listen} (${answer.version}) as node "${answer.node}"`);
}

/** Where this node answers its own health, dialled from the machine it runs on. */
export function healthUrl(node: DaemonConfig["node"]): string {
  const listen = parseHostPort(node.listen, "node.listen");
  return `http://${formatHostPort(localDialHost(listen.host), listen.port)}${API_HEALTH_PATH}`;
}

/** How the call is made; the seam a test answers in place of the network. */
export interface ProbeOptions {
  fetchFn?: typeof fetch;
}

/**
 * Asks one node's health endpoint and reads the answer back.
 *
 * Both refusals name the URL, because that is the whole of what an operator
 * acts on: a probe that says a node is down without saying where it looked is
 * one that cannot tell a stopped daemon from a listener nobody found.
 */
export async function probeHealth(url: string, opts?: ProbeOptions): Promise<DaemonHealth> {
  const fetchFn = opts?.fetchFn ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
  } catch (error) {
    /* A refused connection, an address nothing is bound to, and a daemon too
       busy to answer within the deadline all arrive here. */
    throw new ScafoError("not-found", "Node is not answering", {
      detail:
        `nothing answered GET ${url} within ${String(ANSWER_TIMEOUT_MS)}ms: ` +
        describeUnexpected(error),
      cause: error,
    });
  }

  /* Whatever answered may not have been the node at all — a proxy, an error
     page, another service on the port — so the body counts only when it is the
     health document this node serves. */
  const body: unknown = await response.json().catch(() => null);
  const health = body as Partial<DaemonHealth> | null;
  if (!response.ok || health?.ok !== true) {
    throw new ScafoError("not-found", "Node is not healthy", {
      detail: `GET ${url} answered ${String(response.status)} and no health this node serves`,
    });
  }

  return {
    ok: true,
    version: typeof health.version === "string" ? health.version : "unknown",
    node: typeof health.node === "string" ? health.node : "unknown",
  };
}
