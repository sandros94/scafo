/*
 * `scafo metrics`: what the fleet served over a window, per project and
 * environment.
 *
 * Read STRAIGHT OUT OF THE BUCKET, like `scafo trust` and `scafo varset` and for
 * the same reason: the numbers were flushed there by whichever nodes were
 * running at the time, and the nodes that wrote them may well be gone. No agent
 * is asked and none has to be up.
 *
 * The snapshots are monotonic totals per node, so the window is a subtraction —
 * see `src/cli/_metrics.ts` for what that means for a window shorter than the
 * flush interval, and for what happens across a node restart.
 */

import { type ArgsDef, type CommandDef, defineCommand } from "citty";
import { loadAgentConfig } from "../../agent/config.ts";
import { counterRecords } from "../../agent/observe-records.ts";
import type { RegistryContext } from "../../core/registry/context.ts";
import { createRegistry } from "../_bootstrap.ts";
import { formatMetrics, noCounters, summarizeMetrics } from "../_metrics.ts";
import { nothingRecorded, readObservations, windowFrom } from "../_observe-read.ts";
import { readTextFile, reportFailure } from "../_utils.ts";

/* The bucket the registry lives in, exactly as `scafo up` takes it. */
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
  project: { type: "string", description: "Only this project" },
  env: { type: "string", description: "Only this environment" },
  since: {
    type: "string",
    description: "How far back to read: a duration (90s, 15m, 1h, 7d) or an ISO-8601 instant (1h)",
  },
  json: { type: "boolean", description: "Print the summary as JSON instead of a table" },
};

export const metrics: CommandDef = defineCommand({
  meta: { name: "metrics", description: "What the fleet served, per project and environment" },
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
  const summary = summarizeMetrics(found.records, window, {
    ...(text(flags.project) === undefined ? {} : { project: text(flags.project) as string }),
    ...(text(flags.env) === undefined ? {} : { env: text(flags.env) as string }),
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
    console.log(`scafo: ${String(found.malformed)} line(s) were not records and were skipped`);
  }
  if (found.unreadable.length > 0) {
    console.log(
      `scafo: ${String(found.unreadable.length)} file(s) are in an encoding this build does not ` +
        `read; upgrade the CLI to see them`,
    );
  }
}

async function registryFor(flags: Record<string, unknown>): Promise<RegistryContext> {
  const config = await loadAgentConfig({
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
