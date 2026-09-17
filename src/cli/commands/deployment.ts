/*
 * `scafo deployment`: what an environment has published, and how an operator
 * takes the old ones back.
 *
 * Celld publishes every deploy under the environment's fleet prefix and deletes
 * none of them, so a long-lived environment keeps every bundle it has ever run.
 * `prune` is the operator's hands on that, and it is UNSTABLE on purpose: the
 * moment Celld grows a deployment lifecycle of its own, this follows it.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import {
  executePrune,
  type KeptDeployment,
  planPrune,
  type PrunePlan,
  type StoredDeployment,
} from "../../core/registry/prune.ts";
import { createRegistry } from "../_bootstrap.ts";
import { readTextFile, reportFailure } from "../_utils.ts";
import { warnUnstable } from "../_warn.ts";

/** The bucket the registry lives in, exactly as `scafo sail` takes it. */
const bucketArgs: ArgsDef = {
  "config": { type: "string", description: "Path to scafo.config.jsonc" },
  "endpoint": { type: "string", description: "S3-compatible endpoint URL" },
  "region": { type: "string", description: "Signing region of the bucket" },
  "bucket": { type: "string", description: "Bucket holding the registry" },
  "prefix": { type: "string", description: "Key prefix within the bucket" },
  "access-key": { type: "string", description: "Bucket access key id" },
  "secret-key": { type: "string", description: "Bucket secret access key" },
};

/** Deployments kept when the operator named no count of their own. */
const DEFAULT_KEEP = 3;

const pruneArgs: ArgsDef = {
  ...bucketArgs,
  "project": { type: "string", description: "Project the environment belongs to", required: true },
  "env": { type: "string", description: "Environment to prune deployments of", required: true },
  "keep": {
    type: "string",
    description: `How many of the newest deployments to keep (default ${String(DEFAULT_KEEP)})`,
  },
  "older-than": {
    type: "string",
    description: "Only delete deployments older than this: 30d, 12h, 45m, or seconds (3600)",
  },
  "dry-run": { type: "boolean", description: "Print what would go, and delete nothing" },
};

/** The command an operator types, as the warning names it. */
const PRUNE_COMMAND = "scafo deployment prune";

/** Why `scafo deployment prune` may change under the operator who scripted it. */
export const PRUNE_UNSTABLE_WHY: string =
  `Celld may grow a native deployment lifecycle (denoland/celld#181), and this command ` +
  `follows upstream when it does`;

/** Said in the help and again in the summary, because it is the one thing this never does. */
const BLOBS_LEFT_ALONE = "shared asset blobs under deploy-blobs/ are left in place";

