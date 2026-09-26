/*
 * The celld deploy task is a real child process here. Lost authority must end that child and wait
 * for its exit before the runner returns: otherwise the stale builder can publish after a
 * successor has won.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import type { DeployRunInput, DeployRunResult, StagedArtifact } from "../src/core/types/deploy.ts";
import { packDirectory } from "../src/drivers/archive/tar-zst.ts";
import { createCelldDeployRunner } from "../src/drivers/deploy/celld.ts";

it.each(["artifactBytes", "archiveEntries"] as const)(
  "refuses every non-positive-safe-integer %s at the runner boundary",
  (field) => {
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      null,
      "unlimited",
      2 ** 53,
    ]) {
      expect(
        () => createCelldDeployRunner({ [field]: value } as never),
        `${field}=${String(value)}`,
      ).toThrowError(
        expect.objectContaining({
          code: "invalid-input",
          detail: expect.stringContaining("positive safe integer"),
        }),
      );
    }
  },
);

it("accepts positive safe-integer endpoints at the runner boundary", () => {
  for (const options of [
    { artifactBytes: 1, archiveEntries: Number.MAX_SAFE_INTEGER },
    { artifactBytes: Number.MAX_SAFE_INTEGER, archiveEntries: 1 },
  ]) {
    expect(() => createCelldDeployRunner(options)).not.toThrow();
  }
});

it("hands Celld the artifact's own config and the upstream builder path", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-config-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  const observed = join(root, "observed.json");
  /* Comments, ordering and spacing included: what celld reads is the file as its
     author wrote it, and a rewrite of any kind would show up here. */
  const written =
    '{\n  /* kept */\n  "name": "other",\n  "no_bundle": true,\n  "vars": { "A": "1" },\n}\n';
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'const { readFileSync, writeFileSync, writeSync } = require("node:fs");',
        'const config = process.argv[process.argv.indexOf("--config") + 1];',
        `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ config: readFileSync(config, "utf8"), name: config.split("/").pop(), env: { esbuild: process.env.CELLD_ESBUILD } }));`,
        'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), written);

    const artifact = await packDirectory(source);
    await createCelldDeployRunner({
      binPath: bin,
      stagingDir: staging,
      baseEnv: { CELLD_ESBUILD: "/opt/esbuild" },
    }).run(input(artifact), { signal: new AbortController().signal });

    const seen = JSON.parse(await readFile(observed, "utf8")) as Record<string, unknown>;
    expect(seen.config).toBe(written);
    expect(seen.name).toBe("wrangler.jsonc");
    expect(seen.env).toEqual({ esbuild: "/opt/esbuild" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads wrangler.json when the artifact carries no wrangler.jsonc", async () => {
  const written = '{ "name": "other", "no_bundle": true }';
  const seen = await deployedConfig("wrangler.json", written);

  expect(seen.config).toBe(written);
  expect(seen.name).toBe("wrangler.json");
});

it("refuses an artifact that carries no runtime config at all", async () => {
  await expect(deployedConfig(null, "")).rejects.toMatchObject({
    code: "invalid-input",
    message: "Artifact carries no runtime config",
  });
});

