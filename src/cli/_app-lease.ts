/*
 * `scafo app lease`: what a fleet's Celld node leases look like from the bucket,
 * and the one deletion an operator can make of them.
 *
 * UNSTABLE, LOUDLY. Everything under `fleets/<application>/` is Celld's, and
 * this is the only command that deletes a record Celld itself writes on its own
 * schedule. It exists for one failure — a store that holds a lease key it will
 * list and `HEAD` but never `GET`, which wedges every restart of that node's
 * process forever — and it goes the moment Celld recovers such a lease itself.
 *
 * BUCKET-DIRECT, like `scafo deployment prune` and for the same reason: this is
 * fleet-root authority over another system's keyspace, so it is spelled with the
 * bucket credentials rather than an operator key, and no node route offers it.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { ScafoError } from "../core/error.ts";
import { verifiedReleaseList } from "../core/registry/_celld-contract.ts";
import {
  type CelldLeaseDrop,
  type CelldLeaseReading,
  dropCelldLease,
  inspectCelldLeases,
  LEASE_COMMAND,
  type LeaseRead,
  planLeaseDrop,
} from "../core/registry/celld-lease.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { loadDaemonConfig } from "../daemon/config.ts";
import { resolveApplication } from "./_application.ts";
import { createRegistry } from "./_bootstrap.ts";
import { confirm } from "./_confirm.ts";
import { configFlags } from "./_flags.ts";
import { readTextFile, reportFailure } from "./_utils.ts";
import { warnUnstable } from "./_warn.ts";

/** The bucket the fleet lives in, exactly as `scafo sail` takes it. */
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
  name: { type: "string", description: "Application whose fleet holds the leases", required: true },
  env: { type: "string", description: "Address the application <name>-<env> instead" },
};

const showArgs: ArgsDef = {
  ...targetArgs,
  node: { type: "string", description: "Only this Celld node's lease, instead of every one" },
  json: { type: "boolean", description: "Print the readings as JSON instead of a report" },
};

const dropArgs: ArgsDef = {
  ...targetArgs,
  "node": { type: "string", description: "The Celld node whose lease is deleted", required: true },
  "force": {
    type: "boolean",
    description: "Delete a lease that is still held, which a running process may own",
  },
  "yes": {
    type: "boolean",
    description: "Delete without asking; required when the input is not a terminal",
  },
  "dry-run": { type: "boolean", description: "Print what would go, and delete nothing" },
  "json": { type: "boolean", description: "Print what was done as JSON instead of a report" },
};

/** Why `scafo app lease` may change or vanish under the operator who scripted it. */
export const LEASE_UNSTABLE_WHY: string =
  `it reads and deletes inside Celld's own keyspace — the node lease a process must read or ` +
  `create before it has any authority — and it will be removed once Celld recovers such a ` +
  `lease itself; it runs only against the Celld releases it was verified against ` +
  `(${verifiedReleaseList()})`;

