/*
 * `scafo deployment`: what an application has published, and how an operator
 * takes the old ones back.
 *
 * Celld publishes every deploy under the application's fleet prefix and deletes
 * none of them, so a long-lived application keeps every bundle it has ever run.
 * `prune` is the operator's hands on that, and it is UNSTABLE on purpose: the
 * moment Celld grows a deployment lifecycle of its own, this follows it. It is
 * also PINNED, because it reads formats Celld owns: it plans nothing unless the
 * installation is answering on a release this build was verified against.
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
import { verifiedReleaseList } from "../../core/registry/_celld-contract.ts";
import { resolveApplication } from "../_application.ts";
import { createRegistry } from "../_bootstrap.ts";
import { confirm } from "../_confirm.ts";
import { readTextFile, reportFailure } from "../_utils.ts";
import { warn, warnUnstable } from "../_warn.ts";

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

/**
 * The two gates an operator did not set, chosen to protect somebody who typed
 * this command for the first time: Kubernetes' own `revisionHistoryLimit`
 * default of ten, and a day of grace on top of it. BOTH ARE ALWAYS WEIGHED —
 * what goes is past the count and older than the window — and a zero lifts
 * whichever one it is given to.
 */
const DEFAULT_KEEP = 10;

/** The age window an operator named none of their own, as they would have typed it. */
const DEFAULT_OLDER_THAN = "24h";

const pruneArgs: ArgsDef = {
  ...bucketArgs,
  "name": { type: "string", description: "Application to prune deployments of", required: true },
  "env": { type: "string", description: "Address the application <name>-<env> instead" },
  "keep": {
    type: "string",
    description:
      `How many of the newest deployments to keep (default ${String(DEFAULT_KEEP)}; 0 keeps ` +
      `only what a Celld pointer names)`,
  },
  "older-than": {
    type: "string",
    description:
      `Only delete deployments older than this: 30d, 12h, 45m, or seconds (3600) (default ` +
      `${DEFAULT_OLDER_THAN}; 0 deletes them whatever their age)`,
  },
  "yes": {
    type: "boolean",
    description: "Delete without asking; required when the input is not a terminal",
  },
  "dry-run": { type: "boolean", description: "Print what would go, and delete nothing" },
};

/** The command an operator types, as the warning names it. */
const PRUNE_COMMAND = "scafo deployment prune";

/** Why `scafo deployment prune` may change under the operator who scripted it. */
export const PRUNE_UNSTABLE_WHY: string =
  `Celld may grow a native deployment lifecycle (denoland/celld#181), and this command ` +
  `follows upstream when it does; it reads Celld's own bucket formats, so it runs only ` +
  `against the Celld releases it was verified against (${verifiedReleaseList()})`;

/** Said in the help and again in the summary, because it is what prune does past the deployments. */
const BLOBS_COLLECTED =
  `shared asset blobs under deploy-blobs/ that no kept deployment references go once they are ` +
  `older than the window`;

/**
 * Said before the plan of a run that lifted the age window.
 *
 * The window is the ONLY thing that separates a blob nobody wants from one a
 * deploy uploaded a second ago and is about to reference — a deploy writes its
 * files before anything makes it visible. An operator who lifts it is saying
 * nobody is deploying, and this is where they are told that is what they said.
 */
export const AGE_GATE_LIFTED_WARNING: string =
  `"--older-than 0" lifts the age gate: a deploy in flight uploads its files before it is ` +
  `visible, and pruning now can delete one that is happening; do not prune while anyone deploys`;

/** Warns the operator who lifted the age gate; any window at all is silent. */
export function warnAgeGateLifted(olderThanMs: number): void {
  if (olderThanMs !== 0) return;
  warn(AGE_GATE_LIFTED_WARNING);
}

const prune: CommandDef = defineCommand({
  meta: {
    name: "prune",
    description:
      `Delete the old Celld deployments of one application; what a pointer names is ` +
      `never deleted, ${BLOBS_COLLECTED}, and the run is refused unless the installation is ` +
      `answering on Celld ${verifiedReleaseList()}`,
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
    description: "Manage what an application has published",
  },
  subCommands: { prune },
});

