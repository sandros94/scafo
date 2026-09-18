/*
 * The artifact format, packed and unpacked by the same code the client and the daemon use. A
 * round trip is the whole contract: what a client packs is what the node that unpacks it must
 * see, byte for byte.
 */

import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import {
  packDirectory,
  unpackArchive,
  type UnpackArchiveOptions,
} from "../src/drivers/archive/tar-zst.ts";
import type { StagedArtifact } from "../src/core/types/deploy.ts";
import { rejectsWith } from "./_helpers.ts";

const CONFIG = '{ "name": "demo" /* the app */ }';
const ENTRY = "export default { fetch: () => new Response('hi') };";

let source: string;

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), "scafo-pack-"));
  await writeFile(join(source, "wrangler.jsonc"), CONFIG);
  await writeFile(join(source, "index.mjs"), ENTRY);
  await mkdir(join(source, "assets"));
  await writeFile(join(source, "assets", "logo.svg"), "<svg/>");
});

describe("a directory packed and unpacked again", () => {
  it("arrives with the same files and the same contents", async () => {
    const archive = await packDirectory(source);
    const dest = await scratch();

    try {
      await unpackArchive(archive, dest);
    } finally {
      await archive.dispose();
    }

    /* The directory's contents, not the directory itself: paths inside the
       archive are relative to what was packed. */
    expect((await readdir(dest)).sort()).toEqual(["assets", "index.mjs", "wrangler.jsonc"]);
    await expect(readFile(join(dest, "wrangler.jsonc"), "utf8")).resolves.toBe(CONFIG);
    await expect(readFile(join(dest, "assets", "logo.svg"), "utf8")).resolves.toBe("<svg/>");
  });

  it("is a zstd frame, which is what the artifact key promises", async () => {
    const archive = await packDirectory(source);
    const bytes = await bytesOf(archive);
    const magic = Array.from(bytes.subarray(0, 4));
    await archive.dispose();

    expect(archive.byteLength).toBe(bytes.byteLength);
    expect(magic).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
  });
});

describe("one root file substituted as the directory is packed", () => {
  const EDITED = '{"name":"demo","no_bundle":true}';

  it("archives the substituted bytes and leaves every other entry alone", async () => {
    const archive = await packDirectory(source, {
      substitute: { name: "wrangler.jsonc", contents: EDITED },
    });
    const dest = await scratch();

    try {
      await unpackArchive(archive, dest);
    } finally {
      await archive.dispose();
    }

    expect((await readdir(dest)).sort()).toEqual(["assets", "index.mjs", "wrangler.jsonc"]);
    await expect(readFile(join(dest, "wrangler.jsonc"), "utf8")).resolves.toBe(EDITED);
    await expect(readFile(join(dest, "index.mjs"), "utf8")).resolves.toBe(ENTRY);
    await expect(readFile(join(dest, "assets", "logo.svg"), "utf8")).resolves.toBe("<svg/>");
  });

  it("writes nothing into the directory it packed", async () => {
    const archive = await packDirectory(source, {
      substitute: { name: "wrangler.jsonc", contents: EDITED },
    });
    await archive.dispose();

    await expect(readFile(join(source, "wrangler.jsonc"), "utf8")).resolves.toBe(CONFIG);
  });

  it("gives the substituted entry the portable mode every other file gets", async () => {
    const substituted = await packDirectory(source, {
      substitute: { name: "wrangler.jsonc", contents: EDITED },
    });
    const dest = await scratch();

    try {
      await unpackArchive(substituted, dest);
    } finally {
      await substituted.dispose();
    }

    const config = await stat(join(dest, "wrangler.jsonc"));
    const entry = await stat(join(dest, "index.mjs"));
    expect(config.mode & 0o777).toBe(entry.mode & 0o777);
  });

  it("carries the file byte for byte when nothing is substituted", async () => {
    const archive = await packDirectory(source);
    const dest = await scratch();

    try {
      await unpackArchive(archive, dest);
    } finally {
      await archive.dispose();
    }

    await expect(readFile(join(dest, "wrangler.jsonc"), "utf8")).resolves.toBe(CONFIG);
  });
});

describe("compression the upload chose for itself", () => {
  it("reads a gzipped tar just as happily, going by the bytes and not the name", async () => {
    /* Recompressed from the tar inside a real artifact, so this is the same
       archive arriving under the other compression a client might pick. */
    const { zstdDecompressSync } = await import("node:zlib");
    const packed = await packDirectory(source);
    const tarBytes = zstdDecompressSync(await bytesOf(packed));
    await packed.dispose();
    const dest = await scratch();

    await unpackArchive(stagedOf(new Uint8Array(gzipSync(tarBytes))), dest);

    await expect(readFile(join(dest, "index.mjs"), "utf8")).resolves.toBe(ENTRY);
  });
});

