/* Capacity planning formulas. Pure: every input is supplied by the caller. */

import { ScafoError } from "../error.ts";
import { parseCpuMax, parseMemoryMax } from "./cgroup.ts";

/** Everything the plan is derived from: raw cgroup files plus host totals. */
export interface CapacityInputs {
  /** Raw file contents; `null` when the file is absent or unreadable. */
  cgroup: { memoryMax: string | null; cpuMax: string | null };
  host: { cores: number; memBytes: number };
}

/** Tunables of the capacity formulas. Every field has a sensible default. */
export interface CapacityOverrides {
  /** Share of memory the runtime may hold resident. Default `0.8`. */
  rssFraction?: number;
  /** Memory reserved for the daemon itself, in MiB. Default `128`. */
  daemonOverheadMb?: number;
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
  /**
   * Wakes this node will cold-start at the same time; further ones are refused
   * with a retry hint, never queued — a queue of held requests is a memory of
   * promises the node may not keep, and a refused wake writes no stamp, so
   * nothing is booted on behalf of a request that was already turned away.
   *
   * A wake IS a process boot — unpacking nothing, but starting a runtime,
   * loading a build — and boots are CPU-bound
   * bursts rather than steady load, so the ceiling is taken from threads and not
   * from memory. Half of them, so a node waking a batch keeps enough of itself
   * to answer for what it is already serving.
   *
   * ONE IS ALWAYS ALLOWED, whatever the hardware says: a node that could wake
   * nothing would park an environment permanently the first time it was asked
   * for. EIGHT IS A COURTESY CEILING rather than a hardware one — a crawler
   * walking a platform domain touches every parked environment there is, and
   * without a cap a big node would answer by turning itself into a boot farm.
   */
  maxConcurrentWakes: number;
  probedAt: string;
}

const MIB = 1024 * 1024;

export const DEFAULT_MEMORY_FRACTION: number = 0.8;
export const DEFAULT_DAEMON_OVERHEAD_MB: number = 128;

/* Bounds of {@link CapacityPlan.maxConcurrentWakes}, whatever the thread count is. */
const MIN_CONCURRENT_WAKES = 1;
const MAX_CONCURRENT_WAKES = 8;

/**
 * Derives a node's capacity plan. cgroup v2 limits win over host values wherever
 * they are present and lower, so a containerized node never advertises the
 * hardware of its host.
 *
 * Throws `ScafoError("invalid-input")` on non-positive host values or overrides:
 * a plan computed from a degenerate probe would be silently wrong.
 */
export function computeCapacity(
  inputs: CapacityInputs,
  opts?: CapacityOverrides & { now?: () => Date },
): CapacityPlan {
  const hostCores = positive(inputs.host.cores, "host.cores");
  const hostMemBytes = positive(inputs.host.memBytes, "host.memBytes");

  const rssFraction = fraction(opts?.rssFraction ?? DEFAULT_MEMORY_FRACTION, "rssFraction");
  const daemonOverheadMb = nonNegative(
    opts?.daemonOverheadMb ?? DEFAULT_DAEMON_OVERHEAD_MB,
    "daemonOverheadMb",
  );
  const plannedProcesses = positive(opts?.plannedProcesses ?? 1, "plannedProcesses");
  const residentCellsPer8Gb = positive(opts?.residentCellsPer8Gb ?? 1000, "residentCellsPer8Gb");

  const cgroupMemBytes = parseMemoryMax(inputs.cgroup.memoryMax);
  const cgroupCpus = parseCpuMax(inputs.cgroup.cpuMax);

  const memLimited = cgroupMemBytes !== null && cgroupMemBytes < hostMemBytes;
  const cpuLimited = cgroupCpus !== null && cgroupCpus < hostCores;

  const memMb = Math.floor((memLimited ? cgroupMemBytes : hostMemBytes) / MIB);
  const cores = cpuLimited ? Math.max(1, Math.ceil(cgroupCpus)) : hostCores;

  const rssBudgetMb = Math.max(0, Math.floor(rssFraction * memMb - daemonOverheadMb));
  const threads = cores;

  return {
    cores,
    memMb,
    cgroup: memLimited || cpuLimited,
    threads,
    isolates: cores,
    rssBudgetMb,
    maxRssMbPerProcess: Math.floor(rssBudgetMb / plannedProcesses),
    maxResidentCells: Math.max(1, Math.round((residentCellsPer8Gb * memMb) / 8192)),
    maxConcurrentWakes: Math.min(
      MAX_CONCURRENT_WAKES,
      Math.max(MIN_CONCURRENT_WAKES, Math.ceil(threads / 2)),
    ),
    probedAt: (opts?.now?.() ?? new Date()).toISOString(),
  };
}

function positive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ScafoError("invalid-input", "Invalid capacity input", {
      detail: `"${field}" must be a finite number greater than 0, got ${String(value)}`,
    });
  }
  return value;
}

function nonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ScafoError("invalid-input", "Invalid capacity input", {
      detail: `"${field}" must be a finite number of 0 or more, got ${String(value)}`,
    });
  }
  return value;
}

function fraction(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ScafoError("invalid-input", "Invalid capacity input", {
      detail: `"${field}" must be greater than 0 and at most 1, got ${String(value)}`,
    });
  }
  return value;
}
