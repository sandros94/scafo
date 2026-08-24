/*
 * `scafo operator`: the people.
 *
 * EVERY HUMAN WHO OPERATES A SCAFO INSTALLATION IS AN OPERATOR. Admin is a ROLE
 * an operator holds, not a different kind of person — it says who may admit and
 * remove whom, and nothing else. So there is one command group for all of it:
 * minting your own key, showing the half of it that travels, admitting somebody
 * else's, and administering the set a fleet trusts.
 *
 * Everything here that reaches an installation reaches it through a NODE, on the
 * authority of a key that installation already trusts — with one deliberate
 * exception. `enroll` also has a BUCKET ceremony, authorized by the bucket
 * credential rather than by any key, because an installation being seeded has no
 * trusted key yet and one that has locked every operator out no longer has one.
 * The two paths are never chosen by default; see `enrollPath`.
 */

import { chmod, writeFile } from "node:fs/promises";
import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadAgentConfig } from "../../agent/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { assertNodeId } from "../../core/registry/paths.ts";
import { createRegistry } from "../_bootstrap.ts";
import { resolveOperatorHome } from "../_home.ts";
import {
  generateOperatorKey,
  loadPublicOperator,
  type OperatorKeyFile,
  registerOperatorKey,
} from "../_operator-key.ts";
import {
  DEFAULT_KEY_PATH,
  operatorFlags,
  OPERATOR_KEY_FORMS,
  resolveRemote,
} from "../_operator.ts";
import {
  describeEnrollment,
  describeRevocation,
  enrollInBucket,
  enrollOnWire,
  enrollPath,
  formatRemoteKeys,
  listRemoteKeys,
  operatorRole,
  revokeRemoteKey,
  showOperator,
} from "../_operators.ts";
import { describeRotation, rotateRemoteKey } from "../_rotate.ts";
import { deprecatedAlias, readTextFile, reportFailure } from "../_utils.ts";

export type { OperatorKeyFile };

/* The bucket the registry lives in, exactly as `scafo sail` takes it. */
const bucketArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

/** Every flag in {@link bucketArgs} that says WHERE the bucket is, `--config` included. */
const BUCKET_FLAGS: string[] = Object.keys(bucketArgs);

const keygenArgs: ArgsDef = {
  ...bucketArgs,
  out: { type: "string", description: `File to write the key pair to (${DEFAULT_KEY_PATH})` },
  id: { type: "string", description: "Id to register the key under (op-<hex>)" },
  register: { type: "boolean", description: "Record the public half in the registry" },
  role: {
    type: "string",
    description: "Tier to register at: admin|operator (the first key is always admin)",
  },
};

const showArgs: ArgsDef = {
  config: { type: "string", description: "Path to scafo.config.jsonc, read for its remote pin" },
  remote: { type: "string", description: "Remote whose key to show, out of this operator's home" },
  key: { type: "string", description: `Key to show instead: ${OPERATOR_KEY_FORMS}` },
};

const enrollArgs: ArgsDef = {
  ...bucketArgs,
  pubkey: {
    type: "positional",
    required: true,
    description: `Public document from "scafo operator show": a path, an inline "base64:" value, or the document itself`,
  },
  remote: { type: "string", description: "Remote whose node admits the key, admin-authed" },
  role: { type: "string", description: "Tier to admit it at: admin|operator" },
  agent: { type: "string", description: "Node to reach, instead of the remote's first endpoint" },
};

const remoteArgs: ArgsDef = {
  config: { type: "string", description: "Path to scafo.config.jsonc, read for its remote pin" },
  remote: { type: "string", description: "Remote to act on, out of this operator's home" },
  agent: { type: "string", description: "Node to reach, instead of the remote's first endpoint" },
};

const rotateArgs: ArgsDef = {
  ...remoteArgs,
  "keep-old": {
    type: "boolean",
    description: "Stop after the flip, leaving the old key trusted as well",
  },
  "purge-old": { type: "boolean", description: "Delete the old key file once it is untrusted" },
};

const revokeArgs: ArgsDef = {
  ...remoteArgs,
  id: { type: "string", description: "Key to stop trusting; not your own", required: true },
};

