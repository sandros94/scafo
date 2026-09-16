/* Unpacks an artifact and publishes it through a short-lived Celld CLI process. */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJSONC } from "confbox";
import { safeJsonParse, sanitizeObjectCopy } from "unsecure/sanitize";
import { ScafoError } from "../../core/error.ts";
import { RESERVED_ENV_NAMES } from "../../core/utils/env.ts";
import { assertPositiveSafeInteger } from "../../core/utils/number.ts";
import { ByteTail, decodeUtf8Tail } from "../../core/utils/byte-tail.ts";
import type {
  DeployRunInput,
  DeployRunner,
  DeployRunResult,
  DeployRunOptions,
} from "../../core/types/deploy.ts";
import { unpackArchive } from "../archive/tar-zst.ts";
import { assertProcessGroups, processGroupId, stopProcessGroup } from "../_process-group.ts";

/** Command run when the caller does not name one. */
export const DEFAULT_CELLD_BIN: string = "celld";

/** Config files an artifact may carry, in the order they are looked for. */
const CONFIG_NAMES: string[] = ["wrangler.jsonc", "wrangler.json"];

/** The version shape celld uses in deployment object keys. */
const VERSION_RE = /^[\da-f]{8,64}$/i;

/** Independent bound for celld's one machine-output deployment record. */
const DEPLOY_RECORD_BYTES = 4096;

export interface CelldDeployRunnerOptions {
  /** Executable that publishes a version; resolved against `PATH` unless it is a path. */
  binPath?: string;
  /** Directory the unpacked artifact is staged under. Defaults to the OS temp directory. */
  stagingDir?: string;
  /** Child environment replacing the inherited environment; include PATH as needed. */
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
      const dir = await mkdtemp(join(staging, "scafo-deploy-"));

