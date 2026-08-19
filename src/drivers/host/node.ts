/* Host probe for Node-compatible runtimes (Node, Deno, Bun). */

import { readFile } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import type { CapacityInputs } from "../../core/capacity/compute.ts";
import type { HostReader } from "../../core/capacity/reader.ts";

/** Where cgroup v2 exposes the limits of the current container. */
const MEMORY_MAX = "/sys/fs/cgroup/memory.max";
const CPU_MAX = "/sys/fs/cgroup/cpu.max";

/**
 * Reads cgroup v2 limits and host totals. Unreadable cgroup files — non-Linux
 * hosts, bare metal, an unmounted cgroup namespace — read as `null`, which the
 * formulas treat as "no limit" and fall back to the host values.
 *
 * TODO: cgroup v1 (`memory.limit_in_bytes`, `cpu.cfs_quota_us`) is not read; a
 * node under v1 advertises its host's capacity.
 */
export function createNodeHostReader(): HostReader {
  return {
    async capacityInputs(): Promise<CapacityInputs> {
      const [memoryMax, cpuMax] = await Promise.all([readOrNull(MEMORY_MAX), readOrNull(CPU_MAX)]);
      return {
        cgroup: { memoryMax, cpuMax },
        host: { cores: availableParallelism(), memBytes: totalmem() },
      };
    },
  };
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