async function runPrune(flags: Record<string, unknown>): Promise<void> {
  /* Before anything is read or deleted: an operator who has scripted this
     deserves the notice on the run that still worked. */
  warnUnstable(PRUNE_COMMAND, PRUNE_UNSTABLE_WHY);

  const wanted = readPruneFlags(flags);
  /* Before the plan, not beside it: the one gate whose lifting can cost an
     operator a deploy that is happening while they read the plan. */
  warnAgeGateLifted(wanted.olderThan.ms);

  const registry = await openRegistry(flags);
  const plan = await planPrune(registry, {
    application: wanted.application,
    keep: wanted.keep,
    olderThanMs: wanted.olderThan.ms,
    now: new Date(),
  });

  await runPruneDialog({
    report: {
      plan,
      keep: wanted.keep,
      olderThan: wanted.olderThan.text,
      ...(wanted.dryRun ? { dryRun: true } : {}),
    },
    yes: wanted.yes,
    prune: async (): Promise<void> => {
      await executePrune(registry, plan);
    },
  });
}

/** One run of `prune` talking to the operator, with everything it touches injected. */
export interface PruneDialog {
  /** The plan, and how it is to be read out. */
  report: PruneReport;
  /** `--yes`: the question was answered on the command line. */
  yes: boolean;
  /** Whether there is somebody to ask. Defaults to what stdin says. */
  isTTY?: boolean;
  /** How the question is put and the answer read. Defaults to the terminal. */
  ask?: (question: string) => Promise<string>;
  /** Carries the plan out. Called only when the answer allows it. */
  prune: () => Promise<void>;
  /** Where the lines go. Defaults to stdout. */
  say?: (line: string) => void;
}

/**
 * The whole exchange, in the order an operator lives it: what the plan weighed,
 * the question a real deletion asks, the deletion, and what went.
 *
 * THE PLAN IS PRINTED BEFORE THE QUESTION, because the question is only worth
 * asking of somebody who has read the answer's consequences.
 */
export async function runPruneDialog(dialog: PruneDialog): Promise<void> {
  const say =
    dialog.say ??
    ((line: string): void => {
      console.log(line);
    });

  for (const line of planLines(dialog.report)) say(line);

  const decision = await decidePrune(dialog);
  if (decision === "declined") {
    say(NOTHING_DELETED);
    return;
  }
  if (decision === "delete") await dialog.prune();

  say(summarize(dialog.report));
}

/** What became of the question: carried out, answered no, or never asked. */
type PruneDecision = "delete" | "declined" | "nothing";

/** Said to an operator who answered the question with anything but yes. */
const NOTHING_DELETED = "scafo: nothing deleted";

/**
 * Whether the plan is carried out. A dry run and an empty plan ask nothing —
 * there is no deletion to consent to — and `--yes` has answered already.
 */
async function decidePrune(dialog: PruneDialog): Promise<PruneDecision> {
  const plan = dialog.report.plan;
  if (dialog.report.dryRun === true || !deletesAnything(plan)) return "nothing";
  if (dialog.yes) return "delete";

  const said = await confirm(deletionQuestion(plan), {
    command: PRUNE_COMMAND,
    ...(dialog.isTTY === undefined ? {} : { isTTY: dialog.isTTY }),
    ...(dialog.ask === undefined ? {} : { ask: dialog.ask }),
  });
  return said ? "delete" : "declined";
}

/** Whether the plan names anything at all to delete: a deployment, or a blob. */
function deletesAnything(plan: PrunePlan): boolean {
  return plan.delete.length > 0 || plan.blobs.delete.length > 0;
}

/** The question itself: how much goes, and out of where. */
function deletionQuestion(plan: PrunePlan): string {
  const parts: string[] = [];
  if (plan.delete.length > 0) {
    parts.push(
      `${plural(plan.delete.length, "deployment")} (${plural(objectsOf(plan), "object")})`,
    );
  }
  if (plan.blobs.delete.length > 0) parts.push(plural(plan.blobs.delete.length, "asset blob"));

  return `Delete ${parts.join(" and ")} of "${plan.application}"? [y/N] `;
}

/** What `scafo deployment prune` was told to do, once every flag has been read. */
export interface PruneFlags {
  application: string;
  keep: number;
  /** The age window as the operator typed it, and what it means in milliseconds. */
  olderThan: { text: string; ms: number };
  dryRun: boolean;
  /** `--yes`: the operator answered the question on the command line. */
  yes: boolean;
}

