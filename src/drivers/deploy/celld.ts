/*
 * Deploy runner for celld 0.2.x: unpacks an uploaded artifact and publishes it
 * into an environment's fleet as a new version.
 *
 * Publishing is a task, not a service — it starts, does one thing and exits — so
 * it runs as a plain child process rather than through the supervisor, which
 * exists to keep long-lived processes alive.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJSONC } from "confbox";
import { ScafoError } from "../../core/error.ts";
import { assertPositiveSafeInteger } from "../../core/utils/number.ts";
import { ByteTail, decodeUtf8Tail } from "../../core/utils/byte-tail.ts";
import type {
  DeployRunInput,
  DeployRunner,
  DeployRunResult,
  DeployRunOptions,
} from "../../core/types/deploy.ts";
import { unpackArchive } from "../archive/tar-zst.ts";
import { esbuildBinaryPath } from "./_esbuild.ts";
import { assertProcessGroups, processGroupId, stopProcessGroup } from "../_process-group.ts";

/** Command run when the caller does not name one. */
export const DEFAULT_CELLD_BIN: string = "celld";

/** Config files an artifact may carry, in the order they are looked for. */
const CONFIG_NAMES: string[] = ["wrangler.jsonc", "wrangler.json"];

/** The line the runtime reports a published version on. */
const VERSION_RE = /Current Version ID:\s*([\da-f]{8,64})/i;

/** Variable the runtime is told which esbuild executable to build with. */
const ESBUILD_ENV = "CELLD_ESBUILD";

export interface CelldDeployRunnerOptions {
  /** Executable that publishes a version; resolved against `PATH` unless it is a path. */
  binPath?: string;
  /** Directory the unpacked artifact is staged under. Defaults to the OS temp directory. */
  stagingDir?: string;
  /**
   * Environment the publish starts from; it REPLACES the child's rather than
   * extending it, so it must carry at least a usable `PATH`. Defaults to none,
   * which only works when `binPath` is an absolute path.
   */
  baseEnv?: Record<string, string>;
  /** In-flight subprocess output retained. */
  outputBytes?: number;
  /** Maximum expanded archive bytes. */
  artifactBytes?: number;
  /** Maximum archive entries. */
  archiveEntries?: number;
}

