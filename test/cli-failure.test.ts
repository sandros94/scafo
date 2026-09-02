/* What the CLI says when a command does not go through. */

import type { CommandContext, CommandDef } from "citty";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { wg } from "../src/cli/commands/wg.ts";
import { reportFailure } from "../src/cli/_utils.ts";
import { ScafoError } from "../src/core/error.ts";

/** Bucket settings every configuration in this suite needs and none of it reaches. */
const REQUIRED_ENV: Record<string, string> = {
  SCAFO_S3_ENDPOINT: "http://store.test:9000",
  SCAFO_S3_BUCKET: "registry",
  SCAFO_S3_ACCESS_KEY: "key",
  SCAFO_S3_SECRET_KEY: "secret",
};

/** Permissions mean nothing to root, so the cases that rest on them are skipped. */
const asRoot = process.getuid?.() === 0;

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  /* Every failure sets it, and a suite that left it set would report the whole
     run as failed. */
  process.exitCode = undefined;
});

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("how a failure is printed", () => {
  it("renders a scafo failure as the problem document the API would answer with", () => {
    const said = capture();

    reportFailure(
      new ScafoError("not-found", "No such environment", { detail: `"shop/preview" is not there` }),
    );

    expect(said()).toEqual([
      `scafo: No such environment: "shop/preview" is not there [urn:scafo:not-found]`,
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("renders a failure scafo never wrapped as one line, and never as a stack", () => {
    const said = capture();

    reportFailure(new Error("EACCES: permission denied, open '/var/lib/scafo/node.json'"));

    expect(said()).toEqual([
      `scafo: unexpected failure: EACCES: permission denied, open '/var/lib/scafo/node.json'`,
    ]);
    expect(said().join("\n")).not.toMatch(/\n\s+at /);
    expect(process.exitCode).toBe(1);
  });

  it("names what an unexpected failure says it was caused by", () => {
    const said = capture();

    reportFailure(
      new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:7400") }),
    );

    expect(said()).toEqual([
      "scafo: unexpected failure: TypeError: fetch failed, caused by " +
        "connect ECONNREFUSED 127.0.0.1:7400",
    ]);
  });

  it("prints a thrown value that is not an error at all as what it says it is", () => {
    const said = capture();

    reportFailure("the runtime went away");

    expect(said()).toEqual(["scafo: unexpected failure: the runtime went away"]);
  });
});

describe.skipIf(asRoot)("a command that cannot reach its state directory", () => {
  it("says what happened rather than printing a Node stack trace", async () => {
    const locked = await lockedDir();
    const said = capture();

    await runWgInit(join(locked, "state"));

    /* One line, in the shape every other failure is printed in: no `Error:`
       header, no `at ...` frames, and the reason readable at the end of it. */
    expect(said()).toHaveLength(1);
    expect(said()[0]).toMatch(/^scafo: unexpected failure: /);
    expect(said()[0]).toContain("EACCES");
    expect(said()[0]).not.toMatch(/\n\s+at /);
    expect(process.exitCode).toBe(1);
  });

  it("says the same for an identity file it is not allowed to read", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "node.json"), "{}", "utf8");
    await chmod(join(dir, "node.json"), 0o000);
    const said = capture();

    await runWgInit(dir);

    expect(said()).toHaveLength(1);
    expect(said()[0]).toMatch(/^scafo: unexpected failure: /);
    expect(said()[0]).toContain("EACCES");
  });
});

/**
 * Collects what the command wrote to stderr, one entry per call.
 *
 * An Error handed to `console.error` is rendered by its STACK, because that is
 * what the console does with one — which is the whole of what these tests are
 * about, so a capture that reduced it to its message would pass either way.
 */
function capture(): () => string[] {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(printed).join(" "));
  });
  return () => lines;
}

function printed(value: unknown): string {
  if (typeof value === "string") return value;
  return value instanceof Error ? (value.stack ?? String(value)) : String(value);
}

/** Runs `scafo wg init` exactly as the binary would, against `stateDir`. */
async function runWgInit(stateDir: string): Promise<void> {
  for (const [name, value] of Object.entries(REQUIRED_ENV)) vi.stubEnv(name, value);

  const init = (wg.subCommands as Record<string, CommandDef>).init;
  await init.run?.({
    rawArgs: [],
    cmd: init,
    args: {
      "_": [],
      "state-dir": stateDir,
      "transport": "wireguard",
      "wg-address": "10.83.0.1/24",
      "wg-endpoint": "node.test:51820",
    },
  } as unknown as CommandContext);
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scafo-cli-failure-"));
  dirs.push(dir);
  return dir;
}

/** A directory nothing may be created in, which is what an EACCES needs. */
async function lockedDir(): Promise<string> {
  const dir = await tempDir();
  await chmod(dir, 0o500);
  return dir;
}
