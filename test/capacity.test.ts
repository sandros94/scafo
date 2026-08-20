/*
 * cgroup v2 parsing and the capacity planning formulas. Every input is supplied
 * here, so the plan is fully determined by the numbers in this file.
 */

import { describe, expect, it } from "vitest";
import type { CapacityInputs, CapacityOverrides, HostReader } from "../src/core/capacity/index.ts";
import {
  computeCapacity,
  parseCgroupLimits,
  parseCpuMax,
  parseMemoryMax,
  probeCapacity,
} from "../src/core/capacity/index.ts";
import type { ScafoError } from "../src/core/error.ts";
import { CLOCK_START_MS, rejectionOf } from "./_helpers.ts";

const GIB = 1024 * 1024 * 1024;
const HOST = { cores: 8, memBytes: 16 * GIB };
const NO_CGROUP = { memoryMax: null, cpuMax: null };
const PROBED_AT = new Date(CLOCK_START_MS).toISOString();

/** A 2 GiB / 1 CPU quota, exactly as the kernel writes it. */
const TWO_GIB = "2147483648\n";
const HALF_CPU = "50000 100000\n";

describe("parseMemoryMax", () => {
  it("reads a byte count, and nothing else", () => {
    expect(parseMemoryMax(TWO_GIB)).toBe(2_147_483_648);
    expect(parseMemoryMax("2147483648")).toBe(2_147_483_648);
    expect(parseMemoryMax("  1048576  ")).toBe(1_048_576);
  });

  it("treats no limit, no file and nonsense alike as unlimited", () => {
    for (const contents of ["max\n", "max", "", "  \n", "garbage", "12x4", "0", "-1", null]) {
      expect(parseMemoryMax(contents), `for ${JSON.stringify(contents)}`).toBeNull();
    }
  });
});

describe("parseCpuMax", () => {
  it("reads quota over period as fractional CPUs", () => {
    expect(parseCpuMax("100000 100000")).toBe(1);
    expect(parseCpuMax(HALF_CPU)).toBe(0.5);
    expect(parseCpuMax("200000 100000")).toBe(2);
    expect(parseCpuMax("25000 50000")).toBe(0.5);
    /* The period column is optional; the kernel default is 100ms. */
    expect(parseCpuMax("100000")).toBe(1);
  });

  it("treats no limit, no file and nonsense alike as unlimited", () => {
    for (const contents of [
      "max 100000\n",
      "max",
      "",
      "  \n",
      "garbage 100000",
      "100000 nonsense",
      "0 100000",
      "100000 0",
      "-5 100000",
      null,
    ]) {
      expect(parseCpuMax(contents), `for ${JSON.stringify(contents)}`).toBeNull();
    }
  });
});

describe("parseCgroupLimits", () => {
  it("reads both files at once", () => {
    expect(parseCgroupLimits(TWO_GIB, HALF_CPU)).toEqual({ memBytes: 2_147_483_648, cpus: 0.5 });
    expect(parseCgroupLimits("max\n", "max 100000\n")).toEqual({ memBytes: null, cpus: null });
    expect(parseCgroupLimits(null, null)).toEqual({ memBytes: null, cpus: null });
  });
});

describe("computeCapacity falls back to the host", () => {
  it("advertises the host when no cgroup limit is readable", () => {
    const plan = computeCapacity({ cgroup: NO_CGROUP, host: HOST }, { now: fixedNow });

    expect(plan).toMatchObject({
      cores: 8,
      memMb: 16_384,
      cgroup: false,
      threads: 8,
      isolates: 8,
      maxResidentCells: 2000,
      probedAt: PROBED_AT,
    });
    /* threads track cores, and one isolate is planned per thread. */
    expect(plan.threads).toBe(plan.cores);
    expect(plan.isolates).toBe(plan.threads);
  });

  it("ignores a cgroup limit that is not tighter than the host", () => {
    const plan = computeCapacity({
      cgroup: { memoryMax: String(32 * GIB), cpuMax: "1600000 100000" },
      host: HOST,
    });

    expect(plan).toMatchObject({ cores: 8, memMb: 16_384, cgroup: false });
  });

  it("ignores a cgroup limit that exactly equals the host", () => {
    const plan = computeCapacity({
      cgroup: { memoryMax: String(16 * GIB), cpuMax: "800000 100000" },
      host: HOST,
    });

    expect(plan).toMatchObject({ cores: 8, memMb: 16_384, cgroup: false });
  });
});

describe("computeCapacity honours a tighter cgroup", () => {
  it("advertises the container, not the machine it runs on", () => {
    const plan = computeCapacity({ cgroup: { memoryMax: TWO_GIB, cpuMax: HALF_CPU }, host: HOST });

    expect(plan).toMatchObject({
      cores: 1,
      memMb: 2048,
      cgroup: true,
      threads: 1,
      isolates: 1,
      maxResidentCells: 250,
    });
  });

  it("flags the cgroup when only one of the two limits bites", () => {
    expect(
      computeCapacity({ cgroup: { memoryMax: TWO_GIB, cpuMax: null }, host: HOST }),
    ).toMatchObject({ cores: 8, memMb: 2048, cgroup: true });

    expect(
      computeCapacity({ cgroup: { memoryMax: null, cpuMax: HALF_CPU }, host: HOST }),
    ).toMatchObject({ cores: 1, memMb: 16_384, cgroup: true });
  });

  it("rounds a fractional CPU quota up, never below one core", () => {
    const cores = (cpuMax: string): number =>
      computeCapacity({ cgroup: { memoryMax: null, cpuMax }, host: HOST }).cores;

    expect(cores("20000 100000")).toBe(1);
    expect(cores("100000 100000")).toBe(1);
    expect(cores("150000 100000")).toBe(2);
    expect(cores("250000 100000")).toBe(3);
  });
});

