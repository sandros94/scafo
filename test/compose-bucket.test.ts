/* The bucket-creation service every compose stack in this repository ships with. */

import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseYAML } from "confbox/yaml";
import { afterAll, describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every stack that makes its own bucket, by the path it lives at. */
const STACKS: string[] = [
  "examples/compose.yaml",
  "playgrounds/single-node/compose.yaml",
  "playgrounds/multi-node/compose.yaml",
];

/** Long enough for a loop that is going to exit to have exited. */
const RUN_TIMEOUT_MS = 3_000;

/** Short, because the assertion it serves is that the loop is still going. */
const SPIN_TIMEOUT_MS = 1_500;

const run = promisify(execFile);
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.each(STACKS)("the bucket service of %s", (stack) => {
  it("creates the bucket on a first run, where the store answers 200", async () => {
    const result = await attempt(stack, "200");

    expect(result.code).toBe(0);
  });

  it("succeeds on every run after the first, where the bucket is already ours", async () => {
    /* `409 BucketAlreadyOwnedByYou`. The bucket exists and belongs to this
       installation, which is the whole of what this service was asked for —
       treating it as a failure is what leaves the node waiting forever. */
    const result = await attempt(stack, "409");

    expect(result.code).toBe(0);
  });

  it("keeps waiting while the store is not answering bucket operations yet", async () => {
    /* The open port is not readiness: SeaweedFS serves its S3 port a good while
       before it will make a bucket on it, and retrying is what stands in for the
       readiness probe the image does not offer. */
    const result = await attempt(stack, "503", SPIN_TIMEOUT_MS);

    expect(result.code).toBeNull();
  });
});

interface Attempt {
  /** Exit status, or null when the loop was still going when time ran out. */
  code: number | null;
  output: string;
}

/** Runs one stack's bucket script against a `curl` that always answers `status`. */
async function attempt(stack: string, status: string, timeout = RUN_TIMEOUT_MS): Promise<Attempt> {
  const script = await bucketScript(join(REPO, stack));
  const bin = await curlStub();

  try {
    const { stdout, stderr } = await run("sh", ["-c", script], {
      timeout,
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, SCAFO_TEST_CURL_STATUS: status },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    return {
      /* A loop that was killed for running out of time never exited at all,
         which is a different answer from one that exited non-zero. */
      code: failure.killed === true ? null : (failure.code ?? 1),
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

/**
 * The shell one stack's `bucket` service runs, as `sh` would see it.
 *
 * Compose expands `$$` to a single `$` before the shell ever sees the script, so
 * that is done here too: a script read straight out of the file would leave the
 * variables unexpanded and pass for reasons that have nothing to do with the
 * store's answer.
 */
async function bucketScript(path: string): Promise<string> {
  const compose = parseYAML<ComposeFile>(await readFile(path, "utf8"));
  const command = compose.services?.bucket?.command;
  if (!Array.isArray(command)) throw new Error(`${path} has no bucket service to run`);

  const script = command.at(-1);
  if (typeof script !== "string") throw new Error(`${path}'s bucket service runs no script`);
  return script.replaceAll("$$", "$");
}

interface ComposeFile {
  services?: Record<string, { command?: unknown } | undefined>;
}

/**
 * A `curl` that answers whatever `SCAFO_TEST_CURL_STATUS` says, and behaves the
 * way the real one does about it: `-w '%{http_code}'` prints the status, and
 * `-f` turns a 4xx or 5xx into a non-zero exit — which is precisely the
 * difference between a loop that accepts a 409 and one that spins on it.
 */
async function curlStub(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scafo-curl-stub-"));
  dirs.push(dir);

  const path = join(dir, "curl");
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'status="${SCAFO_TEST_CURL_STATUS:-200}"',
      "fail=0",
      "write=0",
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    --fail) fail=1 ;;",
      "    --*) ;;",
      "    -*f*) fail=1 ;;",
      "    '%{http_code}') write=1 ;;",
      "  esac",
      "done",
      '[ "$write" = 1 ] && printf %s "$status"',
      'if [ "$fail" = 1 ] && [ "$status" -ge 400 ]; then exit 22; fi',
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
  return dir;
}