it("cancels mid-expansion and removes the partial extraction directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-expand-cancel-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  await Promise.all([mkdir(source), mkdir(staging)]);
  await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');
  await writeFile(join(source, "payload.bin"), crypto.getRandomValues(new Uint8Array(65_536)));
  const packed = await packDirectory(source);
  const bytes = new Uint8Array(await new Response(packed.open()).arrayBuffer());
  await packed.dispose();
  let reads = 0;
  const slow: StagedArtifact = {
    byteLength: bytes.byteLength,
    open: () => {
      let offset = 0;
      return new ReadableStream<Uint8Array>({
        async pull(stream): Promise<void> {
          await new Promise((resolve) => setTimeout(resolve, 1));
          reads += 1;
          const next = bytes.slice(offset, offset + 128);
          offset += next.byteLength;
          if (next.byteLength > 0) stream.enqueue(next);
          if (offset >= bytes.byteLength) stream.close();
        },
      });
    },
    dispose: () => Promise.resolve(),
  };
  const controller = new AbortController();
  const runner = createCelldDeployRunner({ binPath: "/never-reached", stagingDir: staging });
  const running = runner.run(input(slow), { signal: controller.signal });

  await expect.poll(() => reads).toBeGreaterThan(3);
  controller.abort(new ScafoError("lease-lost", "Publish authority was lost"));

  await expect(running).rejects.toMatchObject({ code: "lease-lost" });
  expect(await readdir(staging)).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

it("kills and awaits the builder before lost publish authority can return", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-cancel-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  const pidFile = join(root, "child.pid");
  const descendantFile = join(root, "descendant.pid");
  const staleEffect = join(root, "stale-effect");
  let pid: number | undefined;
  let descendantPid: number | undefined;

  try {
    const descendant = [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.SCAFO_TEST_DESCENDANT_PID, String(process.pid));",
      "setTimeout(() => {",
      '  writeFileSync(process.env.SCAFO_TEST_STALE_EFFECT, "stale");',
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
        SCAFO_TEST_STALE_EFFECT: staleEffect,
      },
    });
    const controller = new AbortController();
    const running = runner.run(input(await packDirectory(source)), { signal: controller.signal });

    pid = await pidFrom(pidFile);
    descendantPid = await pidFrom(descendantFile);

    controller.abort(new ScafoError("lease-lost", "Publish authority was lost"));

    await expect(running).rejects.toMatchObject({ code: "lease-lost" });
    expect(() => process.kill(pid as number, 0)).toThrow(/kill ESRCH/);
    expect(() => process.kill(descendantPid as number, 0)).toThrow(/kill ESRCH/);
    expect(await readdir(staging)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(readFile(staleEffect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
  const staleEffect = join(root, "stale-effect");
  let descendantPid: number | undefined;
  let running: Promise<DeployRunResult> | undefined;

  try {
    const descendant = [
      'import { writeFileSync } from "node:fs";',
      "writeFileSync(process.env.SCAFO_TEST_DESCENDANT_PID, String(process.pid));",
      "setTimeout(() => {",
      '  writeFileSync(process.env.SCAFO_TEST_STALE_EFFECT, "stale");',
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
        'writeSync(1, JSON.stringify({ worker: "shop", version: "1111aaaa", location: "s3://bucket/deploy/shop/1111aaaa", dry_run: false }) + "\\n");',
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
        SCAFO_TEST_STALE_EFFECT: staleEffect,
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
    await expect(readFile(staleEffect, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

it("reads celld 0.4 JSON output split across writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-output-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { writeSync } from "node:fs";',
        'if (!process.argv.includes("--json")) process.exit(2);',
        'writeSync(1, "{\\\"worker\\\":\\\"shop\\\",\\\"ver");',
        'writeSync(1, "sion\\\":\\\"abcdef12\\\",\\\"location\\\":\\\"s3://bucket/deploy/shop/abcdef12\\\",\\\"dry_run\\\":false}\\n");',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');
    const artifact = await packDirectory(source);

    const result = await createCelldDeployRunner({
      binPath: bin,
      stagingDir: staging,
      baseEnv: {},
      /* Diagnostic retention must not truncate the machine-output record. */
      outputBytes: 1,
    }).run(input(artifact), { signal: new AbortController().signal });

    expect(result).toEqual({ celldVersionId: "abcdef12" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses the pre-0.4 human deploy output", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-old-output-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { writeSync } from "node:fs";',
        'writeSync(1, "Current Version ID: abcdef12\\n");',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');

    const runner = createCelldDeployRunner({ binPath: bin, stagingDir: staging, baseEnv: {} });
    await expect(
      runner.run(input(await packDirectory(source)), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "store-nonconforming" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a detected version when celld fails after it may have published", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-partial-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { writeSync } from "node:fs";',
        'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
        'writeSync(2, "late failure\\n");',
        "process.exit(1);",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');

    const runner = createCelldDeployRunner({ binPath: bin, stagingDir: staging, baseEnv: {} });
    const error = await runner
      .run(input(await packDirectory(source)), { signal: new AbortController().signal })
      .catch((failure: unknown) => failure);

    expect(error).toMatchObject({ code: "publish-failed" });
    expect((error as Error & { detail?: string }).detail).toContain("abcdef12");
    expect((error as Error & { detail?: string }).detail).toContain("may already have published");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a detected version when publication is aborted after Celld named it", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-partial-abort-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  const ready = join(root, "ready");
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { writeFileSync, writeSync } from "node:fs";',
        'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
        'writeFileSync(process.env.SCAFO_TEST_READY, "ready");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');
    const controller = new AbortController();
    const runner = createCelldDeployRunner({
      binPath: bin,
      stagingDir: staging,
      baseEnv: { SCAFO_TEST_READY: ready },
    });
    const running = runner.run(input(await packDirectory(source)), { signal: controller.signal });
    await vi.waitFor(() => readFile(ready, "utf8"));
    controller.abort(new ScafoError("lease-lost", "Publish authority was lost"));

    const error = await running.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "lease-lost" });
    expect((error as Error & { detail?: string }).detail).toContain("abcdef12");
    expect((error as Error & { detail?: string }).detail).toContain("may already have published");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds failed publish detail by UTF-8 bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-output-fail-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'import { writeSync } from "node:fs";',
        'writeSync(2, "€".repeat(100_000));',
        "process.exit(1);",
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "shop" }');
    const artifact = await packDirectory(source);
    let failure: unknown;
    try {
      await createCelldDeployRunner({
        binPath: bin,
        stagingDir: staging,
        baseEnv: {},
        outputBytes: 65_536,
      }).run(input(artifact), { signal: new AbortController().signal });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "publish-failed" });
    const detail = (failure as ScafoError).detail ?? "";
    expect(new TextEncoder().encode(detail).byteLength).toBeLessThanOrEqual(4096);
    expect(detail).not.toContain("�");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Publishes an artifact carrying `config` as `name`, and hands back what celld read. */
async function deployedConfig(
  name: string | null,
  config: string,
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-config-"));
  const source = join(root, "source");
  const staging = join(root, "staging");
  const bin = join(root, "celld-test");
  const observed = join(root, "observed.json");
  try {
    await writeFile(
      bin,
      [
        `#!${process.execPath}`,
        'const { readFileSync, writeFileSync, writeSync } = require("node:fs");',
        'const config = process.argv[process.argv.indexOf("--config") + 1];',
        `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ config: readFileSync(config, "utf8"), name: config.split("/").pop() }));`,
        'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    /* An artifact needs SOMETHING in it to be a readable archive. */
    await writeFile(
      join(source, name ?? "index.js"),
      name === null ? "export default {};" : config,
    );

    await createCelldDeployRunner({ binPath: bin, stagingDir: staging }).run(
      input(await packDirectory(source)),
      { signal: new AbortController().signal },
    );
    return JSON.parse(await readFile(observed, "utf8")) as Record<string, unknown>;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function input(artifact: StagedArtifact): DeployRunInput {
  return {
    application: "shop",
    artifact,
    target: {
      endpoint: "http://store.test:9000",
      region: "us-east-1",
      bucket: "registry",
      prefix: "fleets/shop",
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
