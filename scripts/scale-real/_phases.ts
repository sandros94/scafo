/*
 * The six phases one cell is measured through, in the order a real installation
 * lives them: boot, first deploys, convergence, idle, a burst, and two restarts.
 *
 * EVERY WAIT HAS A DEADLINE. A phase that misses one is recorded as "did not
 * converge" and the run moves on to the next phase, because a benchmark that
 * ends in a stack trace tells an operator nothing about the cells it never got
 * to. Only a defect in this script itself ends a cell early.
 */

import { rm } from "node:fs/promises";
import { engine, sampleStats, type ContainerEngine } from "./_engine.ts";
import {
  celldProcessesOn,
  containerHealth,
  DeadlineMissed,
  httpSend,
  portsOn,
  refreshApiPort,
  proxyCounters,
  runCli,
  servedOn,
  stageApp,
  stateOf,
  storeMetrics,
  until,
  type Installation,
  type NodeHandle,
} from "./_installation.ts";

/** Names of the phases, in the order they are measured. */
export const PHASES: string[] = [
  "boot",
  "first-deploys",
  "convergence",
  "idle",
  "burst",
  "restart",
];

const BOOT_DEADLINE_MS = 180_000;
const DEPLOY_TIMEOUT_MS = 600_000;
const CONVERGE_DEADLINE_MS = 240_000;
const BURST_DEADLINE_MS = 900_000;
const RESTART_DEADLINE_MS = 300_000;
/** Stop grace: the daemon needs at least fifty seconds to drain. */
const STOP_GRACE_S = 60;
/** How often every node container is sampled for CPU and memory. */
const SAMPLE_INTERVAL_MS = 2000;

/** What one node container cost during one phase. */
export interface PhaseResources {
  samples: number;
  peakMemoryBytes: number;
  meanCpuPercent: number;
  peakCpuPercent: number;
}

export interface DeployFailure {
  application: string;
  code: string;
  tail: string;
}

export interface RestartOutcome {
  node: string;
  how: string;
  seconds: number | null;
  note?: string;
  /** Applications whose public port was not the one they held before. */
  moved: Array<{ application: string; before: number; after: number }>;
}

/** Everything one profile×latency cell observed. */
export interface CellMeasurement {
  profile: string;
  latencyMs: number;
  nodes: number;
  applications: number;
  boot: { seconds: number | null; note?: string };
  deploys: {
    count: number;
    p50Ms: number | null;
    maxMs: number | null;
    failures: DeployFailure[];
  };
  convergence: { seconds: number | null; note?: string };
  idle: {
    seconds: number;
    requestsPerMinute: Record<string, number>;
    perMinuteByMethod: Record<string, number>;
    perMinuteByKeyspace: Record<string, number>;
    unparsedRequests: number;
    storeMetricsDelta: Record<string, number>;
    storeMetricsAvailable: boolean;
    celld: Array<{ node: string; processes: number; rssBytes: number }>;
  };
  burst: {
    deploys: number;
    succeeded: number;
    failed: DeployFailure[];
    wallMs: number;
    maxSingleMs: number;
    servedSeconds: number | null;
    note?: string;
  };
  restart: RestartOutcome[];
  resources: Record<string, Record<string, PhaseResources>>;
  /** What the engine said about each node container at the end of each phase. */
  containersByPhase: Record<string, ContainerReading[]>;
  /** The last reading, which is what the report's table shows. */
  containers: ContainerReading[];
  findings: string[];
}

export interface ContainerReading {
  node: string;
  oomKilled: boolean;
  restarts: number;
  running: boolean;
}

export interface MeasureOptions {
  applications: number;
  idleSeconds: number;
  progress: (line: string) => void;
}

