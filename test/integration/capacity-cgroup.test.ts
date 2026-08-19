/*
 * The capacity plan against a real cgroup v2 hierarchy: the bytes the kernel
 * writes into a quota-limited container are exactly what the capacity formulas
 * read back, and a node inside it advertises the container rather than the
 * machine under it.
 *
 * Skipped unless S3_ENDPOINT is set: the global setup only exports it once a
 * container has actually started, so it doubles as a docker-availability probe.
 */

import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computeCapacity,
  parseCgroupLimits,
  probeCapacity,
} from "../../src/core/capacity/index.ts";
import { createNodeHostReader } from "../../src/drivers/host/node.ts";

/* The repo types web-standard globals only, so the runner's env is read off globalThis. */
const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

const ENDPOINT = env.S3_ENDPOINT ?? "";

const IMAGE = "busybox:1.37";
/** testcontainers takes memory in GB; cpu in whole CPUs. */
const QUOTA = { memory: 2, cpu: 1 };
/** A host far larger than the quota, so any leak of host values is obvious. */
const HOST = { cores: 64, memBytes: 64 * 1024 * 1024 * 1024 };
const START_TIMEOUT_MS = 180_000;

describe.skipIf(ENDPOINT === "")("a node inside a cgroup v2 quota", () => {
  let container: StartedTestContainer;
  let memoryMax: string;
  let cpuMax: string;

  beforeAll(async () => {
    container = await new GenericContainer(IMAGE)
      .withCommand(["sleep", "300"])
      .withResourcesQuota(QUOTA)
      .start();

    memoryMax = await readFile(container, "/sys/fs/cgroup/memory.max");
    cpuMax = await readFile(container, "/sys/fs/cgroup/cpu.max");
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    await container.stop();
  });

  it("reads back the quota the container was started with", () => {
    expect(memoryMax.trim()).toBe("2147483648");
    expect(cpuMax.trim()).toBe("100000 100000");
  });

  it("parses the raw files the kernel wrote", () => {
    expect(parseCgroupLimits(memoryMax, cpuMax)).toEqual({ memBytes: 2_147_483_648, cpus: 1 });
  });

  it("advertises the quota, not the 64-core host under it", () => {
    const plan = computeCapacity({ cgroup: { memoryMax, cpuMax }, host: HOST });

    expect(plan).toMatchObject({
      cores: 1,
      memMb: 2048,
      cgroup: true,
      threads: 1,
      isolates: 1,
      maxResidentCells: 250,
    });
  });
});

describe.skipIf(ENDPOINT === "")("the node host reader on this machine", () => {
  it("reports a usable host, cgroup limits or not", async () => {
    const inputs = await createNodeHostReader().capacityInputs();

    expect(inputs.host.cores).toBeGreaterThanOrEqual(1);
    expect(inputs.host.memBytes).toBeGreaterThan(0);
    /* No cgroup assertions: the runner may or may not be limited itself. */
    expect(inputs.cgroup).toHaveProperty("memoryMax");
    expect(inputs.cgroup).toHaveProperty("cpuMax");
  });

  it("turns that reading into a plan", async () => {
    const plan = await probeCapacity(createNodeHostReader());

    expect(plan.cores).toBeGreaterThanOrEqual(1);
    expect(plan.memMb).toBeGreaterThanOrEqual(1);
    expect(plan.maxResidentCells).toBeGreaterThanOrEqual(1);
    expect(Date.parse(plan.probedAt)).toBeGreaterThan(0);
  });
});

async function readFile(container: StartedTestContainer, path: string): Promise<string> {
  const { exitCode, output } = await container.exec(["cat", path]);
  expect(exitCode, `cat ${path} inside the container`).toBe(0);
  return output;
}
