/*
 * `scafo fleet`: the installations this operator can reach, by name.
 *
 * A fleet is one installation — a single node is a fleet of one — and what a
 * fleet entry holds is the two things every operator command otherwise has to be
 * told: WHERE it is, and WHO is speaking. Registering one puts a key in the
 * operator's home rather than in the working directory, which is the whole point:
 * a key beside a repository is a key that gets committed.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadAgentConfig } from "../../agent/config.ts";
import { ScafoError } from "../../core/error.ts";
import { addFleet, exportFleet, formatFleetList, readFleets, removeFleet } from "../_fleets.ts";
import { createRegistry } from "../_bootstrap.ts";
import { resolveOperatorHome } from "../_home.ts";
import { INLINE_PREFIX, registerOperatorKey } from "../_operator-key.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/*
 * `--endpoint` here is the NODE AGENT's URL, which is the only address this
 * command is about. The bucket `scafo keygen --register` takes flags for is
 * therefore configured the other two ways `scafo up` accepts — the config file
 * and the environment — rather than by a second `--endpoint` meaning something
 * else on the same command line.
 */
const addArgs: ArgsDef = {
  name: { type: "positional", description: "Name to reach this fleet by", required: false },
  endpoint: {
    type: "string",
    description: "Base URL of one of its node agents; repeat for several",
  },
  key: {
    type: "string",
    description: "Reuse a key already in this home, instead of minting a fresh one",
  },
  from: {
    type: "string",
    description: `Import a portable file: a path, or an inline "${INLINE_PREFIX}" value`,
  },
  register: { type: "boolean", description: "Record the key's public half in the registry" },
  config: { type: "string", description: "Path to scafo.config.jsonc, for --register" },
};

const removeArgs: ArgsDef = {
  name: { type: "positional", description: "Fleet to stop knowing about", required: true },
};

const exportArgs: ArgsDef = {
  name: { type: "positional", description: "Fleet to write out", required: true },
  out: { type: "string", description: "File to write it to, readable by its owner alone" },
};

const add: CommandDef = defineCommand({
  meta: { name: "add", description: "Register a fleet, with a key of its own" },
  args: addArgs,
  async run({ args }): Promise<void> {
    try {
      await runAdd(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const list: CommandDef = defineCommand({
  meta: { name: "list", description: "Print the fleets this operator can reach" },
  async run(): Promise<void> {
    try {
      console.log(formatFleetList(await readFleets(resolveOperatorHome())));
    } catch (error) {
      reportFailure(error);
    }
  },
});

const remove: CommandDef = defineCommand({
  meta: { name: "remove", description: "Unregister a fleet, and its key if nothing shares it" },
  args: removeArgs,
  async run({ args }): Promise<void> {
    try {
      await runRemove(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const write: CommandDef = defineCommand({
  meta: { name: "export", description: "Write a fleet out as one portable, self-contained file" },
  args: exportArgs,
  async run({ args }): Promise<void> {
    try {
      await runExport(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const fleet: CommandDef = defineCommand({
  meta: { name: "fleet", description: "Register, list, export and forget the fleets you operate" },
  subCommands: { add, list, remove, export: write },
});

async function runAdd(flags: Record<string, unknown>): Promise<void> {
  const home = resolveOperatorHome();
  const added = await addFleet(home, {
    ...(text(flags.name) === undefined ? {} : { name: text(flags.name) as string }),
    endpoints: urls(flags.endpoint),
    ...(text(flags.key) === undefined ? {} : { keyName: text(flags.key) as string }),
    ...(text(flags.from) === undefined ? {} : { from: text(flags.from) as string }),
  });

  console.log(
    `scafo: fleet "${added.name}" is registered at ${added.entry.endpoints.join(", ")}, ` +
      `signing with ${added.minted ? "a fresh key" : `key "${added.key.id}"`} in ${added.keyPath}`,
  );

  if (flags.register !== true) {
    /* Only for a key the installation has never seen: one carried in or reused
       from another fleet is already filed, and saying otherwise would send an
       operator to register a key that is registered. */
    if (added.minted) {
      console.log(
        `scafo: record its public half with "scafo fleet add ... --register", or with ` +
          `"scafo keygen --id ${added.key.id} --register", before it can deploy`,
      );
    }
    return;
  }

  const config = await loadAgentConfig({
    configPath: text(flags.config),
    env: process.env,
    readFile: readTextFile,
  });
  await registerOperatorKey(createRegistry(config), added.key);
  console.log(
    `scafo: registered "${added.key.id}"; tokens it signs are now accepted by every node`,
  );
}

async function runRemove(flags: Record<string, unknown>): Promise<void> {
  const removed = await removeFleet(resolveOperatorHome(), required(flags, "name"));

  console.log(
    removed.keyRemoved
      ? `scafo: fleet "${removed.name}" is gone, and so is ${removed.keyPath}`
      : `scafo: fleet "${removed.name}" is gone; ${removed.keyPath} stayed, because ` +
          `${removed.sharedWith.join(", ")} still signs with it`,
  );
  console.log(
    `scafo: nothing was said to the installation itself — the key it holds is still ` +
      `accepted there until it is removed from the registry`,
  );
}

async function runExport(flags: Record<string, unknown>): Promise<void> {
  await exportFleet(resolveOperatorHome(), required(flags, "name"), {
    ...(text(flags.out) === undefined ? {} : { out: text(flags.out) as string }),
    isTTY: process.stdout.isTTY === true,
  });
}

/** A flag given once or several times, as the list it always is here. */
function urls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map(text).filter((entry): entry is string => entry !== undefined);
}

function required(flags: Record<string, unknown>, name: string): string {
  const value = text(flags[name]);
  if (value !== undefined) return value;

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail: `<${name}> must be given`,
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
