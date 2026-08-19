/* Capacity planning formulas. Pure: every input is supplied by the caller. */

import { ScaloError } from "../error.ts";
import { parseCpuMax, parseMemoryMax } from "./cgroup.ts";

/** Everything the plan is derived from: raw cgroup files plus host totals. */
export interface CapacityInputs {
  /** Raw file contents; `null` when the file is absent or unreadable. */
  cgroup: { memoryMax: string | null; cpuMax: string | null };
  host: { cores: number; memBytes: number };
}

/** Tunables of the capacity formulas. Every field has a sensible default. */
export interface CapacityOverrides {
  /** Share of memory the runtime may hold resident. Default `0.7`. */
  rssFraction?: number;
  /** Memory reserved for the agent itself, in MiB. Default `128`. */
  agentOverheadMb?: number;
  /** Runtime processes the budget is split across. Default `1`. */
  plannedProcesses?: number;
  /** Resident cells granted per 8 GiB of memory. Default `1000`. */
  residentCellsPer8Gb?: number;
}

/** What a node advertises about itself after probing its own hardware. */
export interface CapacityPlan {
  cores: number;
  memMb: number;
  /** True when a cgroup limit was lower than the host value and took effect. */
  cgroup: boolean;
  threads: number;
  isolates: number;
  rssBudgetMb: number;
  maxRssMbPerProcess: number;
  maxResidentCells: number;
  probedAt: string;
}

const MIB = 1024 * 1024;

/**
 * Derives a node's capacity plan. cgroup v2 limits win over host values wherever
 * they are present and lower, so a containerized node never advertises the
 * hardware of its host.
 *
 * Throws `ScaloError("invalid-input")` on non-positive host values or overrides:
 * a plan computed from a degenerate probe would be silently wrong.
 */
export function computeCapacity(
  inputs: CapacityInputs,
  opts?: CapacityOverrides & { now?: () => Date },
): CapacityPlan {
  const hostCores = positive(inputs.host.cores, "host.cores");
  const hostMemBytes = positive(inputs.host.memBytes, "host.memBytes");

  const rssFraction = fraction(opts?.rssFraction ?? 0.7, "rssFraction");
  const agentOverheadMb = nonNegative(opts?.agentOverheadMb ?? 128, "agentOverheadMb");
  const plannedProcesses = positive(opts?.plannedProcesses ?? 1, "plannedProcesses");
  const residentCellsPer8Gb = positive(opts?.residentCellsPer8Gb ?? 1000, "residentCellsPer8Gb");

  const cgroupMemBytes = parseMemoryMax(inputs.cgroup.memoryMax);
  const cgroupCpus = parseCpuMax(inputs.cgroup.cpuMax);

  const memLimited = cgroupMemBytes !== null && cgroupMemBytes < hostMemBytes;
  const cpuLimited = cgroupCpus !== null && cgroupCpus < hostCores;

  const memMb = Math.floor((memLimited ? cgroupMemBytes : hostMemBytes) / MIB);
  const cores = cpuLimited ? Math.max(1, Math.ceil(cgroupCpus)) : hostCores;

  const rssBudgetMb = Math.max(0, rssFraction * memMb - agentOverheadMb);

  return {
    cores,
    memMb,
    cgroup: memLimited || cpuLimited,
    threads: cores,
    isolates: cores,
    rssBudgetMb,
    maxRssMbPerProcess: Math.floor(rssBudgetMb / plannedProcesses),
    maxResidentCells: Math.max(1, Math.round((residentCellsPer8Gb * memMb) / 8192)),
    probedAt: (opts?.now?.() ?? new Date()).toISOString(),
  };
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScaloError("invalid-input", "Invalid capacity input", {
      detail: `"${field}" must be a finite number greater than 0, got ${String(value)}`,
    });
  }
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ScaloError("invalid-input", "Invalid capacity input", {
      detail: `"${field}" must be a finite number of 0 or more, got ${String(value)}`,
    });
  }
  return value;
}

function fraction(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ScaloError("invalid-input", "Invalid capacity input", {
      detail: `"${field}" must be greater than 0 and at most 1, got ${String(value)}`,
    });
  }
  return value;
}
