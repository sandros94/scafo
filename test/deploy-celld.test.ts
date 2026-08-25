/*
 * The celld deploy task is a real child process here. A lost pointer lock must
 * end that child and wait for its exit before the runner returns: otherwise the
 * stale builder can move the fleet pointer after a successor has won.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import type { DeployRunInput, DeployRunResult } from "../src/core/types/deploy.ts";
import { packDirectory } from "../src/drivers/archive/tar-zst.ts";
import { createCelldDeployRunner } from "../src/drivers/deploy/celld.ts";

it("kills and awaits the builder before a lost pointer lock can return", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-cancel-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  const pidFile = join(root, "child.pid");
  const descendantFile = join(root, "descendant.pid");
  const pointer = join(root, "pointer-moved");
  let pid: number | undefined;
  let descendantPid: number | undefined;

  try {
    const descendant = [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.SCAFO_TEST_DESCENDANT_PID, String(process.pid));",
      "setTimeout(() => {",
      '  writeFileSync(process.env.SCAFO_TEST_POINTER, "stale");',
      "}, 250);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.SCAFO_TEST_PID, String(process.pid));",
        `spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendant)}], { stdio: "ignore", env: process.env });`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');
    await writeFile(join(source, "index.mjs"), "export default {};");

    const runner = createCelldDeployRunner({
      binPath: bin,
      stagingDir: staging,
      baseEnv: {
        SCAFO_TEST_PID: pidFile,
        SCAFO_TEST_DESCENDANT_PID: descendantFile,
        SCAFO_TEST_POINTER: pointer,
      },
    });
    const controller = new AbortController();
    const running = runner.run(input(await packDirectory(source)), { signal: controller.signal });

    pid = await pidFrom(pidFile);
    descendantPid = await pidFrom(descendantFile);

    controller.abort(new ScafoError("lease-lost", "Pointer lock was lost"));

    await expect(running).rejects.toMatchObject({ code: "lease-lost" });
    expect(() => process.kill(pid as number, 0)).toThrow(/kill ESRCH/);
    expect(() => process.kill(descendantPid as number, 0)).toThrow(/kill ESRCH/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(pointer, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already gone, which is the expected path. */
      }
    }
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* Already gone, which is the expected path. */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

it("tears down an inherited-pipe descendant when the builder leader exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-leader-exit-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  const descendantFile = join(root, "descendant.pid");
  const pointer = join(root, "pointer-moved");
  let descendantPid: number | undefined;
  let running: Promise<DeployRunResult> | undefined;

  try {
    const descendant = [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.SCAFO_TEST_DESCENDANT_PID, String(process.pid));",
      "setTimeout(() => {",
      '  writeFileSync(process.env.SCAFO_TEST_POINTER, "stale");',
      "}, 250);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { spawn } from "node:child_process";',
        'import { writeFileSync, writeSync } from "node:fs";',
        `const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendant)}], { stdio: "inherit", env: process.env });`,
        "writeFileSync(process.env.SCAFO_TEST_DESCENDANT_PID, String(descendant.pid));",
        'writeSync(1, "Current Version ID: 1111aaaa\\n");',
        "setTimeout(() => process.exit(0), 20);",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');
    await writeFile(join(source, "index.mjs"), "export default {};");

    const runner = createCelldDeployRunner({
      binPath: bin,
      stagingDir: staging,
      baseEnv: {
        SCAFO_TEST_DESCENDANT_PID: descendantFile,
        SCAFO_TEST_POINTER: pointer,
      },
    });
    running = runner.run(input(await packDirectory(source)), {
      signal: new AbortController().signal,
    });
    descendantPid = await pidFrom(descendantFile);

    const outcome = await Promise.race([
      running.then((result) => ({ state: "settled" as const, result })),
      new Promise<{ state: "hung" }>((resolve) =>
        setTimeout(() => resolve({ state: "hung" }), 750),
      ),
    ]);

    expect(outcome).toEqual({ state: "settled", result: { celldVersionId: "1111aaaa" } });
    expect(() => process.kill(descendantPid as number, 0)).toThrow(/kill ESRCH/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(pointer, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        /* Already gone, which is the expected path. */
      }
    }
    await running?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

function input(artifact: Uint8Array): DeployRunInput {
  return {
    project: "shop",
    environment: "prod",
    script: "shop",
    artifact,
    target: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      prefix: "shop/prod",
      accessKey: "key",
      secretKey: "secret",
    },
  };
}

async function pidFrom(path: string): Promise<number> {
  await expect
    .poll(async () => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return "";
      }
    })
    .not.toBe("");
  return Number(await readFile(path, "utf8"));
}