describe("the capacity formulas", () => {
  it("grants 1000 resident cells per 8 GiB", () => {
    expect(planFor(8 * GIB).maxResidentCells).toBe(1000);
    expect(planFor(16 * GIB).maxResidentCells).toBe(2000);
    expect(planFor(4 * GIB).maxResidentCells).toBe(500);
  });

  it("budgets 70% of memory minus the agent's own overhead", () => {
    const plan = planFor(8 * GIB);

    expect(plan.rssBudgetMb).toBeCloseTo(0.7 * 8192 - 128, 6);
    expect(plan.maxRssMbPerProcess).toBe(5606);
  });

  it("takes the fraction and the overhead from the overrides", () => {
    expect(planFor(8 * GIB, { rssFraction: 0.5, agentOverheadMb: 0 }).rssBudgetMb).toBeCloseTo(
      4096,
      6,
    );
    expect(planFor(8 * GIB, { rssFraction: 1, agentOverheadMb: 512 }).rssBudgetMb).toBeCloseTo(
      7680,
      6,
    );
    expect(planFor(8 * GIB, { residentCellsPer8Gb: 2000 }).maxResidentCells).toBe(2000);
  });

  it("splits the budget across the planned processes", () => {
    const one = planFor(8 * GIB, { plannedProcesses: 1 });
    const two = planFor(8 * GIB, { plannedProcesses: 2 });
    const four = planFor(8 * GIB, { plannedProcesses: 4 });

    expect(two.rssBudgetMb).toBe(one.rssBudgetMb);
    expect(two.maxRssMbPerProcess).toBe(2803);
    expect(four.maxRssMbPerProcess).toBe(1401);
  });

  it("floors at zero budget and one cell on a tiny host", () => {
    const plan = planFor(1024 * 1024);

    expect(plan).toMatchObject({ memMb: 1, rssBudgetMb: 0, maxRssMbPerProcess: 0 });
    /* Rounding would give zero cells; the node still advertises one. */
    expect(plan.maxResidentCells).toBe(1);
  });

  it("stamps probedAt from the injected clock", () => {
    expect(computeCapacity({ cgroup: NO_CGROUP, host: HOST }, { now: fixedNow }).probedAt).toBe(
      PROBED_AT,
    );
  });
});

describe("computeCapacity refuses a degenerate probe", () => {
  it("refuses non-positive host values", async () => {
    for (const cores of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await refusal({ cgroup: NO_CGROUP, host: { cores, memBytes: 16 * GIB } });
      expect(error.code, `for cores ${String(cores)}`).toBe("invalid-input");
    }
    for (const memBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await refusal({ cgroup: NO_CGROUP, host: { cores: 8, memBytes } });
      expect(error.code, `for memBytes ${String(memBytes)}`).toBe("invalid-input");
    }
  });

  it("refuses overrides outside their ranges", async () => {
    const inputs: CapacityInputs = { cgroup: NO_CGROUP, host: HOST };
    const overrides: CapacityOverrides[] = [
      ...[0, -0.5, 1.5, Number.NaN].map((rssFraction) => ({ rssFraction })),
      ...[-1, Number.NaN].map((agentOverheadMb) => ({ agentOverheadMb })),
      ...[0, -2, Number.NaN].map((plannedProcesses) => ({ plannedProcesses })),
      ...[0, -1000].map((residentCellsPer8Gb) => ({ residentCellsPer8Gb })),
    ];

    for (const opts of overrides) {
      expect((await refusal(inputs, opts)).code, `for ${JSON.stringify(opts)}`).toBe(
        "invalid-input",
      );
    }
  });

  it("names the offending field in the detail", async () => {
    const error = await refusal({ cgroup: NO_CGROUP, host: { cores: 0, memBytes: 16 * GIB } });

    expect(error.code).toBe("invalid-input");
    expect(error.detail).toContain("host.cores");
    expect(error.status).toBe(400);
  });
});

describe("probeCapacity", () => {
  it("applies the formulas to whatever the reader reports", async () => {
    const reader = readerFor({ cgroup: { memoryMax: TWO_GIB, cpuMax: HALF_CPU }, host: HOST });

    await expect(probeCapacity(reader, { now: fixedNow })).resolves.toMatchObject({
      cores: 1,
      memMb: 2048,
      cgroup: true,
      probedAt: PROBED_AT,
    });
  });

  it("forwards the overrides", async () => {
    const reader = readerFor({ cgroup: NO_CGROUP, host: { cores: 4, memBytes: 8 * GIB } });

    await expect(probeCapacity(reader, { plannedProcesses: 2 })).resolves.toMatchObject({
      maxRssMbPerProcess: 2803,
    });
  });

  it("surfaces a degenerate probe as invalid-input", async () => {
    const reader = readerFor({ cgroup: NO_CGROUP, host: { cores: 0, memBytes: 0 } });

    expect((await rejectionOf(() => probeCapacity(reader))).code).toBe("invalid-input");
  });
});

function fixedNow(): Date {
  return new Date(CLOCK_START_MS);
}

function planFor(memBytes: number, opts?: CapacityOverrides): ReturnType<typeof computeCapacity> {
  return computeCapacity({ cgroup: NO_CGROUP, host: { cores: 4, memBytes } }, opts);
}

function readerFor(inputs: CapacityInputs): HostReader {
  return { capacityInputs: (): Promise<CapacityInputs> => Promise.resolve(inputs) };
}

function refusal(inputs: CapacityInputs, opts?: CapacityOverrides): Promise<ScafoError> {
  return rejectionOf(() => Promise.resolve(computeCapacity(inputs, opts)));
}
