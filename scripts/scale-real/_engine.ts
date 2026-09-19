/*
 * The container engine, driven through its own CLI.
 *
 * NOT testcontainers: this benchmark has to run against rootless Podman exactly
 * as it runs against Docker, and the one interface both of them really share is
 * the command line. Every helper here is a thin wrapper over one invocation, so
 * what the benchmark does to a machine is always readable as a command.
 */

import { spawn } from "node:child_process";
import { safeJsonParse } from "unsecure/sanitize";

/** The label every container, network and volume of a run carries. */
export const RUN_LABEL: string = "scafo-scale-real";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams, in the order they arrived; what a failure is reported with. */
  output: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Bounds one command so a wedged engine is a reported failure, never a hang. */
  timeoutMs?: number;
}

/** Runs one command to completion, never throwing on a non-zero exit. */
export function run(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((settle, fail) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? (process.env as Record<string, string>),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      settle(result);
    };
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({
          code: -1,
          stdout,
          stderr,
          output: `${output}\ncommand timed out after ${String(opts.timeoutMs)}ms`,
        });
      }, opts.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      output += chunk;
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fail(error);
    });
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr, output }));
  });
}

/** One container engine: the binary to call and the version it reported. */
export interface ContainerEngine {
  bin: string;
  version: string;
}

/**
 * The engine a run drives: the one asked for, or the first of docker and podman
 * that answers `version`.
 */
export async function chooseEngine(asked?: string): Promise<ContainerEngine> {
  const candidates = asked === undefined ? ["docker", "podman"] : [asked];
  const refusals: string[] = [];

  for (const bin of candidates) {
    try {
      const version = await run(bin, ["version", "--format", "{{.Server.Version}}"], {
        timeoutMs: 30_000,
      });
      if (version.code === 0 && version.stdout.trim() !== "") {
        return { bin, version: version.stdout.trim() };
      }
      refusals.push(`${bin}: ${version.output.trim().slice(0, 200)}`);
    } catch (error) {
      refusals.push(`${bin}: ${describe(error)}`);
    }
  }
  throw new Error(`no container engine answered (${refusals.join("; ")})`);
}

/** One engine command, bounded, with its failure carrying what the engine said. */
export async function engine(
  container: ContainerEngine,
  args: string[],
  opts: RunOptions = {},
): Promise<CommandResult> {
  return run(container.bin, args, { timeoutMs: 180_000, ...opts });
}

/** One engine command that must succeed; its output, trimmed. */
export async function engineOk(
  container: ContainerEngine,
  args: string[],
  opts: RunOptions = {},
): Promise<string> {
  const result = await engine(container, args, opts);
  if (result.code !== 0) {
    throw new Error(`${container.bin} ${args.join(" ")} failed:\n${result.output.trim()}`);
  }
  return result.stdout.trim();
}

/** One container's resource sample, as `stats --no-stream` reports it. */
export interface StatsSample {
  cpuPercent: number;
  memoryBytes: number;
}

/**
 * Samples every named container once.
 *
 * Containers that have gone away are simply missing from the answer: a phase
 * that restarts a node samples across the gap, and a sample nobody took is not a
 * zero.
 */
export async function sampleStats(
  container: ContainerEngine,
  names: string[],
): Promise<Map<string, StatsSample>> {
  const samples = new Map<string, StatsSample>();
  if (names.length === 0) return samples;

  const result = await engine(
    container,
    ["stats", "--no-stream", "--format", "{{json .}}", ...names],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) return samples;

  for (const line of result.stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    /* Docker answers text (`CPUPerc: "1.5%"`, `MemUsage: "12MiB / 4GiB"`), Podman
       numbers (`CPU: 1.5`, `MemUsage: 12582912`). */
    let row: { Name?: unknown; CPUPerc?: unknown; CPU?: unknown; MemUsage?: unknown };
    try {
      row = safeJsonParse(text);
    } catch {
      continue;
    }
    const name = typeof row.Name === "string" ? row.Name : "";
    if (!names.includes(name)) continue;
    const cpuPercent = percent(row.CPUPerc ?? row.CPU);
    const memoryBytes = memoryUsed(row.MemUsage);
    /* A row this cannot read is a sample nobody took, not a machine at rest. */
    if (cpuPercent === null || memoryBytes === null) continue;
    samples.set(name, { cpuPercent, memoryBytes });
  }
  return samples;
}

function percent(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** The used half of a `123.4MiB / 4GiB` pair, in bytes. */
function memoryUsed(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  return toBytes(value.split("/")[0]?.trim() ?? "");
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

function toBytes(text: string): number | null {
  const parsed = /^([\d.]+)\s*([a-zA-Z]+)$/.exec(text);
  if (parsed === null) return null;
  const amount = Number.parseFloat(parsed[1] as string);
  const unit = UNITS[(parsed[2] as string).toLowerCase()];
  return Number.isFinite(amount) && unit !== undefined ? Math.round(amount * unit) : null;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

export function delay(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}
