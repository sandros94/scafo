/*
 * `scafo app`: the things this installation hosts.
 *
 * An application is what an installation exists to serve — one Celld fleet, one
 * current deployment, one trust policy — and it comes into being on the first
 * deploy that names it rather than through a create verb here. So this group is
 * about applications that already exist: what there is, what state each is in,
 * how it is placed, and the statements an admin can make about one.
 *
 * BLOCK IS THE VERB WORTH READING TWICE. It is a full stop: a blocked
 * application is served nowhere in the fleet, its hosts leave ingress, it gets
 * no certificates and it accepts no deploys — while every deployment record,
 * deployment notice and domain it has is left exactly where it was. Unblocking
 * is one call, and the next pass of every node puts it all back. It is
 * admin-only, and deliberately: the case it exists for is a platform stopping an
 * application it hosts, which is precisely the case where that application's own
 * operator would rather it did not.
 *
 * LABEL IS THE OTHER HALF OF THAT STORY and stops nothing. Labels are free-form
 * `k=v` pairs scafo stores and never reads — a billing account, a client's name,
 * a plan — so that a platform built over scafo can tag an application machine to
 * machine and read it back through the API it already talks to.
 *
 * RETIRE AND DELETE are two commands rather than one because they are two
 * decisions. Retirement stops an application being served and is reversible for
 * as long as its grace runs; deletion is the one act nothing in the registry can
 * undo, and it is refused until either the grace has passed or the operator has
 * said `--force`.
 *
 * The admin verbs reach an installation through a NODE, on the authority of an
 * operator key. The rest also write straight into the bucket when no node is
 * named, which is what an installation with no node running has.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { ScafoError } from "../../core/error.ts";
import { parseReplicas } from "../../core/placement/replicas.ts";
import type { ApplicationRecord } from "../../core/types/registry.ts";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { resolveApplication } from "../_application.ts";
import {
  type ApplicationApi,
  applicationApi,
  type ApplicationOps,
  describeReplicasChange,
  describeRetirement,
  describeSelectorChange,
  directOps,
  formatApplication,
  formatApplicationTable,
  nodeOps,
  readLabelArgs,
  readSelectorFlags,
} from "../_applications.ts";
import { createRegistry } from "../_bootstrap.ts";
import { configFlags, flagList } from "../_flags.ts";
import { resolveOperatorHome } from "../_home.ts";
import { nodeBaseUrl, operatorSigner } from "../_node.ts";
import { OPERATOR_KEY_FORMS, operatorFlags, resolveOperator } from "../_operator.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/* Which installation this invocation reaches, and with what. */
const remoteArgs: ArgsDef = {
  config: { type: "string", description: "Path to scafo.config.jsonc, read for its remote pin" },
  remote: { type: "string", description: "Remote to act on, out of this operator's home" },
  node: { type: "string", description: "Node to reach, instead of the remote's first endpoint" },
  key: { type: "string", description: `Operator key to sign with: ${OPERATOR_KEY_FORMS}` },
};

/* The bucket the registry lives in, exactly as `scafo sail` takes it. Only read
   when no node is named: with one, the node holds the bucket credentials and the
   operator needs none of their own. */