const show: CommandDef = defineCommand({
  meta: {
    name: "show",
    description:
      `What the bucket says about an application fleet's Celld node leases: what LIST, HEAD ` +
      `and GET each answer for every key, and whether the lease is held, expired or unreadable`,
  },
  args: showArgs,
  async run({ args }): Promise<void> {
    try {
      await runShow(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

const drop: CommandDef = defineCommand({
  meta: {
    name: "drop",
    description:
      `Delete ONE Celld node lease of an application, which is refused while it is held; ` +
      `the key is read back afterwards and nothing else is touched`,
  },
  args: dropArgs,
  async run({ args }): Promise<void> {
    try {
      await runDrop(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const lease: CommandDef = defineCommand({
  meta: {
    name: "lease",
    description:
      "Celld's own node leases of one application: look at them, and drop a broken one (unstable)",
  },
  subCommands: { show, drop },
});

/* ---------------------------------------------------------------- internals */

async function runShow(flags: Record<string, unknown>): Promise<void> {
  /* Before anything is read: an operator who has scripted this deserves the
     notice on the run that still worked. */
  warnUnstable(LEASE_COMMAND, LEASE_UNSTABLE_WHY);

  const application = target(flags);
  const node = text(flags.node);
  const registry = await openRegistry(flags);

  const readings = await inspectCelldLeases(registry, {
    application,
    ...(node === undefined ? {} : { node }),
    now: new Date(),
  });

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        { application, ...(node === undefined ? {} : { node }), leases: readings },
        null,
        2,
      ),
    );
    return;
  }
  for (const line of describeLeases(application, readings)) console.log(line);
}

async function runDrop(flags: Record<string, unknown>): Promise<void> {
  warnUnstable(LEASE_COMMAND, LEASE_UNSTABLE_WHY);

  const application = target(flags);
  const node = required(flags, "node");
  const dryRun = (flags["dry-run"] ?? flags.dryRun) === true;
  const registry = await openRegistry(flags);

  const before = await planLeaseDrop(registry, { application, node, now: new Date() });

  await runLeaseDropDialog({
    before,
    ...(dryRun ? { dryRun: true } : {}),
    force: flags.force === true,
    yes: flags.yes === true,
    json: flags.json === true,
    drop: async (): Promise<CelldLeaseDrop> =>
      dropCelldLease(registry, before, { now: new Date(), force: flags.force === true }),
  });
}

/** One run of `drop` talking to the operator, with everything it touches injected. */
export interface LeaseDropDialog {
  /** The reading the operator is shown and consents to. */
  before: CelldLeaseReading;
  /** Nothing is deleted; the lines say what would have been. */
  dryRun?: boolean;
  /** `--force`: a held lease is deleted anyway, and the question says so. */
  force: boolean;
  /** `--yes`: the question was answered on the command line. */
  yes: boolean;
  /** Print the whole exchange as one JSON document instead. */
  json?: boolean;
  /** Whether there is somebody to ask. Defaults to what stdin says. */
  isTTY?: boolean;
  /** How the question is put and the answer read. Defaults to the terminal. */
  ask?: (question: string) => Promise<string>;
  /** Carries the deletion out. Called only when the answer allows it. */
  drop: () => Promise<CelldLeaseDrop>;
  /** Where the lines go. Defaults to stdout. */
  say?: (line: string) => void;
}

/**
 * The whole exchange, in the order an operator lives it: what the three reads
 * found, the question a real deletion asks, the deletion, and what the key says
 * afterwards.
 *
 * THE READING IS PRINTED BEFORE THE QUESTION, because a lease is the one record
 * whose deletion an operator must weigh against a process that may still be
 * running.
 */
export async function runLeaseDropDialog(dialog: LeaseDropDialog): Promise<void> {
  const say =
    dialog.say ??
    ((line: string): void => {
      console.log(line);
    });

  const lines = describeLeases(dialog.before.application, [dialog.before]);
  if (dialog.json !== true) for (const line of lines) say(line);

  if (dialog.before.verdict === "absent" || dialog.dryRun === true) {
    if (dialog.json === true) {
      say(JSON.stringify({ ...dropJson(dialog), deleted: false, before: dialog.before }, null, 2));
      return;
    }
    say(nothingDeleted(dialog));
    return;
  }

  if (!dialog.yes) {
    const said = await confirm(deletionQuestion(dialog.before, dialog.force), {
      command: `${LEASE_COMMAND} drop`,
      ...(dialog.isTTY === undefined ? {} : { isTTY: dialog.isTTY }),
      ...(dialog.ask === undefined ? {} : { ask: dialog.ask }),
    });
    if (!said) {
      if (dialog.json === true) {
        say(
          JSON.stringify({ ...dropJson(dialog), deleted: false, before: dialog.before }, null, 2),
        );
        return;
      }
      say(`scafo: nothing deleted`);
      return;
    }
  }

  const done = await dialog.drop();
  if (dialog.json === true) {
    say(JSON.stringify({ ...dropJson(dialog), ...done }, null, 2));
    return;
  }
  say(describeLeaseDrop(done));
}

/** The constant half of a `--json` answer: what the run was asked to do. */
function dropJson(dialog: LeaseDropDialog): Record<string, unknown> {
  return {
    application: dialog.before.application,
    node: dialog.before.node,
    key: dialog.before.key,
    ...(dialog.dryRun === true ? { dryRun: true } : {}),
    ...(dialog.force ? { force: true } : {}),
  };
}

/** Said when a run asks nothing because there is nothing to consent to. */
function nothingDeleted(dialog: LeaseDropDialog): string {
  if (dialog.before.verdict === "absent") {
    return `scafo: nothing to drop, "${dialog.before.key}" does not exist`;
  }
  return `scafo: would delete "${dialog.before.key}"; nothing was deleted`;
}

/** The question itself: which key goes, and what it is believed to be. */
function deletionQuestion(before: CelldLeaseReading, force: boolean): string {
  const held =
    before.verdict === "held" && force
      ? ` IT IS STILL HELD, and --force deletes it anyway: a second process can take this ` +
        `node's cells while the first still serves them.`
      : "";
  return `Delete the ${before.verdict} node lease "${before.key}"?${held} [y/N] `;
}

/** Every line `scafo app lease show` prints, in the order it prints them. */
export function describeLeases(application: string, readings: CelldLeaseReading[]): string[] {
  if (readings.length === 0) {
    return [
      `scafo: "${application}" has no Celld node lease at all; the fleet has never run, or ` +
        `its key prefix is not the one this bucket was published under`,
    ];
  }

  const lines: string[] = [];
  for (const reading of readings) {
    lines.push(`${reading.verdict} ${reading.key}`);
    lines.push(`  LIST ${describeRead(reading.listed)}`);
    lines.push(`  HEAD ${describeRead(reading.head)}`);
    lines.push(`  GET  ${describeRead(reading.get)}`);
    lines.push(`  ${reading.why}`);
  }
  lines.push(summarize(application, readings));
  return lines;
}

/** What one of the three reads answered, on one line. */
function describeRead(read: LeaseRead): string {
  if (read.error !== undefined) return `failed: ${read.error}`;
  if (!read.present) return "not there";

  const said = [
    read.size === undefined ? undefined : `${String(read.size)} bytes`,
    read.etag === undefined ? undefined : `etag ${read.etag}`,
    read.lastModified === undefined ? undefined : `modified ${read.lastModified}`,
  ].filter((one): one is string => one !== undefined);
  return said.length === 0 ? "there, and said nothing about itself" : said.join(", ");
}

/** The count of each verdict, and the command that acts on the ones worth acting on. */
function summarize(application: string, readings: CelldLeaseReading[]): string {
  const counts = new Map<string, number>();
  for (const reading of readings)
    counts.set(reading.verdict, (counts.get(reading.verdict) ?? 0) + 1);

  const said = [...counts.entries()].map(([verdict, count]) => `${String(count)} ${verdict}`);
  const broken = readings.filter((one) => one.verdict === "unreadable");
  const fix =
    broken.length === 0
      ? ""
      : ` — "${LEASE_COMMAND} drop --name ${application} --node ${broken[0]?.node ?? ""}" deletes ` +
        `the first of them, after which the node's process can write its lease again`;

  return `scafo: ${said.join(", ")} of ${plural(readings.length, "node lease")} in "${application}"${fix}`;
}

/** What a real deletion did, and what the key says now. */
export function describeLeaseDrop(drop: CelldLeaseDrop): string {
  if (!drop.stillThere) {
    return (
      `scafo: deleted "${drop.before.key}"; the key is gone, and the Celld process on node ` +
      `"${drop.before.node}" writes its lease again the next time it starts`
    );
  }
  return (
    `scafo: deleted "${drop.before.key}" and the store still answers for it (${drop.after.why}); ` +
    `the deletion may not have taken — read it again, and take it up with the store before ` +
    `restarting the node`
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** The application this invocation addresses, `--env` resolved. */
function target(flags: Record<string, unknown>): string {
  return resolveApplication({ name: text(flags.name), env: text(flags.env) });
}

/** The bucket this command reads and deletes in; no node holds this authority. */
async function openRegistry(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: configFlags(flags),
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
