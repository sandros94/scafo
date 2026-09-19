/*
 * `pnpm scale:real` — an on-demand benchmark on real containers.
 *
 * AN EXPLORATION TOOL, NEVER A TEST. CI does not run it, vitest does not collect
 * it, it asserts no budget, and its only output is a markdown report a human
 * reads. It exists so a default is never chosen from one big development
 * machine: one run sweeps several emulated machine sizes and store latencies,
 * and a default is worth having only if it holds on the SLOWEST cell.
 *
 * Each cell is a fresh installation — its own network, store, bucket and nodes —
 * driven through boot, first deploys, convergence, idle, a burst and two
 * restarts. Everything it creates carries a label, and everything carrying that
 * label is removed at the end, on a failure, and on Ctrl-C alike.
 *
 * Run it with `pnpm scale:real`; `--help` prints the flags.
 */

import { writeFile } from "node:fs/promises";
import { availableParallelism, release, totalmem, type } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { secureRandomBytes } from "unsecure/random";
import {
  chooseEngine,
  describe,
  engine,
  engineOk,
  run,
  RUN_LABEL,
  type ContainerEngine,
} from "./scale-real/_engine.ts";
import {
  CELL_LABEL,
  removeLabelled,
  startInstallation,
  type Installation,
  type Profile,
} from "./scale-real/_installation.ts";
import { measureCell, type CellMeasurement } from "./scale-real/_phases.ts";
import { renderReport, type ReportHeader } from "./scale-real/_report.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
/** The node image the container suites use, built from the Dockerfile's `probe` target. */
const NODE_IMAGE = "scafo-probe";
/** The store, at the tag the integration harness pins. */
/* Fully qualified: Podman resolves no short name unless the machine configures it. */
const STORE_IMAGE = "docker.io/chrislusf/seaweedfs:4.42";

const HELP = `
pnpm scale:real — benchmark a real scafo installation on containers

  --profiles 1x2,2x4,4x8   machine sizes per NODE container, cpus x GB (default 2x4)
  --latency 0,100          added store latency in ms (default 0)
  --apps 10                applications deployed per cell (default 10)
  --nodes 2                node containers per cell (default 2)
  --idle-seconds 120       length of the idle window (default 120)
  --out <file>             where the report is written (default ./scale-real-<timestamp>.md)
  --engine docker|podman   container engine (default: the first one on PATH)
  --build                  rebuild the ${NODE_IMAGE} image even when it is present
  --reuse-dist             run the dist/ that is already there instead of building it
                           (a machine without pnpm, given a tree built elsewhere)
  --keep                   leave the containers, networks and volumes behind
  --help

The sweep is profiles × latencies, one fresh installation per cell, run one
after another. Nothing here is a test and nothing asserts a budget: a default
is only worth having if it holds on the slowest cell of the sweep.
`;

interface Flags {
  profiles: Profile[];
  latencies: number[];
  applications: number;
  nodes: number;
  idleSeconds: number;
  out: string;
  engine?: string;
  build: boolean;
  reuseDist: boolean;
  keep: boolean;
  raw: string;
}