      try {
        await unpackArchive(input.artifact, dir, {
          ...(opts?.artifactBytes === undefined ? {} : { maxBytes: opts.artifactBytes }),
          ...(opts?.archiveEntries === undefined ? {} : { maxEntries: opts.archiveEntries }),
          signal: runOpts.signal,
        });
        const config = await prepareConfig(dir, {
          script: input.script,
          noBundle: input.noBundle,
          vars: input.vars,
        });

        const version = await run(
          binPath,
          [
            "deploy",
            "--json",
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

/** What the artifact's own config is rewritten with before it is published. */
interface ConfigRewrite {
  /** Name the runtime files the application under. */
  script: string;
  /** Ask the runtime to use the artifact's self-contained Worker entry. */
  noBundle: true | undefined;
  /** Variables the environment carries, or none. */
  vars: Record<string, string> | undefined;
}

/**
 * Rewrites the artifact config with the environment name used by the runtime and
 * the variables its deploys carry.
 *
 * `vars` is the runtime's one variable channel, so the environment's are merged
 * into whatever the artifact declares. A deploy that carries none leaves the
 * config's own `vars` untouched, exactly as it arrived.
 */
async function prepareConfig(dir: string, rewrite: ConfigRewrite): Promise<string> {
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

    /* The document is taken by its own entries and copied without the keys every
       object answers for on its own. `vars` is left out of that copy and read as
       the author wrote it: a name that cannot be read back is refused below,
       which is worth more to whoever wrote it than a key quietly disappearing. */
    const { vars: declared, ...outer } = parsed as Record<string, unknown>;
    const document = sanitizeObjectCopy(outer);
    const vars = mergedVars(declared, rewrite.vars, name) ?? declared;
    await writeFile(
      path,
      JSON.stringify(
        {
          ...document,
          name: rewrite.script,
          ...(rewrite.noBundle === true ? { no_bundle: true } : {}),
          ...(vars === undefined ? {} : { vars }),
        },
        null,
        2,
      ),
      "utf8",
    );
    return path;
  }

  throw new ScafoError("invalid-input", "Artifact carries no runtime config", {
    detail: `the archive has none of ${CONFIG_NAMES.join(", ")} at its root`,
  });
}

/**
 * The variables the config is written with: the artifact's own and the carried
 * ones together, or nothing to rewrite when the deploy carries none.
 *
 * A name both sides declare is refused rather than resolved. Either could
 * plausibly be the one that meant it, and a silent winner is a variable whose
 * value depends on which half of the deploy a reader happens to be looking at.
 *
 * Declared values are copied across untouched, whatever their JSON type: what
 * the config's author wrote for the runtime is not this seam's to reinterpret.
 */
function mergedVars(
  declared: unknown,
  carried: Record<string, string> | undefined,
  file: string,
): Record<string, unknown> | undefined {
  if (carried === undefined) return undefined;
  if (declared === undefined) return { ...carried };

  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) {
    throw new ScafoError("invalid-input", "Artifact config variables are not an object", {
      detail:
        `"${file}" must hold "vars" as an object of variable names and values, such as ` +
        `{"APP_VERSION": "v1"}`,
    });
  }

  const entries = Object.entries(declared as Record<string, unknown>);
  for (const [name] of entries) {
    if (!RESERVED_ENV_NAMES.includes(name)) continue;
    throw new ScafoError("invalid-input", "Invalid artifact config variable name", {
      detail:
        `"${file}" declares "${name}", which every object answers for on its own, so the ` +
        `application would read back something JavaScript put there; rename it`,
    });
  }

  const both = entries.map(([name]) => name).filter((name) => Object.hasOwn(carried, name));
  if (both.length > 0) {
    throw new ScafoError("invalid-input", "Variable declared twice", {
      detail:
        `"${file}" and the environment's varset both declare ` +
        `${both.map((name) => `"${name}"`).join(", ")}; one of the two has to drop ` +
        `${both.length === 1 ? "it" : "them"}`,
    });
  }

  return Object.fromEntries([...entries, ...Object.entries(carried)]);
}

/** Runs a publish and retains bounded stdout/stderr for failure diagnostics. */
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
    const stdout = new ByteTail(DEPLOY_RECORD_BYTES);
    let spawned = false;
    let cancelled = false;
    let spawnFailure: ScafoError | undefined;
    let cleanup: Promise<void> | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      output.push(chunk);
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

    const beginCleanup = (): void => {
      if (!spawned) return;
      cleanup ??= stopProcessGroup(processGroupId(child.pid, command));
      cleanup.catch(() => {});
    };

    const cancel = (): void => {
      cancelled = true;
      /* Whatever the abort reason, no descendant of the publish may outlive it:
         take the group down now, or at spawn when there is not one yet. */
      beginCleanup();
    };
    opts.signal.addEventListener("abort", cancel, { once: true });

    child.once("spawn", () => {
      spawned = true;
      if (cancelled) beginCleanup();
    });

    /* Descendants can retain stdio; begin group teardown at leader exit. */
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
      const version = deployVersion(stdout.bytes());
      if (cancelled) {
        const failure = aborted(opts.signal);
        reject(version === undefined ? failure : afterPublished(version, failure));
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
      const partial =
        version === undefined
          ? ""
          : `celld reported version "${version.toLowerCase()}", so it may already have published; `;
      const prefix = `${partial}"${command} ${args[0] ?? ""}" ${ended}: `;
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

/** Preserves an abort's contract while making a possible completed publish explicit. */
function afterPublished(version: string, failure: ScafoError): ScafoError {
  return new ScafoError(failure.code, failure.message, {
    status: failure.status,
    detail:
      `celld reported version "${version.toLowerCase()}", so it may already have published ` +
      `before the command was stopped`,
    cause: failure,
  });
}

/** Reads the one machine-output record emitted by `celld deploy --json`. */
function deployVersion(bytes: Uint8Array): string | undefined {
  let value: unknown;
  try {
    value = safeJsonParse<unknown>(decodeUtf8Tail(bytes, bytes.byteLength).trim());
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.worker !== "string" ||
    typeof record.location !== "string" ||
    record.dry_run !== false ||
    typeof record.version !== "string" ||
    !VERSION_RE.test(record.version)
  ) {
    return undefined;
  }
  return record.version;
}

function aborted(signal: AbortSignal): ScafoError {
  if (signal.reason instanceof ScafoError) return signal.reason;
  return new ScafoError("lease-lost", "Publish authority was lost", { cause: signal.reason });
}
