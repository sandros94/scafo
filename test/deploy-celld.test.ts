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

it("hands Celld the no-bundle assertion and upstream builder path", async () => {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-no-bundle-"));
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
        `writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ config: JSON.parse(readFileSync(config, "utf8")), env: { esbuild: process.env.CELLD_ESBUILD } }));`,
        'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), '{ "name": "other", "no_bundle": false }');

    const artifact = await packDirectory(source);
    await createCelldDeployRunner({
      binPath: bin,
      stagingDir: staging,
      baseEnv: { CELLD_ESBUILD: "/opt/esbuild" },
    }).run({ ...input(artifact), noBundle: true }, { signal: new AbortController().signal });

    await expect(readFile(observed, "utf8")).resolves.toContain('"no_bundle":true');
    await expect(readFile(observed, "utf8")).resolves.toContain('"esbuild":"/opt/esbuild"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["wrangler.jsonc", true],
  ["wrangler.json", false],
] as const)(
  "preserves %s no_bundle when the deploy carries no assertion",
  async (name, noBundle) => {
    const root = await mkdtemp(join(tmpdir(), "scafo-deploy-no-bundle-preserve-"));
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
          `writeFileSync(${JSON.stringify(observed)}, readFileSync(config));`,
          'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
        ].join("\n"),
      );
      await chmod(bin, 0o755);
      await Promise.all([mkdir(source), mkdir(staging)]);
      await writeFile(join(source, name), JSON.stringify({ name: "other", no_bundle: noBundle }));

      await createCelldDeployRunner({ binPath: bin, stagingDir: staging }).run(
        input(await packDirectory(source)),
        { signal: new AbortController().signal },
      );

      await expect(readFile(observed, "utf8").then(JSON.parse)).resolves.toMatchObject({
        no_bundle: noBundle,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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

    expect(error).toMatchObject({ code: "invalid-input" });
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

    expect(failure).toMatchObject({ code: "invalid-input" });
    const detail = (failure as ScafoError).detail ?? "";
    expect(new TextEncoder().encode(detail).byteLength).toBeLessThanOrEqual(4096);
    expect(detail).not.toContain("�");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("writes the carried variables into a config that declares none", async () => {
  await expect(
    deployedConfig('{ "name": "other" }', { DATABASE_URL: "postgres://db.test/app" }),
  ).resolves.toMatchObject({ vars: { DATABASE_URL: "postgres://db.test/app" } });
});

it("adds the carried variables to the ones the artifact declares", async () => {
  const written = await deployedConfig('{ "name": "other", "vars": { "APP_VERSION": "v1" } }', {
    DATABASE_URL: "postgres://db.test/app",
  });

  expect(written.vars).toEqual({ APP_VERSION: "v1", DATABASE_URL: "postgres://db.test/app" });
});

it("leaves the config alone when the deploy carries no variables at all", async () => {
  const written = await deployedConfig('{ "name": "other", "vars": { "APP_VERSION": "v1" } }');

  expect(written).toEqual({ name: "shop", vars: { APP_VERSION: "v1" } });
});

it("refuses every name both sides declare rather than picking a winner", async () => {
  const failure = deployedConfig('{ "name": "other", "vars": { "A": "1", "B": "2", "C": "3" } }', {
    A: "x",
    C: "y",
  });

  await expect(failure).rejects.toMatchObject({
    code: "invalid-input",
    message: "Variable declared twice",
  });
  const detail = await failure.catch((error: unknown) => (error as ScafoError).detail ?? "");
  expect(detail).toContain("A");
  expect(detail).toContain("C");
  expect(detail).not.toContain("B");
  expect(detail).toContain("varset");
});

it.each(['["A=1"]', '"A=1"', "null", "5"])(
  "refuses a config whose vars is %s",
  async (declared) => {
    await expect(
      deployedConfig(`{ "name": "other", "vars": ${declared} }`, { A: "1" }),
    ).rejects.toMatchObject({
      code: "invalid-input",
      detail: expect.stringContaining("vars"),
    });
  },
);

it("publishes the config without a key every object answers for on its own", async () => {
  const written = await deployedConfig(
    '{ "name": "other", "constructor": { "cheat": true }, "vars": { "A": "1" } }',
    { B: "2" },
  );

  expect(Object.keys(written)).toEqual(["name", "vars"]);
  expect(written.vars).toEqual({ A: "1", B: "2" });
});

it("refuses a config variable named after something every object answers for", async () => {
  await expect(
    deployedConfig('{ "name": "other", "vars": { "constructor": "1" } }', { A: "1" }),
  ).rejects.toMatchObject({
    code: "invalid-input",
    detail: expect.stringContaining("constructor"),
  });
});

/** Publishes `config` with `vars` carried, and hands back the config celld read. */
async function deployedConfig(
  config: string,
  vars?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const root = await mkdtemp(join(tmpdir(), "scafo-deploy-vars-"));
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
        `writeFileSync(${JSON.stringify(observed)}, readFileSync(config));`,
        'writeSync(1, JSON.stringify({ worker: "shop", version: "abcdef12", location: "s3://bucket/deploy/shop/abcdef12", dry_run: false }) + "\\n");',
      ].join("\n"),
    );
    await chmod(bin, 0o755);
    await Promise.all([mkdir(source), mkdir(staging)]);
    await writeFile(join(source, "wrangler.jsonc"), config);

    await createCelldDeployRunner({ binPath: bin, stagingDir: staging }).run(
      { ...input(await packDirectory(source)), ...(vars === undefined ? {} : { vars }) },
      { signal: new AbortController().signal },
    );
    return JSON.parse(await readFile(observed, "utf8")) as Record<string, unknown>;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function input(artifact: StagedArtifact): DeployRunInput {
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