await main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP.trim());
    return;
  }
  let flags: Flags;
  try {
    flags = parseFlags(argv);
  } catch (error) {
    /* A mistyped flag is the caller's to read, not a stack trace. */
    console.error(`scale:real: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const runId = hex(4);
  const container = await chooseEngine(flags.engine);
  progress(`engine ${container.bin} ${container.version}, run ${runId}`);

  let stopping = false;
  const onSignal = (): void => {
    if (stopping) process.exit(130);
    stopping = true;
    progress("interrupted; removing what this run created");
    void removeLabelled(container, `${RUN_LABEL}=${runId}`).finally(() => process.exit(130));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const startedAt = new Date().toISOString();
  const cells: CellMeasurement[] = [];
  const aborted: Array<{ cell: string; error: string }> = [];

  try {
    await buildOnce(container, flags);

    let index = 0;
    for (const profile of flags.profiles) {
      for (const latencyMs of flags.latencies) {
        const label = `${profile.name} @ ${String(latencyMs)}ms`;
        progress(`--- cell ${label} ---`);
        const cellLabel = `${CELL_LABEL}=${runId}-${String(index)}`;
        let installation: Installation | undefined;
        let failed = false;
        try {
          installation = await startInstallation(
            {
              container,
              runId,
              cell: index,
              profile,
              latencyMs,
              nodes: flags.nodes,
              repoRoot: REPO_ROOT,
              image: NODE_IMAGE,
              storeImage: STORE_IMAGE,
            },
            (line) => progress(`  ${line}`),
          );
          cells.push(
            await measureCell(installation, {
              applications: flags.applications,
              idleSeconds: flags.idleSeconds,
              progress: (line) => progress(`  ${line}`),
            }),
          );
        } catch (error) {
          failed = true;
          progress(`  cell ${label} ended early: ${describe(error)}`);
          aborted.push({ cell: label, error: describe(error) });
          /* The report is still written; the status says it is not a whole one. */
          process.exitCode = 1;
        } finally {
          index += 1;
          await logsOnFailure(container, installation, failed);
          if (!flags.keep) {
            await removeLabelled(container, cellLabel).catch(() => ({}));
          }
        }
      }
    }

    const header = await reportHeader(container, flags, runId, startedAt);
    const report = renderReport(header, cells, aborted);
    await writeFile(flags.out, `${report}\n`);
    console.log(report);
    progress(`report written to ${flags.out}`);
  } finally {
    if (flags.keep) {
      progress(`--keep: everything labelled ${RUN_LABEL}=${runId} was left running`);
    } else {
      const removed = await removeLabelled(container, `${RUN_LABEL}=${runId}`);
      progress(
        `removed ${String(removed.containers)} containers, ${String(removed.networks)} networks, ` +
          `${String(removed.volumes)} volumes`,
      );
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * Builds `dist/` once and the node image when it is missing.
 *
 * The same order the container suites use: the worktree is bind-mounted into
 * every node container read-only, so what they run is what is built here, once,
 * before anything starts.
 */
async function buildOnce(container: ContainerEngine, flags: Flags): Promise<void> {
  if (flags.reuseDist) {
    progress("reusing the dist/ that is already there");
  } else {
    progress("building dist/");
    const built = await run("pnpm", ["build"], { cwd: REPO_ROOT, timeoutMs: 600_000 });
    if (built.code !== 0) throw new Error(`"pnpm build" failed:\n${built.output}`);
  }

  const present = await engine(container, ["image", "inspect", NODE_IMAGE]);
  if (present.code === 0 && !flags.build) return;

  progress(`building the ${NODE_IMAGE} image`);
  const image = await engine(
    container,
    ["build", "--target", "probe", "-t", NODE_IMAGE, REPO_ROOT],
    { timeoutMs: 1_800_000 },
  );
  if (image.code !== 0) throw new Error(`building ${NODE_IMAGE} failed:\n${image.output}`);
}

/** The tail of each node's log, printed when a cell ended early. */
async function logsOnFailure(
  container: ContainerEngine,
  installation: Installation | undefined,
  failed: boolean,
): Promise<void> {
  if (!failed || installation === undefined) return;
  for (const node of installation.nodes) {
    const logs = await engine(container, ["logs", "--tail", "40", node.name]).catch(() => null);
    if (logs !== null) progress(`  ${node.id} log tail:\n${logs.output.trim()}`);
  }
}

async function reportHeader(
  container: ContainerEngine,
  flags: Flags,
  runId: string,
  startedAt: string,
): Promise<ReportHeader> {
  const git = async (args: string[]): Promise<string> =>
    (await run("git", args, { cwd: REPO_ROOT })).stdout.trim();

  return {
    commit: await git(["rev-parse", "--short", "HEAD"]),
    dirty: (await git(["status", "--porcelain"])) !== "",
    engine: container.bin,
    engineVersion: container.version,
    host: {
      cpus: availableParallelism(),
      memoryBytes: totalmem(),
      kernel: release(),
      platform: type(),
    },
    image: NODE_IMAGE,
    imageDigest: await engineOk(container, ["image", "inspect", "-f", "{{.Id}}", NODE_IMAGE]).catch(
      () => "unknown",
    ),
    storeImage: STORE_IMAGE,
    flags: flags.raw,
    startedAt,
    finishedAt: new Date().toISOString(),
    runId,
  };
}

/* ------------------------------------------------------------------- flags */

function parseFlags(argv: string[]): Flags {
  const KNOWN_FLAGS: ReadonlySet<string> = new Set([
    "--profiles",
    "--latency",
    "--apps",
    "--nodes",
    "--idle-seconds",
    "--out",
    "--engine",
    "--build",
    "--reuse-dist",
    "--keep",
    "--help",
  ]);
  const named = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] as string;
    /* A flag nobody reads is a typo about to cost a twenty-minute sweep. */
    if (!KNOWN_FLAGS.has(flag)) throw new Error(`unknown argument "${flag}" (see --help)`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) bare.add(flag);
    else {
      named.set(flag, next);
      i += 1;
    }
  }

  const number = (flag: string, fallback: number): number => {
    const text = named.get(flag);
    if (text === undefined) return fallback;
    const value = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${flag} wants a positive integer`);
    return value;
  };

  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  return {
    profiles: (named.get("--profiles") ?? "2x4")
      .split(",")
      .map((text) => parseProfile(text.trim())),
    latencies: (named.get("--latency") ?? "0").split(",").map((text) => {
      const value = Number.parseInt(text.trim(), 10);
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`--latency wants milliseconds`);
      return value;
    }),
    applications: number("--apps", 10),
    nodes: number("--nodes", 2),
    idleSeconds: number("--idle-seconds", 120),
    out: named.get("--out") ?? resolve(process.cwd(), `scale-real-${stamp}.md`),
    ...(named.has("--engine") ? { engine: named.get("--engine") as string } : {}),
    build: bare.has("--build"),
    reuseDist: bare.has("--reuse-dist"),
    keep: bare.has("--keep"),
    raw: argv.join(" ") || "(defaults)",
  };
}

/** `2x4` — two cpus and four gigabytes, per NODE container. */
function parseProfile(text: string): Profile {
  const parsed = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(text);
  if (parsed === null) throw new Error(`"${text}" is not a profile; they look like "2x4"`);
  return {
    name: text,
    cpus: Number.parseFloat(parsed[1] as string),
    memoryGb: Number.parseFloat(parsed[2] as string),
  };
}

function hex(bytes: number): string {
  let text = "";
  for (const byte of secureRandomBytes(bytes)) text += byte.toString(16).padStart(2, "0");
  return text;
}

function progress(line: string): void {
  console.error(`scale:real: ${line}`);
}