const prune: CommandDef = defineCommand({
  meta: {
    name: "prune",
    description:
      `Delete the old Celld deployments of one environment; what a pointer names is ` +
      `never deleted and ${BLOBS_LEFT_ALONE}`,
  },
  args: pruneArgs,
  async run({ args }): Promise<void> {
    try {
      await runPrune(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

export const deployment: CommandDef = defineCommand({
  meta: {
    name: "deployment",
    description: "Manage what a project's environments have published",
  },
  subCommands: { prune },
});

async function runPrune(flags: Record<string, unknown>): Promise<void> {
  /* Before anything is read or deleted: an operator who has scripted this
     deserves the notice on the run that still worked. */
  warnUnstable(PRUNE_COMMAND, PRUNE_UNSTABLE_WHY);

  const wanted = readPruneFlags(flags);
  const registry = await openRegistry(flags);
  const plan = await planPrune(registry, {
    project: wanted.project,
    env: wanted.env,
    keep: wanted.keep,
    ...(wanted.olderThan === undefined ? {} : { olderThanMs: wanted.olderThan.ms }),
    now: new Date(),
  });

  if (!wanted.dryRun) await executePrune(registry, plan);

  const lines = describePrune({
    plan,
    keep: wanted.keep,
    ...(wanted.olderThan === undefined ? {} : { olderThan: wanted.olderThan.text }),
    ...(wanted.dryRun ? { dryRun: true } : {}),
  });
  for (const line of lines) console.log(line);
}

/** What `scafo deployment prune` was told to do, once every flag has been read. */
export interface PruneFlags {
  project: string;
  env: string;
  keep: number;
  /** The age window as the operator typed it, and what it means in milliseconds. */
  olderThan?: { text: string; ms: number };
  dryRun: boolean;
}

/** Reads and validates the prune flags before a bucket is opened. */
export function readPruneFlags(flags: Record<string, unknown>): PruneFlags {
  /* Both spellings, because the parser hands over the kebab name it was typed
     as and the camel one it derives; a plain record has only whichever was set. */
  const window = text(flags["older-than"] ?? flags.olderThan);

  return {
    project: required(flags, "project"),
    env: required(flags, "env"),
    keep: readKeep(flags.keep),
    ...(window === undefined ? {} : { olderThan: { text: window, ms: parseOlderThan(window) } }),
    dryRun: (flags["dry-run"] ?? flags.dryRun) === true,
  };
}

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `--older-than` in milliseconds: `30d`, `12h`, `45m`, `3600s`, or a plain
 * whole number of seconds.
 *
 * Positive only. A zero window means "delete whatever `--keep` did not spare",
 * which is what leaving the flag out already says — and a `--older-than $VAR`
 * whose variable never expanded would otherwise read as exactly that.
 */
export function parseOlderThan(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value.trim());
  const amount = match === null ? 0 : Number(match[1]);

  if (match === null || amount <= 0) {
    throw new ScafoError("invalid-input", "Invalid --older-than", {
      detail:
        `"${value}" is not a positive duration: give 30d, 12h, 45m, or a whole number of ` +
        `seconds (3600)`,
    });
  }
  const unit = match[2];
  return amount * (unit === undefined ? DURATION_UNITS_MS.s : DURATION_UNITS_MS[unit]);
}

function readKeep(value: unknown): number {
  if (value === undefined) return DEFAULT_KEEP;

  const given = keepText(value);
  const keep = Number(given);
  if (given === "" || !Number.isInteger(keep) || keep < 0) {
    throw new ScafoError("invalid-input", "Invalid --keep", {
      detail: `"${given}" must be a whole number of deployments to keep, zero or more`,
    });
  }
  return keep;
}

/** What was typed, as text; anything the parser could not have produced reads as empty. */
function keepText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/** A plan as the terminal reads it: one line per deployment, then the summary. */
export interface PruneReport {
  plan: PrunePlan;
  /** How many of the newest deployments the plan was told to keep. */
  keep: number;
  /** The age window exactly as the operator typed it, when they gave one. */
  olderThan?: string;
  /** Nothing was deleted; the lines say what would have been. */
  dryRun?: boolean;
}

/** Every line `scafo deployment prune` prints, in the order it prints them. */
export function describePrune(report: PruneReport): string[] {
  const lines = report.plan.keep.map((kept) => `keep ${nameOf(kept)}: ${whyKept(kept, report)}`);

  const verb = report.dryRun === true ? "would delete" : "delete";
  for (const doomed of report.plan.delete) {
    lines.push(`${verb} ${nameOf(doomed)}: ${whatGoes(doomed)}`);
  }

  lines.push(summarize(report));
  return lines;
}

function nameOf(deployment: StoredDeployment): string {
  return `${deployment.script}/${deployment.version}`;
}

function whyKept(kept: KeptDeployment, report: PruneReport): string {
  switch (kept.reason) {
    case "current": {
      return "current, the fleet's selector points at it";
    }
    case "within-keep": {
      return `within the newest ${String(report.keep)} deployments`;
    }
    case "within-age": {
      return `younger than ${report.olderThan ?? "the window given"}`;
    }
  }
}

function whatGoes(doomed: StoredDeployment): string {
  const record = doomed.recordKey === undefined ? "no deployment record" : "its deployment record";
  return `${plural(doomed.keys.length, "object")} and ${record}`;
}

function summarize(report: PruneReport): string {
  const where = `"${report.plan.project}/${report.plan.env}"`;
  const kept = `kept ${String(report.plan.keep.length)}`;
  if (report.plan.delete.length === 0) {
    return `scafo: nothing to prune in ${where}, ${kept}; ${BLOBS_LEFT_ALONE}`;
  }

  const objects = report.plan.delete.reduce((total, one) => total + one.keys.length, 0);
  const records = report.plan.delete.filter((one) => one.recordKey !== undefined).length;
  const verb = report.dryRun === true ? "would prune" : "pruned";

  return (
    `scafo: ${verb} ${plural(report.plan.delete.length, "deployment")} ` +
    `(${plural(objects, "object")}, ${plural(records, "deployment record")}) of ${where}, ` +
    `${kept}; ` +
    `${BLOBS_LEFT_ALONE}`
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** The bucket this subcommand reads and deletes in; no node holds this state. */
async function openRegistry(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadDaemonConfig({
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