describe("archive resource limits", () => {
  it.each(["maxBytes", "maxEntries"] as const)(
    "refuses every non-positive-safe-integer %s before opening the artifact",
    async (field) => {
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
        let opens = 0;
        const artifact: StagedArtifact = {
          byteLength: 0,
          open: () => {
            opens += 1;
            return stagedOf(new Uint8Array()).open();
          },
          dispose: () => Promise.resolve(),
        };
        const options = { [field]: value } as unknown as UnpackArchiveOptions;

        await expect(unpackArchive(artifact, await scratch(), options)).rejects.toMatchObject({
          code: "invalid-input",
          detail: expect.stringContaining("positive safe integer"),
        });
        expect(opens, `${field}=${String(value)}`).toBe(0);
      }
    },
  );

  it("accepts the positive safe-integer endpoints through the direct API", async () => {
    const packed = await packDirectory(source);

    await expect(
      unpackArchive(packed, await scratch(), {
        maxBytes: Number.MAX_SAFE_INTEGER,
        maxEntries: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBeUndefined();
    await packed.dispose();
  });

  it.each(["zstd", "gzip"] as const)(
    "%s accepts the exact expanded-byte cap and refuses one byte less",
    async (compression) => {
      const packed = await packDirectory(source);
      const zstd = await bytesOf(packed);
      await packed.dispose();
      const { zstdDecompressSync } = await import("node:zlib");
      const tar = new Uint8Array(zstdDecompressSync(zstd));
      const compressed = compression === "zstd" ? zstd : new Uint8Array(gzipSync(tar));

      await expect(
        unpackArchive(stagedOf(compressed), await scratch(), { maxBytes: tar.byteLength }),
      ).resolves.toBeUndefined();
      await expect(
        unpackArchive(stagedOf(compressed), await scratch(), { maxBytes: tar.byteLength - 1 }),
      ).rejects.toMatchObject({ code: "resource-limit", status: 413 });
    },
  );

  it.each(["zstd", "gzip"] as const)(
    "%s accepts the exact entry cap and refuses one entry less",
    async (compression) => {
      const packed = await packDirectory(source);
      const zstd = await bytesOf(packed);
      await packed.dispose();
      const { zstdDecompressSync } = await import("node:zlib");
      const compressed =
        compression === "zstd" ? zstd : new Uint8Array(gzipSync(zstdDecompressSync(zstd)));

      await expect(
        unpackArchive(stagedOf(compressed), await scratch(), { maxEntries: 5 }),
      ).resolves.toBeUndefined();
      await expect(
        unpackArchive(stagedOf(compressed), await scratch(), { maxEntries: 4 }),
      ).rejects.toMatchObject({ code: "resource-limit", status: 413 });
    },
  );
});

describe("what is not an artifact", () => {
  it("cancels a pending magic read promptly and releases its reader", async () => {
    const controller = new AbortController();
    const reason = new ScafoError("lease-lost", "Publish authority was lost");
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
      cancel(value): void {
        cancelled = value;
      },
    });
    const artifact: StagedArtifact = {
      byteLength: 0,
      open: () => stream,
      dispose: () => Promise.resolve(),
    };
    const running = unpackArchive(artifact, await scratch(), { signal: controller.signal });
    await Promise.resolve();

    controller.abort(reason);

    await expect(
      Promise.race([
        running,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("magic read did not cancel")), 100),
        ),
      ]),
    ).rejects.toBe(reason);
    expect(cancelled).toBe(reason);
    expect(stream.locked).toBe(false);
  });

  it("refuses bytes compressed with neither", async () => {
    const dest = await scratch();

    const error = await rejectsWith(
      () => unpackArchive(stagedOf(new TextEncoder().encode("not compressed at all")), dest),
      "invalid-input",
    );

    expect(error.detail).toContain("neither a zstd frame nor a gzip member");
  });

  it("refuses a compressed stream that was cut short", async () => {
    const archive = await packDirectory(source);
    const bytes = await bytesOf(archive);
    await archive.dispose();
    const dest = await scratch();

    /* A cut-short frame does not always fail as decompression — it can yield the
       part of the archive that did arrive, which is then refused as the
       incomplete tar it is. Either way nothing is written. */
    const error = await rejectsWith(
      () => unpackArchive(stagedOf(bytes.slice(0, 20)), dest),
      "invalid-input",
    );

    expect(error.message).toBe("Artifact is not a readable archive");
    expect(await readdir(dest)).toEqual([]);
  });

  it("refuses a gzip member that was cut short", async () => {
    const packed = await packDirectory(source);
    const { zstdDecompressSync } = await import("node:zlib");
    const gzip = new Uint8Array(gzipSync(zstdDecompressSync(await bytesOf(packed))));
    await packed.dispose();

    await expect(
      unpackArchive(stagedOf(gzip.slice(0, Math.floor(gzip.length / 2))), await scratch()),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });

  it("refuses compressed bytes that are not a tar", async () => {
    const dest = await scratch();

    const error = await rejectsWith(
      () =>
        unpackArchive(stagedOf(new Uint8Array(gzipSync(Buffer.from("hello, not a tar")))), dest),
      "invalid-input",
    );

    expect(error.detail).toContain("could not be read as a tar");
    expect(await readdir(dest)).toEqual([]);
  });
});

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scafo-unpack-"));
}

function stagedOf(bytes: Uint8Array): StagedArtifact {
  return {
    byteLength: bytes.byteLength,
    open: () => new Blob([bytes as BlobPart]).stream(),
    dispose: () => Promise.resolve(),
  };
}

async function bytesOf(artifact: StagedArtifact): Promise<Uint8Array> {
  return new Uint8Array(await new Response(artifact.open()).arrayBuffer());
}