/** Drives one installation through every phase and returns what it observed. */
export async function measureCell(
  installation: Installation,
  opts: MeasureOptions,
): Promise<CellMeasurement> {
  const { progress } = opts;
  const findings: string[] = [];
  const staged: string[] = [];
  const sampler = startSampler(
    installation.settings.container,
    installation.nodes.map((node) => node.name),
  );

  const names = Array.from(
    { length: opts.applications },
    (_, index) => `scale-app-${String(index + 1)}`,
  );

  /* Read at the end of every phase rather than once at the end: a container the
     engine killed and restarted between two phases is a fact about the phase it
     happened in, and a single final reading loses which one that was. */
  const containersByPhase: Record<string, ContainerReading[]> = {};
  const readContainers = async (phaseName: string): Promise<ContainerReading[]> => {
    const seen = await Promise.all(
      installation.nodes.map(async (node) => ({
        node: node.id,
        ...(await containerHealth(installation, node)),
      })),
    );
    containersByPhase[phaseName] = seen;
    return seen;
  };

  try {
    /* ------------------------------------------------------------ 1. boot */
    sampler.phase("boot");
    progress("waiting for every node to be healthy and a coordinator to be elected");
    const boot = await phase(async () => {
      await until("every node to answer health", BOOT_DEADLINE_MS, async () => {
        for (const node of installation.nodes) {
          const answer = await fetchHealth(node);
          if (answer !== 200) return null;
        }
        return true;
      });
      await until("one node to hold the coordinator lease", BOOT_DEADLINE_MS, async () => {
        const seen = await Promise.all(
          installation.nodes.map(async (node) => stateOf(installation, node)),
        );
        return seen.filter((state) => state.coordinator?.self === true).length === 1 ? true : null;
      });
      return (Date.now() - installation.nodesStartedAt) / 1000;
    });
    if (boot.note !== undefined) findings.push(`boot did not converge: ${boot.note}`);
    await readContainers("boot");

    /* --------------------------------------------------- 2. first deploys */
    sampler.phase("first-deploys");
    progress(`deploying ${String(opts.applications)} applications, one after another`);
    const v1 = await stageApp(installation.settings.repoRoot, "v1");
    staged.push(v1);

    const durations: number[] = [];
    const failures: DeployFailure[] = [];
    let lastAcknowledgedAt = Date.now();
    for (const application of names) {
      const started = Date.now();
      const result = await deployOnce(installation, v1, application);
      const took = Date.now() - started;
      lastAcknowledgedAt = Date.now();
      if (result.code === 0) durations.push(took);
      else failures.push(failureOf(application, result.output));
      progress(`  ${application}: ${result.code === 0 ? "deployed" : "FAILED"} in ${ms(took)}`);
    }
    for (const failure of failures) {
      findings.push(`deploy of ${failure.application} failed with \`${failure.code}\``);
    }
    await readContainers("first-deploys");

    /* ---------------------------------------------------- 3. convergence */
    sampler.phase("convergence");
    progress("waiting until every node serves every application");
    const converged = await phase(async () => {
      await untilAllServe(installation, names, "v1", CONVERGE_DEADLINE_MS);
      return (Date.now() - lastAcknowledgedAt) / 1000;
    });
    if (converged.note !== undefined) {
      findings.push(`convergence did not converge: ${converged.note}`);
    }
    await readContainers("convergence");

    /* ----------------------------------------------------------- 4. idle */
    sampler.phase("idle");
    progress(`holding still for ${String(opts.idleSeconds)}s`);
    const idle = await measureIdle(installation, opts.idleSeconds);
    await readContainers("idle");

    /* ---------------------------------------------------------- 5. burst */
    sampler.phase("burst");
    progress("deploying a new version of every application at once");
    const v2 = await stageApp(installation.settings.repoRoot, "v2");
    staged.push(v2);
    const burst = await measureBurst(installation, names, v2);
    for (const failure of burst.failed) {
      findings.push(`burst deploy of ${failure.application} failed with \`${failure.code}\``);
    }
    if (burst.note !== undefined) findings.push(`the burst did not converge: ${burst.note}`);
    await readContainers("burst");

    /* -------------------------------------------------------- 6. restart */
    sampler.phase("restart");
    const restart: RestartOutcome[] = [];
    const subject = installation.nodes[0] as NodeHandle;
    for (const how of ["SIGTERM (engine restart)", "SIGKILL then start"]) {
      progress(`restarting ${subject.id} with ${how}`);
      restart.push(await measureRestart(installation, subject, names, how));
    }
    for (const outcome of restart) {
      if (outcome.note !== undefined) {
        findings.push(`${outcome.node} did not come back after ${outcome.how}: ${outcome.note}`);
      }
      for (const moved of outcome.moved) {
        findings.push(
          `${moved.application} moved from port ${String(moved.before)} to ` +
            `${String(moved.after)} on ${outcome.node} across ${outcome.how}`,
        );
      }
    }

    const containers = await readContainers("restart");
    for (const container of containers) {
      if (container.oomKilled) findings.push(`${container.node} was OOM-killed`);
      if (container.restarts > 0) {
        findings.push(
          `${container.node} was restarted ${String(container.restarts)}× by the engine`,
        );
      }
    }
    if (idle.unparsedRequests > 0) {
      findings.push(
        `${String(idle.unparsedRequests)} store connections carried framing the proxy could not follow, ` +
          `so their requests are not in the idle counts`,
      );
    }

    return {
      profile: installation.settings.profile.name,
      latencyMs: installation.settings.latencyMs,
      nodes: installation.nodes.length,
      applications: opts.applications,
      boot: { seconds: boot.value, ...(boot.note === undefined ? {} : { note: boot.note }) },
      deploys: {
        count: names.length,
        p50Ms: percentile(durations, 0.5),
        maxMs: durations.length === 0 ? null : Math.max(...durations),
        failures,
      },
      convergence: {
        seconds: converged.value,
        ...(converged.note === undefined ? {} : { note: converged.note }),
      },
      idle,
      burst,
      restart,
      resources: sampler.summary(),
      containersByPhase,
      containers,
      findings,
    };
  } finally {
    sampler.stop();
    for (const dir of staged) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------------------------------- the phases */

/** Runs one measurement, turning a missed deadline into a note rather than a throw. */
async function phase<T>(work: () => Promise<T>): Promise<{ value: T | null; note?: string }> {
  try {
    return { value: await work() };
  } catch (error) {
    if (error instanceof DeadlineMissed) return { value: null, note: error.message };
    throw error;
  }
}

async function measureIdle(
  installation: Installation,
  seconds: number,
): Promise<CellMeasurement["idle"]> {
  const before = await proxyCounters(installation);
  const storeBefore = await storeMetrics(installation);
  const startedAt = Date.now();

  await new Promise((settle) => setTimeout(settle, seconds * 1000));

  const after = await proxyCounters(installation);
  const storeAfter = await storeMetrics(installation);
  const minutes = (Date.now() - startedAt) / 60_000;

  const requestsPerMinute: Record<string, number> = {};
  const perMinuteByMethod: Record<string, number> = {};
  const perMinuteByKeyspace: Record<string, number> = {};
  for (const [key, count] of Object.entries(after.requests)) {
    const delta = count - (before.requests[key] ?? 0);
    if (delta === 0) continue;
    const rate = delta / minutes;
    requestsPerMinute[key] = round(rate);
    const [method = key, keyspace = "other"] = key.split(" ");
    perMinuteByMethod[method] = round((perMinuteByMethod[method] ?? 0) + rate);
    perMinuteByKeyspace[keyspace] = round((perMinuteByKeyspace[keyspace] ?? 0) + rate);
  }

  /* The store's own request counters, per minute. A Prometheus histogram
     publishes one series per bucket and a sum beside them; the counter of
     observations is the only one of the family that says how many requests
     there were, so the rest are left out rather than filling the report. */
  const storeMetricsDelta: Record<string, number> = {};
  for (const [name, value] of storeAfter) {
    if (!name.includes("request") || name.includes("_bucket{") || name.includes("_sum{")) continue;
    const delta = value - (storeBefore.get(name) ?? 0);
    if (delta > 0) storeMetricsDelta[name] = round(delta / minutes);
  }

  const celld = await Promise.all(
    installation.nodes.map(async (node) => {
      const processes = await celldProcessesOn(installation, node);
      return {
        node: node.id,
        processes: processes.length,
        rssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
      };
    }),
  );

  return {
    seconds: round((Date.now() - startedAt) / 1000),
    requestsPerMinute,
    perMinuteByMethod,
    perMinuteByKeyspace,
    unparsedRequests: after.unparsed - before.unparsed,
    storeMetricsDelta,
    storeMetricsAvailable: storeAfter.size > 0,
    celld,
  };
}

async function measureBurst(
  installation: Installation,
  names: string[],
  directory: string,
): Promise<CellMeasurement["burst"]> {
  const startedAt = Date.now();
  const results = await Promise.all(
    names.map(async (application) => {
      const began = Date.now();
      const result = await deployOnce(installation, directory, application);
      return { application, result, ms: Date.now() - began };
    }),
  );
  const wallMs = Date.now() - startedAt;
  const failed = results
    .filter((entry) => entry.result.code !== 0)
    .map((entry) => failureOf(entry.application, entry.result.output));

  const served = await phase(async () => {
    await untilAllServe(installation, names, "v2", BURST_DEADLINE_MS);
    return (Date.now() - startedAt - wallMs) / 1000;
  });

  return {
    deploys: names.length,
    succeeded: results.length - failed.length,
    failed,
    wallMs,
    maxSingleMs: Math.max(0, ...results.map((entry) => entry.ms)),
    servedSeconds: served.value,
    ...(served.note === undefined ? {} : { note: served.note }),
  };
}

async function measureRestart(
  installation: Installation,
  node: NodeHandle,
  names: string[],
  how: string,
): Promise<RestartOutcome> {
  const container = installation.settings.container;
  const noPorts = (): Map<string, { port: number; internalPort: number }> => new Map();
  const before = await portsOn(installation, node).catch(noPorts);

  const startedAt = Date.now();
  if (how.startsWith("SIGTERM")) {
    await engine(container, ["restart", "-t", String(STOP_GRACE_S), node.name], {
      timeoutMs: (STOP_GRACE_S + 120) * 1000,
    });
  } else {
    await engine(container, ["kill", node.name]);
    await engine(container, ["start", node.name]);
  }
  await refreshApiPort(installation, node);

  const back = await phase(async () => {
    await until(`${node.id} to answer health again`, RESTART_DEADLINE_MS, async () =>
      (await fetchHealth(node)) === 200 ? true : null,
    );
    await until(`${node.id} to serve every application again`, RESTART_DEADLINE_MS, async () => {
      const answers = await serveState(installation, node, names);
      return answers.every((answer) => answer.status === 200) ? true : null;
    });
    return (Date.now() - startedAt) / 1000;
  });

  const moved: RestartOutcome["moved"] = [];
  const after = await portsOn(installation, node).catch(noPorts);
  for (const [application, pair] of before) {
    const now = after.get(application);
    if (now !== undefined && now.port !== pair.port) {
      moved.push({ application, before: pair.port, after: now.port });
    }
  }

  return {
    node: node.id,
    how,
    seconds: back.value,
    ...(back.note === undefined ? {} : { note: back.note }),
    moved,
  };
}

/* ------------------------------------------------------------- the probes */

async function fetchHealth(node: NodeHandle): Promise<number> {
  const answer = await httpSend(node.apiPort, "/.well-known/scafo/health", "GET", {}).catch(() => ({
    status: 0,
    body: "",
  }));
  return answer.status;
}

/** Every application's answer on one node, asked at the ports that node reports. */
async function serveState(
  installation: Installation,
  node: NodeHandle,
  names: string[],
): Promise<Array<{ application: string; status: number; body: string }>> {
  const ports = await portsOn(installation, node);
  const targets = names
    .map((application) => ({ application, port: ports.get(application)?.port }))
    .filter((target): target is { application: string; port: number } => target.port !== undefined);
  const answers = await servedOn(installation, node, targets);
  const missing = names
    .filter((application) => !ports.has(application))
    .map((application) => ({ application, status: 0, body: "this node runs no process for it" }));
  return [...answers, ...missing];
}

/** Waits until every node answers 200 with `version` for every application. */
async function untilAllServe(
  installation: Installation,
  names: string[],
  version: string,
  deadlineMs: number,
): Promise<void> {
  await until(`every node to serve ${version} for every application`, deadlineMs, async () => {
    for (const node of installation.nodes) {
      const answers = await serveState(installation, node, names);
      if (answers.length !== names.length) return null;
      for (const answer of answers) {
        if (answer.status !== 200 || !answer.body.includes(`"${version}"`)) return null;
      }
    }
    return true;
  });
}

/** One deploy of `directory`, through the first node, as an operator would run it. */
function deployOnce(
  installation: Installation,
  directory: string,
  application: string,
): ReturnType<typeof runCli> {
  const node = installation.nodes[0] as NodeHandle;
  return runCli(
    [
      "deploy",
      directory,
      "--node",
      `http://127.0.0.1:${String(node.apiPort)}`,
      "--name",
      application,
      "--key",
      installation.keyPath,
      "--replicas",
      "all",
    ],
    installation.settings.repoRoot,
    {},
    DEPLOY_TIMEOUT_MS,
  );
}

/**
 * The error code a failed deploy ended with.
 *
 * READ OFF THE CLI'S OUTPUT, because that is what an operator sees: the codes
 * are a closed set, so the output is searched for one rather than parsed. A
 * failure carrying none is reported as `unnamed` with its tail attached.
 */
const ERROR_CODES =
  /\b(auth-invalid|trust-mismatch|invalid-input|invalid-slug|not-found|cas-conflict|store-unavailable|store-nonconforming|version-skew|deploys-frozen|deploy-overloaded|deploy-timeout|publish-failed|placement-unavailable|capability-missing|application-blocked|draining|internal)\b/;

function failureOf(application: string, output: string): DeployFailure {
  return {
    application,
    code: ERROR_CODES.exec(output)?.[1] ?? "unnamed",
    tail: output.trim().split("\n").slice(-4).join(" / ").slice(0, 400),
  };
}

/* ------------------------------------------------------------ the sampler */

interface Sampler {
  phase(name: string): void;
  stop(): void;
  summary(): Record<string, Record<string, PhaseResources>>;
}

/**
 * Samples every node container every two seconds and attributes each sample to
 * the phase that was running when it was taken.
 */
function startSampler(container: ContainerEngine, names: string[]): Sampler {
  const tallies = new Map<string, Map<string, { cpu: number[]; peakMemory: number }>>();
  let current = "boot";
  let sampling = false;

  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void sampleStats(container, names)
      .then((samples) => {
        const phaseTally = tallies.get(current) ?? new Map();
        tallies.set(current, phaseTally);
        for (const [name, sample] of samples) {
          const tally = phaseTally.get(name) ?? { cpu: [], peakMemory: 0 };
          tally.cpu.push(sample.cpuPercent);
          tally.peakMemory = Math.max(tally.peakMemory, sample.memoryBytes);
          phaseTally.set(name, tally);
        }
      })
      .catch(() => {})
      .finally(() => (sampling = false));
  }, SAMPLE_INTERVAL_MS);
  timer.unref();

  return {
    phase(name: string): void {
      current = name;
    },
    stop(): void {
      clearInterval(timer);
    },
    summary(): Record<string, Record<string, PhaseResources>> {
      const out: Record<string, Record<string, PhaseResources>> = {};
      for (const [phaseName, phaseTally] of tallies) {
        const byNode: Record<string, PhaseResources> = {};
        for (const [name, tally] of phaseTally) {
          const mean =
            tally.cpu.length === 0
              ? 0
              : tally.cpu.reduce((total, value) => total + value, 0) / tally.cpu.length;
          byNode[name] = {
            samples: tally.cpu.length,
            peakMemoryBytes: tally.peakMemory,
            meanCpuPercent: round(mean),
            peakCpuPercent: round(Math.max(0, ...tally.cpu)),
          };
        }
        out[phaseName] = byNode;
      }
      return out;
    },
  };
}

/* ----------------------------------------------------------------- numbers */

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[at] as number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function ms(value: number): string {
  return value < 1000 ? `${String(Math.round(value))}ms` : `${(value / 1000).toFixed(1)}s`;
}