/** Builds the runner that publishes artifacts through the celld CLI. */
export function createCelldDeployRunner(opts?: CelldDeployRunnerOptions): DeployRunner {
  if (opts?.artifactBytes !== undefined) {
    assertPositiveSafeInteger(opts.artifactBytes, "artifactBytes");
  }
  if (opts?.archiveEntries !== undefined) {
    assertPositiveSafeInteger(opts.archiveEntries, "archiveEntries");
  }
  if (opts?.outputBytes !== undefined) assertPositiveSafeInteger(opts.outputBytes, "outputBytes");
  assertProcessGroups();
  const binPath = opts?.binPath ?? DEFAULT_CELLD_BIN;
  const staging = opts?.stagingDir ?? tmpdir();
  const baseEnv = opts?.baseEnv ?? {};
  const outputBytes = opts?.outputBytes ?? 65_536;

  return {
    async run(input: DeployRunInput, runOpts: DeployRunOptions): Promise<DeployRunResult> {
      /* Resolved before anything is unpacked: a node with no builder cannot
         publish, and finding that out after writing megabytes to disk helps
         nobody. */
      const esbuild = esbuildBinaryPath(globalThis.process?.env ?? {});
      const dir = await mkdtemp(join(staging, "scafo-deploy-"));

      try {
        await unpackArchive(input.artifact, dir, {
          ...(opts?.artifactBytes === undefined ? {} : { maxBytes: opts.artifactBytes }),
          ...(opts?.archiveEntries === undefined ? {} : { maxEntries: opts.archiveEntries }),
          signal: runOpts.signal,
        });
        const config = await prepareConfig(dir, input.script);

        const version = await run(
          binPath,
          [
            "deploy",
            "--config",
            config,
            "--bucket",
            `${input.target.bucket}/${input.target.prefix}`,
            "--endpoint",
            input.target.endpoint,
          ],
          {
            signal: runOpts.signal,
            outputBytes,
            env: {
              ...baseEnv,
              AWS_ACCESS_KEY_ID: input.target.accessKey,
              AWS_SECRET_ACCESS_KEY: input.target.secretKey,
              AWS_REGION: input.target.region,
              [ESBUILD_ENV]: esbuild,
            },
          },
        );

        if (version === undefined) {
          throw new ScafoError("store-nonconforming", "Publish reported no version", {
            detail: `"${binPath} deploy" exited successfully without naming a version id`,
          });
        }
        /* Version ids address bucket keys, which are lowercase throughout. */
        return { celldVersionId: version.toLowerCase() };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Points the artifact's config at the name scafo recorded for it, and returns
 * the path to it.
 *
 * The runtime files a version under the name its config carries, and the fleet's
 * pointer is then addressed by that name for the lifetime of the environment. An
 * artifact that named itself something else would deploy into a second fleet
 * directory the daemon never activates, so the recorded name wins.
 */
async function prepareConfig(dir: string, script: string): Promise<string> {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }

    const parsed: unknown = parseJSONC(text, { allowTrailingComma: true });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ScafoError("invalid-input", "Artifact config is not an object", {
        detail: `"${name}" must hold an object of runtime settings`,
      });
    }

    await writeFile(path, JSON.stringify({ ...parsed, name: script }, null, 2), "utf8");
    return path;
  }

  throw new ScafoError("invalid-input", "Artifact carries no runtime config", {
    detail: `the archive has none of ${CONFIG_NAMES.join(", ")} at its root`,
  });
}

/**
 * Runs the publish to completion and hands back everything it said. Output is
 * kept whole: it is the only account of what a failed publish did.
 */
function run(
  command: string,
  args: string[],
  opts: { signal: AbortSignal; env: Record<string, string>; outputBytes: number },
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(aborted(opts.signal));
      return;
    }

    const child = spawn(command, args, {
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const output = new ByteTail(opts.outputBytes);
    let stdoutCarry = "";
    let version: string | undefined;
    let spawned = false;
    let cancelled = false;
    let spawnFailure: ScafoError | undefined;
    let cleanup: Promise<void> | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk);
      if (version !== undefined) return;
      const text = stdoutCarry + new TextDecoder().decode(chunk);
      version = VERSION_RE.exec(text)?.[1];
      stdoutCarry = text.slice(-128);
    });
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

    const beginCleanup = (): void => {
      if (!spawned) return;
      cleanup ??= stopProcessGroup(processGroupId(child.pid, command));
      cleanup.catch(() => {});
    };

    const cancel = (): void => {
      cancelled = true;
      /* A stale builder is an integrity risk, not a graceful shutdown: it may
         move the deployment pointer at any point before it exits. */
      beginCleanup();
    };
    opts.signal.addEventListener("abort", cancel, { once: true });

    child.once("spawn", () => {
      spawned = true;
      if (cancelled) beginCleanup();
    });

    /* `close` waits for stdio. A descendant can inherit those pipes after the
       leader exits, so group teardown must begin at leader exit or `close`
       would be the event cleanup itself is waiting to make possible. */
    child.on("exit", beginCleanup);

    child.on("error", (error) => {
      spawnFailure = new ScafoError("capability-missing", "Publish command could not be run", {
        detail: `"${command}" could not be started on this node`,
        cause: error,
      });
    });

    child.on("close", (code, signal) => {
      void settle(code, signal).catch(reject);
    });

    async function settle(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
      opts.signal.removeEventListener("abort", cancel);
      beginCleanup();
      if (cleanup !== undefined) await cleanup;
      if (cancelled) {
        reject(aborted(opts.signal));
        return;
      }
      if (spawnFailure !== undefined) {
        reject(spawnFailure);
        return;
      }
      if (code === 0) {
        resolve(version);
        return;
      }
      const ended =
        signal === null ? `exited with code ${String(code)}` : `was killed by ${signal}`;
      const prefix = `"${command} ${args[0] ?? ""}" ${ended}: `;
      const tailBytes = Math.max(1, 4096 - new TextEncoder().encode(prefix).byteLength);
      reject(
        new ScafoError("invalid-input", "Publish failed", {
          detail:
            prefix + decodeUtf8Tail(output.bytes(), Math.min(opts.outputBytes, tailBytes)).trim(),
        }),
      );
    }
  });
}

function aborted(signal: AbortSignal): ScafoError {
  if (signal.reason instanceof ScafoError) return signal.reason;
  return new ScafoError("lease-lost", "Publish authority was lost", { cause: signal.reason });
}
