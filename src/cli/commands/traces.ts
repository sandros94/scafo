/*
 * `scafo traces`: what the nodes did, in order.
 *
 * Read straight out of the bucket, exactly as `scafo metrics` is and for the
 * same reason — the events were flushed there by whichever node saw them, and
 * that node may be gone.
 *
 * THE RECONCILE LOOP'S OWN PASSES ARE LEFT OUT UNLESS `--all` ASKS FOR THEM.
 * Every node emits two of them every 5s whether or not anything happened, so a
 * default window is otherwise nothing but housekeeping and the operational or
 * audit events a reader came for are pushed out of it. How many were held back
 * is always said.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { ScafoError } from "../../core/error.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { resolveApplication } from "../_application.ts";
import { createRegistry } from "../_bootstrap.ts";
import { configFlags } from "../_flags.ts";
import { nothingRecorded, readObservations, windowFrom } from "../_observe-read.ts";
import { formatTraces, selectTraces } from "../_traces.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

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

const tracesArgs: ArgsDef = {
  ...bucketArgs,
  name: { type: "string", description: "Only what belongs to this application" },
  env: { type: "string", description: "Narrow to the application <name>-<env> instead" },
  since: {
    type: "string",
    description: "How far back to read: a duration (90s, 15m, 1h, 7d) or an ISO-8601 instant (1h)",
  },
  limit: { type: "string", description: "Events to show at most, newest kept (200)" },
  all: {
    type: "boolean",
    description:
      "Include the reconcile loop's own passes, which every node emits every 5s whether or " +
      "not anything happened; left out by default so they cannot fill the window",
  },
  json: { type: "boolean", description: "Print the events as JSON instead of lines" },
};

export const traces: CommandDef = defineCommand({
  meta: { name: "traces", description: "What the nodes did, in order" },
  args: tracesArgs,
  async run({ args }): Promise<void> {
    try {
      await runTraces(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

async function runTraces(flags: Record<string, unknown>): Promise<void> {
  /* Read before the bucket is contacted, so a malformed flag costs no request. */
  const window = windowFrom(text(flags.since), Date.now());
  const limit = limitOf(flags);
  const registry = await registryFor(flags);

  const found = await readObservations(registry, { window });
  const selection = selectTraces(found.records, {
    ...(text(flags.name) === undefined
      ? {}
      : { application: resolveApplication({ name: text(flags.name), env: text(flags.env) }) }),
    ...(flags.all === true ? { all: true } : {}),
    ...limit,
  });

  if (flags.json === true) {
    console.log(
      JSON.stringify(
        {
          since: new Date(window.sinceMs).toISOString(),
          until: new Date(window.untilMs).toISOString(),
          events: selection.events,
          matched: selection.matched,
          omitted: selection.omitted,
          hidden: selection.hidden,
          files: found.files,
          malformed: found.malformed,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (selection.events.length === 0) {
    console.log(
      selection.hidden > 0 ? onlyPasses(selection.hidden) : nothingRecorded(found, window),
    );
    return;
  }

  console.log(formatTraces(selection));
  if (selection.omitted > 0) {
    console.log(
      `scafo: ${String(selection.omitted)} older event(s) not shown of ` +
        `${String(selection.matched)}; raise --limit or narrow --since`,
    );
  }
  /* Never silently: they are events the node really did record, and a reader who
     came looking for one of them has to be told where it went. */
  if (selection.hidden > 0) {
    console.log(
      `scafo: ${String(selection.hidden)} reconcile pass event(s) left out; --all shows them`,
    );
  }
  if (found.malformed > 0) {
    console.log(`scafo: ${String(found.malformed)} row(s) were not records and were skipped`);
  }
}

/**
 * What a window holding nothing but reconcile passes says.
 *
 * Distinct from having found nothing at all, and the distinction is the useful
 * one: the nodes ARE observing and ARE writing, and this window simply holds
 * none of what a person debugs with.
 */
function onlyPasses(hidden: number): string {
  return (
    `scafo: nothing to show — the ${String(hidden)} event(s) in this window are all reconcile ` +
    `passes, which every node emits every 5s whether or not anything happened. ` +
    `--all shows them`
  );
}

/** `--limit` as the selector takes it, or nothing when it was not given. */
function limitOf(flags: Record<string, unknown>): { limit?: number } {
  const given = text(flags.limit);
  if (given === undefined) return {};

  const limit = Number(given);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ScafoError("invalid-input", "Invalid --limit", {
      detail: `"${given}" must be a whole number of events, at least 1`,
    });
  }
  return { limit };
}

async function registryFor(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadDaemonConfig({
    configPath: text(flags.config),
    flags: configFlags(flags),
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
