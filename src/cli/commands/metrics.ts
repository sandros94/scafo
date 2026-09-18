/*
 * `scafo metrics`: what the fleet served over a window, per application.
 *
 * Read STRAIGHT OUT OF THE BUCKET, like `scafo trust` and for
 * the same reason: the numbers were flushed there by whichever nodes were
 * running at the time, and the nodes that wrote them may well be gone. No node
 * is asked and none has to be up.
 *
 * The snapshots are monotonic totals per node, so the window is a subtraction —
 * see `src/cli/_metrics.ts` for what that means for a window shorter than the
 * flush interval, and for what happens across a node restart.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadDaemonConfig } from "../../daemon/config.ts";
import { counterRecords } from "../../daemon/observe-records.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { resolveApplication } from "../_application.ts";
import { createRegistry } from "../_bootstrap.ts";
import { applicationsCounted, formatMetrics, noCounters, summarizeMetrics } from "../_metrics.ts";
import { readMetricsNaming } from "../_metrics-names.ts";
import { nothingRecorded, readObservations, windowFrom } from "../_observe-read.ts";
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

const metricsArgs: ArgsDef = {
  ...bucketArgs,
  name: { type: "string", description: "Only this application" },
  env: { type: "string", description: "Narrow to the application <name>-<env> instead" },
  since: {
    type: "string",
    description: "How far back to read: a duration (90s, 15m, 1h, 7d) or an ISO-8601 instant (1h)",
  },
  json: { type: "boolean", description: "Print the summary as JSON instead of a table" },
};

export const metrics: CommandDef = defineCommand({
  meta: { name: "metrics", description: "What the fleet served, per application" },
  args: metricsArgs,
  async run({ args }): Promise<void> {
    try {
      await runMetrics(args as Record<string, unknown>);
    } catch (error) {
      reportFailure(error);
    }
  },
});

async function runMetrics(flags: Record<string, unknown>): Promise<void> {
  /* Read before the bucket is contacted, so a malformed --since costs no request. */
  const window = windowFrom(text(flags.since), Date.now());
  const registry = await registryFor(flags);

  const found = await readObservations(registry, { window });
  /* What the counted names ARE, rather than what the counting node guessed they
     were: a label no application answers to is nobody's. Only the applications
     this window named are looked up. */
  const naming = await readMetricsNaming(registry, applicationsCounted(found.records));
  const summary = summarizeMetrics(found.records, window, {
    naming,
    ...(text(flags.name) === undefined
      ? {}
      : { application: resolveApplication({ name: text(flags.name), env: text(flags.env) }) }),
  });

  if (flags.json === true) {
    console.log(
      JSON.stringify({ ...summary, files: found.files, malformed: found.malformed }, null, 2),
    );
    return;
  }

  if (summary.samples === 0) {
    /* Three different silences, and they call for three different next steps:
       nothing was ever written, something was written but not in this window, or
       the nodes report on themselves and simply count no requests. */
    console.log(
      counterRecords(found.records).length === 0 && found.records.length > 0
        ? noCounters(found.records)
        : nothingRecorded(found, window),
    );
    return;
  }

  console.log(
    `scafo: ${summary.since} .. ${summary.until}, ${String(summary.samples)} snapshot(s) from ` +
      `${String(summary.nodes.length)} node(s)`,
  );
  console.log(formatMetrics(summary));
  if (found.malformed > 0) {
    console.log(`scafo: ${String(found.malformed)} row(s) were not records and were skipped`);
  }
  if (found.unreadable.length > 0) {
    console.log(
      `scafo: ${String(found.unreadable.length)} file(s) could not be read — a newer daemon's ` +
        `encoding, or an object that is not the one its name promises`,
    );
  }
}

async function registryFor(flags: Record<string, unknown>): Promise<RegistryContext> {
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