/** Reads and validates the prune flags before a bucket is opened. */
export function readPruneFlags(flags: Record<string, unknown>): PruneFlags {
  /* Both spellings, because the parser hands over the kebab name it was typed
     as and the camel one it derives; a plain record has only whichever was set. */
  const window = text(flags["older-than"] ?? flags.olderThan) ?? DEFAULT_OLDER_THAN;

  return {
    application: resolveApplication({ name: text(flags.name), env: text(flags.env) }),
    keep: readKeep(flags.keep),
    olderThan: { text: window, ms: parseOlderThan(window) },
    dryRun: (flags["dry-run"] ?? flags.dryRun) === true,
    yes: flags.yes === true,
  };
}

const DURATION_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `--older-than` in milliseconds: `30d`, `12h`, `45m`, `3600s`, a plain whole
 * number of seconds, or `0`.
 *
 * ZERO IS THE AGE GATE LIFTED — delete whatever `--keep` did not spare, whatever
 * its age. It has to be typed: leaving the flag out is a day of grace, and an
 * operator who means to delete this morning's deployments says so.
 */
export function parseOlderThan(value: string): number {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value.trim());

  if (match === null) {
    throw new ScafoError("invalid-input", "Invalid --older-than", {
      detail:
        `"${value}" is not a duration: give 30d, 12h, 45m, a whole number of seconds (3600), ` +
        `or 0 to delete whatever --keep did not spare whatever its age`,
    });
  }
  const unit = match[2];
  return Number(match[1]) * (unit === undefined ? DURATION_UNITS_MS.s : DURATION_UNITS_MS[unit]);
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
  /** The age window exactly as the operator typed it, or the default they took. */
  olderThan: string;
  /** Nothing was deleted; the lines say what would have been. */
  dryRun?: boolean;
}

/** Every line `scafo deployment prune` prints, in the order it prints them. */
export function describePrune(report: PruneReport): string[] {
  return [...planLines(report), summarize(report)];
}

/** One line per deployment the plan weighed: what stays and why, then what goes. */
function planLines(report: PruneReport): string[] {
  const lines = report.plan.keep.map((kept) => `keep ${nameOf(kept)}: ${whyKept(kept, report)}`);

  const verb = report.dryRun === true ? "would delete" : "delete";
  for (const doomed of report.plan.delete) {
    lines.push(`${verb} ${nameOf(doomed)}: ${whatGoes(doomed)}`);
  }

  const blobs = blobLine(report);
  if (blobs !== undefined) lines.push(blobs);
  return lines;
}

/**
 * The one line the shared blobs get: what goes, or, when nothing does, how many
 * stayed and what kept them. An application with no blobs at all says nothing.
 */
function blobLine(report: PruneReport): string | undefined {
  const blobs = report.plan.blobs;
  if (blobs.delete.length > 0) {
    const verb = report.dryRun === true ? "would delete" : "delete";
    return `${verb} ${plural(blobs.delete.length, "asset blob")} no kept deployment references`;
  }
  if (blobs.keep > 0) {
    return `keep ${plural(blobs.keep, "asset blob")}, referenced or younger than ${report.olderThan}`;
  }
  return undefined;
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
      return `younger than ${report.olderThan}`;
    }
  }
}

function whatGoes(doomed: StoredDeployment): string {
  const record = doomed.recordKey === undefined ? "no deployment record" : "its deployment record";
  return `${plural(doomed.keys.length, "object")} and ${record}`;
}

function summarize(report: PruneReport): string {
  const where = `"${report.plan.application}"`;
  const kept = `kept ${String(report.plan.keep.length)}`;
  if (!deletesAnything(report.plan)) {
    return `scafo: nothing to prune in ${where}, ${kept}; ${BLOBS_COLLECTED}`;
  }

  const objects = objectsOf(report.plan);
  const records = report.plan.delete.filter((one) => one.recordKey !== undefined).length;
  const blobs = report.plan.blobs.delete.length;
  const verb = report.dryRun === true ? "would prune" : "pruned";

  return (
    `scafo: ${verb} ${plural(report.plan.delete.length, "deployment")} ` +
    `(${plural(objects, "object")}, ${plural(records, "deployment record")}, ` +
    `${plural(blobs, "asset blob")}) of ${where}, ` +
    `${kept}; ` +
    `${BLOBS_COLLECTED}`
  );
}

/** Every store object the plan selected, across the deployments it selected. */
function objectsOf(plan: PrunePlan): number {
  return plan.delete.reduce((total, one) => total + one.keys.length, 0);
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
