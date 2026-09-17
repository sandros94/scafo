/*
 * `scafo fleet`: the machines, and what the installation as a whole is doing.
 *
 * A FLEET IS AN INSTALLATION — one bucket and prefix, and every machine that has
 * joined it by running `scafo sail`. A single node is a fleet of one. The word
 * means the machines and nothing else here: the NAMES an operator reaches
 * installations by live under `scafo remote`, and the PEOPLE who operate them
 * under `scafo operator`.
 *
 * So this group is introspection and control of the fleet itself: what is out
 * there, which of it is answering, and whether it is taking deploys at all.
 *
 * FREEZE IS THE VERB WORTH READING TWICE. It stops deploy INTAKE everywhere and
 * touches nothing else: every process keeps running, every route stays
 * published, and everything already deployed stays deployed. It is what the
 * first step of an upgrade asks for — stop the writers — and it is admin-only,
 * because it is a statement about the installation rather than about a project.
 *
 * The two halves reach an installation differently, and deliberately. `nodes`
 * reads the BUCKET, because "which machines are still answering?" is asked when
 * one is not. Freezing goes through a NODE on an operator key, because it is an
 * authorization the bucket cannot enforce.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { ScafoError } from "../../core/error.ts";
import { readFreeze } from "../../core/registry/freeze.ts";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { createRegistry } from "../_bootstrap.ts";
import { describeFreeze, describeUnfreeze, type FleetApi, fleetApi } from "../_fleet.ts";
import { resolveOperatorHome } from "../_home.ts";
import { nodeBaseUrl, operatorSigner } from "../_node.ts";
import { formatNodeTable, listFleetNodes } from "../_nodes.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/* The bucket the registry lives in, exactly as `scafo sail` takes it. */
const nodesArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
  "json": { type: "boolean", description: "Print the records as JSON instead of a table" },
};

/* Which installation this invocation reaches, and with what. The same four the
   other wire-only commands take. */
const remoteArgs: ArgsDef = {
  config: { type: "string", description: "Path to scafo.config.jsonc, read for its remote pin" },
  remote: { type: "string", description: "Remote to act on, out of this operator's home" },
  node: { type: "string", description: "Node to reach, instead of the remote's first endpoint" },
  key: { type: "string", description: `Operator key to sign with: ${OPERATOR_KEY_FORMS}` },
};

const freezeArgs: ArgsDef = {
  ...remoteArgs,
  reason: {
    type: "string",
    description: "Why, in one line, printed to everyone whose deploy is refused",
  },
};

const nodes: CommandDef = defineCommand({
  meta: { name: "nodes", description: "List the machines in this fleet, and which are answering" },
  args: nodesArgs,
  run: guarded(runNodes),
});

const freeze: CommandDef = defineCommand({
  meta: {
    name: "freeze",
    description: "Stop every deploy of this installation, leaving serving alone (admin only)",
  },
  args: freezeArgs,
  run: guarded(runFreeze),
});

const unfreeze: CommandDef = defineCommand({
  meta: {
    name: "unfreeze",
    description: "Take deploys again after a freeze (admin only)",
  },
  args: remoteArgs,
  run: guarded(runUnfreeze),
});

export const fleet: CommandDef = defineCommand({
  meta: {
    name: "fleet",
    description: "The machines of one installation: what is out there, and what it is doing",
  },
  subCommands: { nodes, freeze, unfreeze },
});

/* ---------------------------------------------------------------- internals */

async function runNodes(flags: Record<string, unknown>): Promise<void> {
  const config = await loadDaemonConfig({
    configPath: typeof flags.config === "string" ? flags.config : undefined,
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  const registry = createRegistry(config);

  /* ONE CLOCK for the whole listing: rows judged against a `now` that moved
     between them would read as a fleet whose nodes are drifting apart. */
  const now = new Date();
  const listing = await listFleetNodes(registry, { now });
  if (flags.json === true) {
    console.log(JSON.stringify(listing, null, 2));
    return;
  }
  console.log(formatNodeTable(listing, now, await readFreeze(registry)));
}

async function runFreeze(flags: Record<string, unknown>): Promise<void> {
  const api = await apiFor(flags);
  const reason = typeof flags.reason === "string" ? flags.reason.trim() : "";

  console.log(describeFreeze(await api.freeze(reason === "" ? undefined : reason)));
}

async function runUnfreeze(flags: Record<string, unknown>): Promise<void> {
  const api = await apiFor(flags);

  console.log(describeUnfreeze(await api.unfreeze()));
}

/**
 * The fleet surface behind whichever remote this invocation resolved.
 *
 * A NODE IS REQUIRED, and the refusal says so rather than falling back to the
 * bucket: see the header of `_fleet.ts` for why there is no bucket path here.
 */
async function apiFor(flags: Record<string, unknown>): Promise<FleetApi> {
  const resolved = await resolveOperator({
    home: resolveOperatorHome(),
    env: process.env,
    flags: operatorFlags(flags),
    readFile: readTextFile,
  });

  if (resolved.nodeUrl === undefined) {
    throw new ScafoError("invalid-input", "No node to ask", {
      detail:
        `freezing this fleet's deploys is an operator-key act rather than a bucket one, so it ` +
        `goes through a node: pass --node <url>, or --remote <name> of a remote that names one`,
    });
  }
  return fleetApi({
    url: nodeBaseUrl(resolved.nodeUrl),
    authorize: operatorSigner(await resolved.readKey()),
  });
}

/** Wraps a runner so every command reports a failure the same way. */
function guarded(
  run: (flags: Record<string, unknown>) => Promise<void>,
): (context: { args: Record<string, unknown> }) => Promise<void> {
  return async ({ args }) => {
    try {
      await run(args);
    } catch (error) {
      reportFailure(error);
    }
  };
}

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
