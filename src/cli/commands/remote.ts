/*
 * `scafo remote`: the installations this operator can reach, by name.
 *
 * A REMOTE IS AN ADDRESS BOOK ENTRY, in git's sense of the word — a NAME for
 * somewhere, and the credential that speaks there. What is at the far end is a
 * fleet; the entry is not the fleet, any more than `origin` is the repository it
 * points at. That is why one operator can hold two names for one installation,
 * and why forgetting a remote says nothing to the installation itself.
 *
 * What an entry holds is the two things every operator command otherwise has to
 * be told: WHERE it is, and WHO is speaking. Registering one puts a key in the
 * operator's home rather than in the working directory, which is the whole
 * point: a key beside a repository is a key that gets committed.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import { createRegistry } from "../_bootstrap.ts";
import { resolveOperatorHome } from "../_home.ts";
import { INLINE_PREFIX, registerOperatorKey } from "../_operator-key.ts";
import { operatorRole } from "../_operators.ts";
import {
  addRemote,
  exportRemote,
  formatRemoteList,
  readRemotes,
  removeRemote,
} from "../_remotes.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/*
 * `--endpoint` here is the NODE DAEMON's URL, which is the only address this
 * command is about. The bucket `--register` takes flags for is therefore
 * configured the other two ways `scafo sail` accepts — the config file and the
 * environment — rather than by a second `--endpoint` meaning something else on
 * the same command line.
 */
const addArgs: ArgsDef = {
  name: { type: "positional", description: "Name to reach this remote by", required: false },
  endpoint: {
    type: "string",
    description: "Base URL of one of its nodes; comma-separated for several",
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
  role: {
    type: "string",
    description: "Tier to register at: admin|operator (the first key is always admin)",
  },
  config: { type: "string", description: "Path to scafo.config.jsonc, for --register" },
};

const removeArgs: ArgsDef = {
  name: { type: "positional", description: "Remote to stop knowing about", required: true },
};

const exportArgs: ArgsDef = {
  name: { type: "positional", description: "Remote to write out", required: true },
  out: { type: "string", description: "File to write it to, readable by its owner alone" },
};

const add: CommandDef = defineCommand({
  meta: { name: "add", description: "Register a remote, with a key of its own" },
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
  meta: { name: "list", description: "Print the remotes this operator can reach" },
  async run(): Promise<void> {
    try {
      console.log(formatRemoteList(await readRemotes(resolveOperatorHome())));
    } catch (error) {
      reportFailure(error);
    }
  },
});

const remove: CommandDef = defineCommand({
  meta: { name: "remove", description: "Unregister a remote, and its key if nothing shares it" },
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
  meta: { name: "export", description: "Write a remote out as one portable, self-contained file" },
  args: exportArgs,
  async run({ args }): Promise<void> {
    try {
      await runExport(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const remote: CommandDef = defineCommand({
  meta: {
    name: "remote",
    description: "Name the installations you can reach, and hold the key that speaks to each",
  },
  subCommands: { add, list, remove, export: write },
});

async function runAdd(flags: Record<string, unknown>): Promise<void> {
  const home = resolveOperatorHome();
  const added = await addRemote(home, {
    ...(text(flags.name) === undefined ? {} : { name: text(flags.name) as string }),
    endpoints: urls(flags.endpoint),
    ...(text(flags.key) === undefined ? {} : { keyName: text(flags.key) as string }),
    ...(text(flags.from) === undefined ? {} : { from: text(flags.from) as string }),
  });

  console.log(
    `scafo: remote "${added.name}" is registered at ${added.entry.endpoints.join(", ")}, ` +
      `signing with ${added.minted ? "a fresh key" : `key "${added.key.id}"`} in ${added.keyPath}`,
  );

  if (flags.register !== true) {
    /* Only for a key the installation has never seen: one carried in or reused
       from another remote is already filed, and saying otherwise would send an
       operator to register a key that is registered. */
    if (added.minted) {
      console.log(
        `scafo: record its public half with "scafo remote add ... --register", or have an ` +
          `admin admit it with "scafo operator enroll", before it can deploy`,
      );
    }
    return;
  }

  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    env: process.env,
    readFile: readTextFile,
  });
  const role = await registerOperatorKey(createRegistry(config), added.key, {
    ...operatorRole(flags.role),
  });
  console.log(
    `scafo: registered "${added.key.id}" as ${role}-tier; tokens it signs are now accepted by ` +
      `every node`,
  );
}

async function runRemove(flags: Record<string, unknown>): Promise<void> {
  const removed = await removeRemote(resolveOperatorHome(), required(flags, "name"));

  console.log(
    removed.keyRemoved
      ? `scafo: remote "${removed.name}" is gone, and so is ${removed.keyPath}`
      : `scafo: remote "${removed.name}" is gone; ${removed.keyPath} stayed, because ` +
          `${removed.sharedWith.join(", ")} still signs with it`,
  );
  console.log(
    `scafo: nothing was said to the installation itself — the key it holds is still ` +
      `accepted there until it is removed from the registry`,
  );
}

async function runExport(flags: Record<string, unknown>): Promise<void> {
  await exportRemote(resolveOperatorHome(), required(flags, "name"), {
    ...(text(flags.out) === undefined ? {} : { out: text(flags.out) as string }),
    isTTY: process.stdout.isTTY === true,
  });
}

/*
 * The list a `--endpoint` value carries, COMMA-SEPARATED in one flag. A
 * repeated flag would read more naturally, but the argument parser keeps only
 * the last occurrence — repeats were silently dropping every endpoint but one.
 * A URL cannot contain a comma, so the split is unambiguous; the same shape the
 * storage token list uses.
 *
 * @internal exported for its tests.
 */
export function urls(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : [entry]))
    .map(text)
    .filter((entry): entry is string => entry !== undefined);
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
