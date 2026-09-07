/*
 * The version gate, against real executables: what `scafo sail` learns from
 * `celld --version` before it touches the bucket, and which binaries it refuses
 * to start on.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, type TestContext } from "vitest";
import { MIN_CELLD_VERSION, probeCelldVersion } from "../src/drivers/runtime/celld.ts";
import { rejectsWith } from "./_helpers.ts";

describe.concurrent("what the probe reads", () => {
  it("passes a binary at exactly the floor, and answers the version it named", async ({
    onTestFinished,
  }) => {
    const bin = await celldStub(onTestFinished, `celld ${MIN_CELLD_VERSION}`);

    await expect(probeCelldVersion(bin)).resolves.toBe("0.4.1");
  });

  it("passes anything newer, comparing the numbers rather than the text", async ({
    onTestFinished,
  }) => {
    /* Lexically "0.10.0" sorts BEFORE "0.4.1", so a text compare would refuse a
       binary that is two minor releases ahead of the floor. */
    const bin = await celldStub(onTestFinished, "celld 0.10.0");

    await expect(probeCelldVersion(bin)).resolves.toBe("0.10.0");
  });

  it("reads the version out of a debug build's banner", async ({ onTestFinished }) => {
    const bin = await celldStub(onTestFinished, "celld 0.4.1 (debug)");

    await expect(probeCelldVersion(bin)).resolves.toBe("0.4.1");
  });
});

describe.concurrent("what the probe refuses", () => {
  it("refuses a binary older than the floor, naming both versions", async ({ onTestFinished }) => {
    const bin = await celldStub(onTestFinished, "celld 0.4.0");

    const error = await rejectsWith(() => probeCelldVersion(bin), "capability-missing");

    expect(error.message).toBe("Celld is too old");
    /* Both, because the operator has to decide what to install: what is there
       now, and what this build will accept. */
    expect(error.detail).toContain("0.4.0");
    expect(error.detail).toContain(MIN_CELLD_VERSION);
  });

  it("refuses output no version can be read out of", async ({ onTestFinished }) => {
    const bin = await celldStub(onTestFinished, "some other program entirely");

    const error = await rejectsWith(() => probeCelldVersion(bin), "capability-missing");

    expect(error.message).toBe("Celld version is unreadable");
    expect(error.detail).toContain("some other program entirely");
  });

  it("refuses a binary that answers with a failure", async ({ onTestFinished }) => {
    const bin = await celldStub(onTestFinished, "--version is not a flag here", { exit: 3 });

    const error = await rejectsWith(() => probeCelldVersion(bin), "capability-missing");

    expect(error.message).toBe("Celld version is unreadable");
    expect(error.detail).toContain("code 3");
  });

  it("refuses a binary that never answers, rather than holding the boot open", async ({
    onTestFinished,
  }) => {
    const bin = await celldStub(onTestFinished, "celld 0.4.1", { sleepSeconds: 5 });

    const error = await rejectsWith(
      () => probeCelldVersion(bin, { timeoutMs: 250 }),
      "capability-missing",
    );

    expect(error.message).toBe("Celld version is unreadable");
    expect(error.detail).toContain("250ms");
  });

  it("says a path it could not start apart from one it could not read", async ({
    onTestFinished,
  }) => {
    const bin = await celldStub(onTestFinished, "celld 0.4.1");

    const error = await rejectsWith(
      () => probeCelldVersion(`${bin}-does-not-exist`),
      "capability-missing",
    );

    expect(error.message).toBe("Celld could not be run");
    expect(error.detail).toContain("--version");
  });
});

/**
 * A real executable that prints `output` and exits, removed when the test that
 * asked for it finishes. It can be told to fail, or to take its time.
 *
 * Real, rather than a mocked child process, because starting a program and
 * reading what it printed is the whole of what the probe does.
 */
async function celldStub(
  onTestFinished: TestContext["onTestFinished"],
  output: string,
  opts: { exit?: number; sleepSeconds?: number } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scafo-celld-version-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const bin = join(dir, "celld");
  const script = [
    "#!/bin/sh",
    ...(opts.sleepSeconds === undefined ? [] : [`sleep ${String(opts.sleepSeconds)}`]),
    `echo ${JSON.stringify(output)}`,
    `exit ${String(opts.exit ?? 0)}`,
    "",
  ];
  await writeFile(bin, script.join("\n"));
  await chmod(bin, 0o755);
  return bin;
}
