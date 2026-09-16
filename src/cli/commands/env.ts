/*
 * `scafo env`: taking an environment out of service, putting it back, saying
 * which nodes may serve it, and deleting it once it is really meant to go.
 *
 * Retiring and deleting are two commands rather than one because they are two
 * decisions. Retirement stops an environment being served and is reversible for
 * as long as its grace runs; deletion is the one act nothing in the registry can
 * undo, and it is refused until either the grace has passed or the operator has
 * said `--force`. A preview environment is disposable by construction and skips
 * straight to the deletion.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import { nodeBaseUrl, operatorSigner } from "../_node.ts";
import { createRegistry } from "../_bootstrap.ts";
import {
  nodeOps,
  describeRetirement,
  describeSelectorChange,
  directOps,
  type EnvironmentOps,
  type EnvironmentTarget,
  readSelectorFlags,
} from "../_environments.ts";
import { resolveOperatorHome } from "../_home.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";
import { describeEnvironmentVarset, readVarsetFlags } from "../_varset.ts";
import { setEnvironmentVarset } from "../../core/registry/environments.ts";

/* The bucket the registry lives in, exactly as `scafo sail` takes it. Only read
   when no --node is given: with one, the node holds the bucket credentials and
   the operator needs none of their own. */
const bucketArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

const targetArgs: ArgsDef = {
  ...bucketArgs,
  project: { type: "string", description: "Project the environment belongs to", required: true },
  env: { type: "string", description: "Environment to act on", required: true },
  node: {
    type: "string",
    description:
      "Base URL of a node daemon to ask; without it the chosen remote says where, and " +
      "without a remote the bucket is written directly",
  },
  remote: { type: "string", description: "Remote to act on, out of this operator's home" },
  key: { type: "string", description: `Operator key to sign with: ${OPERATOR_KEY_FORMS}` },
};

const deleteArgs: ArgsDef = {
  ...targetArgs,
  force: {
    type: "boolean",
    description: "Delete whatever state it is in, skipping the ephemeral and grace requirements",
  },
};

const varsetArgs: ArgsDef = {
  ...bucketArgs,
  project: { type: "string", description: "Project the environment belongs to", required: true },
  env: { type: "string", description: "Environment to act on", required: true },
  name: { type: "string", description: "Varset of the project its deploys should carry" },
  none: { type: "boolean", description: "Stop it carrying a varset at all" },
};

const selectorArgs: ArgsDef = {
  ...targetArgs,
  set: {
    type: "string",
    description: "Labels a node must carry to serve it (region=eu-west-1,tier=fast)",
  },
  clear: { type: "boolean", description: "Let it run on every node again" },
};

const retire: CommandDef = defineCommand({
  meta: { name: "retire", description: "Stop serving an environment, reversibly" },
  args: targetArgs,
  async run({ args }): Promise<void> {
    try {
      await runRetire(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const unretire: CommandDef = defineCommand({
  meta: { name: "unretire", description: "Put a retired environment back into service" },
  args: targetArgs,
  async run({ args }): Promise<void> {
    try {
      await runUnretire(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const remove: CommandDef = defineCommand({
  meta: { name: "delete", description: "Delete a retired, ephemeral or forced environment" },
  args: deleteArgs,
  async run({ args }): Promise<void> {
    try {
      await runDelete(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const selector: CommandDef = defineCommand({
  meta: { name: "selector", description: "Choose which nodes may serve an environment" },
  args: selectorArgs,
  async run({ args }): Promise<void> {
    try {
      await runSelector(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const varset: CommandDef = defineCommand({
  meta: { name: "varset", description: "Choose which variables an environment's deploys carry" },
  args: varsetArgs,
  async run({ args }): Promise<void> {
    try {
      await runVarset(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const env: CommandDef = defineCommand({
  meta: {
    name: "env",
    description: "Retire, restore, target and delete environments",
  },
  subCommands: { retire, unretire, selector, varset, delete: remove },
});

async function runRetire(flags: Record<string, unknown>): Promise<void> {
  const target = environmentTarget(flags);
  const ops = await opsFor(flags);

  console.log(describeRetirement(target, await ops.retire(target)));
}

async function runUnretire(flags: Record<string, unknown>): Promise<void> {
  const target = environmentTarget(flags);
  const ops = await opsFor(flags);
  const environment = await ops.unretire(target);

  if (environment.retiredAt !== undefined) {
    throw new ScafoError("cas-conflict", "Environment is still retired", {
      detail: `"${target.project}/${target.env}" still carries ${environment.retiredAt}`,
    });
  }
  console.log(
    `scafo: "${target.project}/${target.env}" is no longer retired; the nodes that should ` +
      `serve it start it again on their next pass`,
  );
}

async function runSelector(flags: Record<string, unknown>): Promise<void> {
  const target = environmentTarget(flags);
  /* Read before anything is contacted, so a malformed label costs no request. */
  const wanted = readSelectorFlags({ set: text(flags.set), clear: flags.clear === true });
  const ops = await opsFor(flags);

  console.log(describeSelectorChange(target, await ops.setSelector(target, wanted)));
}

/* Written straight into the bucket, as `scafo varset` is: a varset is registry
   configuration a deploy reads, so no node has to be running to point at one. */
async function runVarset(flags: Record<string, unknown>): Promise<void> {
  const target = environmentTarget(flags);
  /* Read before the bucket is opened, so a command that states both intentions
     or neither costs no request. */
  const wanted = readVarsetFlags({ name: text(flags.name), none: flags.none === true });

  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  await setEnvironmentVarset(createRegistry(config), target.project, target.env, wanted);

  console.log(describeEnvironmentVarset(target, wanted));
}

async function runDelete(flags: Record<string, unknown>): Promise<void> {
  const target = environmentTarget(flags);
  const force = flags.force === true;
  const ops = await opsFor(flags);

  const deleted = await ops.delete(target, { force });
  const count = deleted.length;
  console.log(
    `scafo: deleted "${target.project}/${target.env}" through ${ops.via}, ` +
      `${String(count)} object${count === 1 ? "" : "s"}`,
  );
  for (const key of deleted) console.log(`  ${key}`);
}

/**
 * Which way this invocation reaches the installation. A node is asked whenever
 * one is named — by `--node`, or by the remote this operator's home resolved —
 * and everything else falls back to the bucket, which is what an installation
 * with no node running has, and what `scafo trust` and `scafo varset` do too.
 */
async function opsFor(flags: Record<string, unknown>): Promise<EnvironmentOps> {
  const resolved = await resolveOperator({
    home: resolveOperatorHome(),
    env: process.env,
    flags: operatorFlags(flags),
    readFile: readTextFile,
  });

  if (resolved.nodeUrl !== undefined) {
    return nodeOps({
      url: nodeBaseUrl(resolved.nodeUrl),
      authorize: operatorSigner(await resolved.readKey()),
    });
  }

  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: stringFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  return directOps(createRegistry(config));
}

function environmentTarget(flags: Record<string, unknown>): EnvironmentTarget {
  return { project: required(flags, "project"), env: required(flags, "env") };
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
