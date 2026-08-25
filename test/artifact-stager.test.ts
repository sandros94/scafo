import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileStage } from "../src/drivers/artifact/_file-stage.ts";
import { createFileArtifactStager } from "../src/drivers/artifact/file.ts";

describe("the file-backed artifact receive", () => {
  it("refuses every non-positive-safe-integer cap before allocating a file", async () => {
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
      const staging = await scratch();
      let failure: unknown;
      let staged:
        | Awaited<ReturnType<ReturnType<typeof createFileArtifactStager>["stage"]>>
        | undefined;
      try {
        staged = await createFileArtifactStager({ stagingDir: staging }).stage(chunks([]), {
          maxBytes: value as number,
          signal: new AbortController().signal,
        });
      } catch (error) {
        failure = error;
      }
      await staged?.dispose();

      expect(failure, `maxBytes=${String(value)}`).toMatchObject({
        code: "invalid-input",
        detail: expect.stringContaining("positive safe integer"),
      });
      expect(await readdir(staging)).toEqual([]);
    }
  });

  it.each([1, Number.MAX_SAFE_INTEGER])(
    "accepts the positive safe-integer endpoint %s",
    async (maxBytes) => {
      const staging = await scratch();
      const staged = await createFileArtifactStager({ stagingDir: staging }).stage(chunks([1]), {
        maxBytes,
        signal: new AbortController().signal,
      });

      await expect(new Response(staged.open()).arrayBuffer()).resolves.toHaveProperty(
        "byteLength",
        1,
      );
      await staged.dispose();
    },
  );

  it("accepts the exact cap and disposes the handed-off file", async () => {
    const staging = await scratch();
    const staged = await createFileArtifactStager({ stagingDir: staging }).stage(chunks([2, 3]), {
      maxBytes: 5,
      signal: new AbortController().signal,
    });

    expect(staged.byteLength).toBe(5);
    await expect(new Response(staged.open()).arrayBuffer()).resolves.toHaveProperty(
      "byteLength",
      5,
    );
    expect(await readdir(staging)).toHaveLength(1);
    await staged.dispose();
    expect(await readdir(staging)).toEqual([]);
  });

  it("checks the cap before a chunk is written and removes the partial file", async () => {
    const staging = await scratch();

    await expect(
      createFileArtifactStager({ stagingDir: staging }).stage(chunks([3, 3]), {
        maxBytes: 5,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "resource-limit", status: 413 });
    expect(await readdir(staging)).toEqual([]);
  });

  it("cancels mid-receive and removes the partial file", async () => {
    const staging = await scratch();
    const controller = new AbortController();
    let sent = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(stream): void {
        sent += 1;
        stream.enqueue(new Uint8Array(4));
        if (sent === 2) controller.abort(new Error("client left"));
      },
    });

    await expect(
      createFileArtifactStager({ stagingDir: staging }).stage(source, {
        maxBytes: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow("client left");
    expect(await readdir(staging)).toEqual([]);
  });

  it("joins concurrent disposal and retries removal after failure", async () => {
    const staging = await scratch();
    const gate = Promise.withResolvers<void>();
    let attempts = 0;
    const remove = vi.fn(
      async (path: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
        attempts += 1;
        if (attempts === 1) throw new Error("disk busy");
        await gate.promise;
        await rm(path, options);
      },
    );
    const stage = await createFileStage({ stagingDir: staging, remove });
    await stage.file.close();

    await expect(stage.dispose()).rejects.toThrow("disk busy");
    expect(await readdir(staging)).toHaveLength(1);

    const first = stage.dispose();
    const concurrent = stage.dispose();
    expect(concurrent).toBe(first);
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([first, concurrent]);

    expect(await readdir(staging)).toEqual([]);
    await stage.dispose();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scafo-receive-test-"));
  const staging = join(root, "staging");
  await mkdir(staging);
  return staging;
}

function chunks(sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(stream): void {
      for (const size of sizes) stream.enqueue(new Uint8Array(size));
      stream.close();
    },
  });
}
