/* cgroup v2 interface files, parsed. Pure: callers supply the file contents. */

/** Limits a node runs under, as read from its cgroup. `null` means unlimited. */
export interface CgroupLimits {
  memBytes: number | null;
  cpus: number | null;
}

/**
 * Parses `memory.max`: either `max` (no limit) or a byte count. Anything else —
 * absent file, cgroup v1 layout, garbage — reads as no limit, so a node degrades
 * to its host memory rather than to zero.
 */
export function parseMemoryMax(contents: string | null): number | null {
  const value = contents?.trim();
  if (value === undefined || value === "" || value === "max") return null;

  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

/**
 * Parses `cpu.max`: `<quota> <period>` in microseconds, or `max <period>` for no
 * limit. The result is fractional CPUs (`quota / period`); unreadable or
 * malformed input reads as no limit.
 */
export function parseCpuMax(contents: string | null): number | null {
  const value = contents?.trim();
  if (value === undefined || value === "") return null;

  const [rawQuota, rawPeriod] = value.split(/\s+/);
  if (rawQuota === undefined || rawQuota === "max") return null;

  const quota = Number(rawQuota);
  /* The period column is optional; the kernel default is 100ms. */
  const period = rawPeriod === undefined ? 100_000 : Number(rawPeriod);

  if (!Number.isFinite(quota) || !Number.isFinite(period)) return null;
  if (quota <= 0 || period <= 0) return null;
  return quota / period;
}

/** Both cgroup v2 limits of a node, from the raw contents of the two files. */
export function parseCgroupLimits(memoryMax: string | null, cpuMax: string | null): CgroupLimits {
  return { memBytes: parseMemoryMax(memoryMax), cpus: parseCpuMax(cpuMax) };
}