const bucketArgs: ArgsDef = {
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

/** The application a command acts on: a name, optionally suffixed by an env. */
const nameArgs: ArgsDef = {
  name: { type: "string", description: "Application to act on", required: true },
  env: { type: "string", description: "Address the application <name>-<env> instead" },
};

const adminArgs: ArgsDef = { ...remoteArgs, ...nameArgs };
const targetArgs: ArgsDef = { ...remoteArgs, ...bucketArgs, ...nameArgs };

const listArgs: ArgsDef = {
  ...remoteArgs,
  json: { type: "boolean", description: "Print the records as JSON instead of a table" },
};

const showArgs: ArgsDef = {
  ...adminArgs,
  json: { type: "boolean", description: "Print the record as JSON instead of a summary" },
};

const labelArgs: ArgsDef = {
  ...adminArgs,
  pairs: {
    type: "positional",
    required: false,
    description: "Labels as key=value pairs, REPLACING every label the application carries",
  },
};

const deleteArgs: ArgsDef = {
  ...targetArgs,
  force: {
    type: "boolean",
    description: "Delete whatever state it is in, skipping the retirement and grace requirements",
  },
};

const selectorArgs: ArgsDef = {
  ...targetArgs,
  set: {
    type: "string",
    multiple: true,
    valueHint: "key=value",
    description: "Label a node must carry to serve it; one pair per flag",
  },
  clear: { type: "boolean", description: "Let it run on every node again" },
};

const replicasArgs: ArgsDef = {
  ...targetArgs,
  count: {
    type: "string",
    description: `How many nodes should serve it: "all", or a whole number of at least 1`,
    required: true,
  },
};

const list: CommandDef = defineCommand({
  meta: {
    name: "list",
    description: "List the applications this key reaches, and which of them are blocked",
  },
  args: listArgs,
  run: guarded(runList),
});

const show: CommandDef = defineCommand({
  meta: { name: "show", description: "Show one application: its state, placement and labels" },
  args: showArgs,
  run: guarded(runShow),
});

const block: CommandDef = defineCommand({
  meta: {
    name: "block",
    description: "Stop serving and deploying an application, reversibly (admin only)",
  },
  args: adminArgs,
  run: guarded(runBlock),
});

const unblock: CommandDef = defineCommand({
  meta: {
    name: "unblock",
    description: "Put a blocked application back into service (admin only)",
  },
  args: adminArgs,
  run: guarded(runUnblock),
});

const label: CommandDef = defineCommand({
  meta: {
    name: "label",
    description: "Replace an application's labels, which scafo stores and never reads (admin only)",
  },
  args: labelArgs,
  run: guarded(runLabel),
});

const retire: CommandDef = defineCommand({
  meta: { name: "retire", description: "Stop serving an application, reversibly" },
  args: targetArgs,
  run: guarded(runRetire),
});

const unretire: CommandDef = defineCommand({
  meta: { name: "unretire", description: "Put a retired application back into service" },
  args: targetArgs,
  run: guarded(runUnretire),
});

const selector: CommandDef = defineCommand({
  meta: { name: "selector", description: "Choose which nodes may serve an application" },
  args: selectorArgs,
  run: guarded(runSelector),
});

const replicas: CommandDef = defineCommand({
  meta: { name: "replicas", description: "Choose how many nodes serve an application" },
  args: replicasArgs,
  run: guarded(runReplicas),
});

const remove: CommandDef = defineCommand({
  meta: { name: "delete", description: "Delete a retired or forced application" },
  args: deleteArgs,
  run: guarded(runDelete),
});

export const app: CommandDef = defineCommand({
  meta: {
    name: "app",
    description: "The things this installation hosts: list, inspect, place, retire and delete them",
  },
  subCommands: {
    list,
    show,
    block,
    unblock,
    label,
    retire,
    unretire,
    selector,
    replicas,
    delete: remove,
  },
});

/* ---------------------------------------------------------------- internals */

async function runList(flags: Record<string, unknown>): Promise<void> {
  const api = await apiFor(flags);
  const listing = await api.list();

  console.log(
    flags.json === true ? JSON.stringify(listing, null, 2) : formatApplicationTable(listing),
  );
}

async function runShow(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const api = await apiFor(flags);
  const found = await api.show(name);

  console.log(flags.json === true ? JSON.stringify(found, null, 2) : formatApplication(found));
}

async function runBlock(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const api = await apiFor(flags);
  const blocked = await api.block(name);

  console.log(
    `scafo: blocked "${blocked.name}" through ${api.via}; every node stops serving it on its ` +
      `next pass, its hosts leave ingress and it accepts no deploys — nothing of it has ` +
      `been deleted, and "scafo app unblock --name ${blocked.name}" puts it all back`,
  );
}

async function runUnblock(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const api = await apiFor(flags);
  const application = await api.unblock(name);

  assertNotBlocked(application);
  console.log(
    `scafo: "${application.name}" is no longer blocked; the nodes that should serve it start ` +
      `it again on their next pass`,
  );
}

async function runLabel(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  /* Read before anything is contacted, so a malformed pair costs no request. */
  const labels = readLabelArgs(positionals(flags));
  const api = await apiFor(flags);

  const updated = await api.setLabels(name, labels);
  const count = Object.keys(updated.labels ?? {}).length;
  console.log(
    count === 0
      ? `scafo: cleared every label on "${updated.name}"`
      : `scafo: "${updated.name}" now carries ${String(count)} label${count === 1 ? "" : "s"}, ` +
          `and no others — scafo stores them and reads none of them`,
  );
}

async function runRetire(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const ops = await opsFor(flags);

  console.log(describeRetirement(name, await ops.retire(name)));
}

async function runUnretire(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const ops = await opsFor(flags);
  const application = await ops.unretire(name);

  if (application.retiredAt !== undefined) {
    throw new ScafoError("cas-conflict", "Application is still retired", {
      detail: `"${name}" still carries ${application.retiredAt}`,
    });
  }
  console.log(
    `scafo: "${name}" is no longer retired; the nodes that should serve it start it again on ` +
      `their next pass`,
  );
}

async function runSelector(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  /* Read before anything is contacted, so a malformed label costs no request. */
  const wanted = readSelectorFlags({ set: flagList(flags.set), clear: flags.clear === true });
  const ops = await opsFor(flags);

  console.log(describeSelectorChange(name, await ops.setSelector(name, wanted)));
}

async function runReplicas(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const count = parseReplicas(required(flags, "count"));
  const ops = await opsFor(flags);

  console.log(describeReplicasChange(name, await ops.setReplicas(name, count)));
}

async function runDelete(flags: Record<string, unknown>): Promise<void> {
  const name = target(flags);
  const force = flags.force === true;
  const ops = await opsFor(flags);

  const deleted = await ops.delete(name, { force });
  const count = deleted.length;
  console.log(
    `scafo: deleted "${name}" through ${ops.via}, ` +
      `${String(count)} object${count === 1 ? "" : "s"}`,
  );
  for (const key of deleted) console.log(`  ${key}`);
}

/** The application this invocation addresses, `--env` resolved. */
function target(flags: Record<string, unknown>): string {
  return resolveApplication({ name: text(flags.name), env: text(flags.env) });
}

/**
 * The admin surface behind whichever remote this invocation resolved.
 *
 * A NODE IS REQUIRED, and the refusal says so rather than falling back to the
 * bucket: see the header of `_applications.ts` for why there is no bucket path.
 */
async function apiFor(flags: Record<string, unknown>): Promise<ApplicationApi> {
  const resolved = await resolveOperator({
    home: resolveOperatorHome(),
    env: process.env,
    flags: operatorFlags(flags),
    readFile: readTextFile,
  });

  if (resolved.nodeUrl === undefined) {
    throw new ScafoError("invalid-input", "No node to ask", {
      detail:
        `administering an application is an operator-key act rather than a bucket one, so it ` +
        `goes through a node: pass --node <url>, or --remote <name> of a remote that names one`,
    });
  }
  return applicationApi({
    url: nodeBaseUrl(resolved.nodeUrl),
    authorize: operatorSigner(await resolved.readKey()),
  });
}

/**
 * Which way this invocation reaches the installation. A node is asked whenever
 * one is named — by `--node`, or by the remote this operator's home resolved —
 * and everything else falls back to the bucket, which is what an installation
 * with no node running has, and what `scafo trust` does too.
 */
async function opsFor(flags: Record<string, unknown>): Promise<ApplicationOps> {
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
    flags: configFlags(flags),
    env: process.env,
    readFile: readTextFile,
  });
  return directOps(createRegistry(config));
}

/** A block the node reports as still standing is a failure rather than a success line. */
function assertNotBlocked(application: ApplicationRecord): void {
  if (application.blocked !== true) return;

  throw new ScafoError("cas-conflict", "Application is still blocked", {
    detail: `"${application.name}" still carries the flag after the call`,
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

/** Every positional, which is where the label pairs land. */
function positionals(flags: Record<string, unknown>): string[] {
  const rest = flags._;
  if (!Array.isArray(rest)) return [];
  return rest.filter((entry): entry is string => typeof entry === "string");
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
