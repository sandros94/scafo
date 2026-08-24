/*
 * `scafo fleet`: the machines.
 *
 * A FLEET IS AN INSTALLATION — one bucket and prefix, and every machine that has
 * joined it by running `scafo sail`. A single node is a fleet of one. The word
 * means the machines and nothing else here: the NAMES an operator reaches
 * installations by live under `scafo remote`, and the PEOPLE who operate them
 * under `scafo operator`.
 *
 * So this group is introspection and control of the fleet's machines, and it
 * ships with the first of it: what is out there, and which of it is answering.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { createRegistry } from "../_bootstrap.ts";
import { formatNodeTable, listFleetNodes } from "../_nodes.ts";
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

const nodes: CommandDef = defineCommand({
  meta: { name: "nodes", description: "List the machines in this fleet, and which are answering" },
  args: nodesArgs,
  async run({ args }): Promise<void> {
    try {
      await runNodes(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const fleet: CommandDef = defineCommand({
  meta: {
    name: "fleet",
    description: "The machines of one installation: what is out there, and what it is doing",
  },
  subCommands: { nodes },
});

async function runNodes(flags: Record<string, unknown>): Promise<void> {
  const config = await loadDaemonConfig({
    configPath: typeof flags.config === "string" ? flags.config : undefined,
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });

  /* ONE CLOCK for the whole listing: rows judged against a `now` that moved
     between them would read as a fleet whose nodes are drifting apart. */
  const now = new Date();
  const listing = await listFleetNodes(createRegistry(config), { now });

  console.log(
    flags.json === true ? JSON.stringify(listing, null, 2) : formatNodeTable(listing, now),
  );
}

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