const keygen: CommandDef = defineCommand({
  meta: {
    name: "keygen",
    description:
      `Write an operator key file for the agent API ` +
      `(to set an operator up, use "scafo remote add" instead)`,
  },
  args: keygenArgs,
  async run({ args }): Promise<void> {
    try {
      await runKeygen(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const show: CommandDef = defineCommand({
  meta: { name: "show", description: "Print this operator's public half, to send to an admin" },
  args: showArgs,
  async run({ args }): Promise<void> {
    try {
      await runShow(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const enroll: CommandDef = defineCommand({
  meta: { name: "enroll", description: "Admit somebody else's public key to a fleet" },
  args: enrollArgs,
  async run({ args }): Promise<void> {
    try {
      await runEnroll(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const rotate: CommandDef = defineCommand({
  meta: {
    name: "rotate",
    description: "Replace the key a remote signs with, proving the new one before dropping the old",
  },
  args: rotateArgs,
  async run({ args }): Promise<void> {
    try {
      await runRotate(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const revoke: CommandDef = defineCommand({
  meta: { name: "revoke", description: "Stop a fleet trusting a key that is not your own" },
  args: revokeArgs,
  async run({ args }): Promise<void> {
    try {
      await runRevoke(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const list: CommandDef = defineCommand({
  meta: { name: "list", description: "Print the operator keys a fleet trusts, and their tiers" },
  args: remoteArgs,
  async run({ args }): Promise<void> {
    try {
      await runList(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const operator: CommandDef = defineCommand({
  meta: {
    name: "operator",
    description:
      "The people: every human here is an operator, and admin is a role an operator holds",
  },
  subCommands: { keygen, show, enroll, rotate, revoke, list },
});

/** What `scafo operator keygen` was called before the rename. Removed at launch. */
export const keygenAlias: CommandDef = deprecatedAlias({
  name: "keygen",
  replacedBy: "scafo operator keygen",
  command: keygen,
});

async function runKeygen(flags: Record<string, unknown>): Promise<void> {
  const out = text(flags.out) ?? DEFAULT_KEY_PATH;
  const id = text(flags.id);
  if (id !== undefined) assertNodeId(id);

  const file = await generateOperatorKey(id);

  /* The mode is given at CREATION, because it only applies there: a key that
     briefly existed world-readable is a key that has to be assumed read. The
     `chmod` after it is what narrows a file that was ALREADY on disk, which
     `writeFile` would otherwise leave at whatever mode it had. */
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(out, 0o600);
  console.log(`scafo: wrote operator key "${file.id}" to ${out}`);

  if (flags.register !== true) {
    console.log(
      `scafo: register it with "scafo operator keygen --id ${file.id} --register" once ` +
        `configured, or send its public half to an admin with "scafo operator show --key ${out}"`,
    );
    return;
  }

  const role = await registerOperatorKey(await bucketRegistry(flags), file, {
    ...operatorRole(flags.role),
  });
  console.log(
    `scafo: registered "${file.id}" as ${role}-tier; tokens it signs are now accepted by ` +
      `every node`,
  );
}

/*
 * THE DOCUMENT GOES TO STDOUT AND NOTHING ELSE DOES. `scafo operator show >
 * me.json` has to produce a file an admin can enrol as it stands, so the line
 * that explains what it is goes to stderr, where a redirect leaves it visible
 * and a pipe leaves it out.
 */
async function runShow(flags: Record<string, unknown>): Promise<void> {
  const shown = await showOperator({
    home: resolveOperatorHome(),
    env: process.env,
    flags: operatorFlags(flags),
    readFile: readTextFile,
  });

  console.error(shown.notice);
  console.log(shown.document);
}

async function runEnroll(flags: Record<string, unknown>): Promise<void> {
  /* Read FIRST, before either path is contacted: a document that is not one
     costs no request and no bucket credential to refuse. */
  const pub = await loadPublicOperator(required(flags, "pubkey"));
  const role = operatorRole(flags.role);
  const named = text(flags.remote);

  const chosen = enrollPath({
    ...(named === undefined ? {} : { remote: named }),
    bucket: BUCKET_FLAGS.some((name) => text(flags[name]) !== undefined),
  });

  const enrolled =
    chosen === "wire"
      ? await enrollOnWire(resolveOperatorHome(), named as string, pub, {
          ...role,
          ...(text(flags.agent) === undefined ? {} : { agentUrl: text(flags.agent) as string }),
        })
      : await enrollInBucket(await bucketRegistry(flags), pub, role);

  console.log(describeEnrollment(enrolled));
}

async function runRotate(flags: Record<string, unknown>): Promise<void> {
  const home = resolveOperatorHome();
  const rotated = await rotateRemoteKey(home, await remoteName(home, flags), {
    ...(text(flags.agent) === undefined ? {} : { agentUrl: text(flags.agent) as string }),
    keepOld: flags["keep-old"] === true,
    purgeOld: flags["purge-old"] === true,
  });

  console.log(describeRotation(rotated));
}

async function runRevoke(flags: Record<string, unknown>): Promise<void> {
  const home = resolveOperatorHome();
  const revoked = await revokeRemoteKey(
    home,
    await remoteName(home, flags),
    required(flags, "id"),
    text(flags.agent) === undefined ? {} : { agentUrl: text(flags.agent) as string },
  );

  console.log(describeRevocation(revoked));
}

async function runList(flags: Record<string, unknown>): Promise<void> {
  const home = resolveOperatorHome();
  const keys = await listRemoteKeys(
    home,
    await remoteName(home, flags),
    text(flags.agent) === undefined ? {} : { agentUrl: text(flags.agent) as string },
  );

  console.log(formatRemoteKeys(keys));
}

/**
 * Which remote this invocation administers, down the one chain every other
 * operator-facing command uses: `--remote`, then the environment, then the
 * project's pin, then the only remote there is.
 *
 * A home holding none is refused HERE rather than inside the chain, which
 * answers null for it: every command in this file acts on a remote, and there is
 * nothing sensible to do without one.
 */
async function remoteName(home: string, flags: Record<string, unknown>): Promise<string> {
  const named = await resolveRemote({
    home,
    env: process.env,
    flags: operatorFlags(flags),
    readFile: readTextFile,
  });
  if (named !== null) return named;

  throw new ScafoError("not-found", "No remote is registered", {
    detail:
      `this operator's home holds no remote, so there is nothing to administer: register one ` +
      `with "scafo remote add <name> --endpoint <url>"`,
  });
}

/** The bucket named by the flags, the config file and the environment, in that order. */
async function bucketRegistry(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadAgentConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  return createRegistry(config);
}

function required(flags: Record<string, unknown>, name: string): string {
  const value = text(flags[name]);
  if (value !== undefined) return value;

  throw new ScafoError("invalid-input", "Missing required argument", {
    detail: `--${name} must be given`,
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The declared flags that were actually given; anything else the parser adds is not configuration. */
function stringFlags(flags: Record<string, unknown>): Record<string, string | undefined> {
  const given: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(flags)) {
    if (typeof value === "string") given[name] = value;
  }
  return given;
}
