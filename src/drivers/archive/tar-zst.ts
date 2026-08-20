/*
 * The artifact format a deploy travels in: a tar of a built project, compressed
 * with zstd. Both ends of the upload — the client that packs a directory and the
 * agent that unpacks it — go through here, so there is one definition of what a
 * `.tar.zst` is.
 */

import { createRequire } from "node:module";
import { promisify } from "node:util";
import { gunzip, zstdCompress, zstdDecompress } from "node:zlib";
import { ScafoError } from "../../core/error.ts";

/*
 * `tar` reaches into `node:fs` and is loaded through a CommonJS require, which
 * keeps it out of the module graph of a bundle that only wants the pure halves
 * of this package.
 */
const require = createRequire(import.meta.url);

/** First bytes of a zstd frame (RFC 8878 §3.1.1). */
const ZSTD_MAGIC: number[] = [0x28, 0xb5, 0x2f, 0xfd];

/** First bytes of a gzip member (RFC 1952 §2.3.1). */
const GZIP_MAGIC: number[] = [0x1f, 0x8b];

const gunzipAsync = promisify(gunzip);
const compressAsync = promisify(zstdCompress);
const decompressAsync = promisify(zstdDecompress);

/** Minimal surface of the `tar` package this module uses. */
interface TarModule {
  create(
    opts: { cwd: string; portable: boolean; gzip: false },
    entries: string[],
  ): AsyncIterable<Buffer>;
  extract(opts: { cwd: string }): NodeJS.WritableStream;
}

/**
 * Packs everything under `dir` into a `.tar.zst`.
 *
 * Paths inside the archive are relative to `dir`, so unpacking it somewhere else
 * reproduces the directory's contents and not the directory itself.
 */
export async function packDirectory(dir: string): Promise<Uint8Array> {
  const tar = require("tar") as TarModule;
  const chunks: Buffer[] = [];

  /* `portable` drops the uid, gid and device numbers of the machine that packed
     it: an artifact must not carry the identity of the developer's laptop into
     the node that unpacks it. */
  for await (const chunk of tar.create({ cwd: dir, portable: true, gzip: false }, ["."])) {
    chunks.push(chunk);
  }
  return new Uint8Array(await compressAsync(Buffer.concat(chunks)));
}

/**
 * Unpacks an artifact into `dir`, which must already exist.
 *
 * zstd and gzip are both accepted and told apart by their magic bytes rather
 * than by any name the upload carried, so a client that compressed the archive
 * the other way still deploys. Entries that would escape `dir` — absolute paths,
 * `..` segments — are refused by the reader; nothing is ever written outside it.
 *
 * Throws `ScafoError("invalid-input")` when the bytes are neither compression,
 * or when what they decompress to is not a tar.
 */
export async function unpackArchive(archive: Uint8Array, dir: string): Promise<void> {
  const tar = require("tar") as TarModule;
  /*
   * A `Buffer`, and never a bare `Uint8Array`: the tar reader accepts one
   * without complaint and then reads nothing but zeroes out of it, which
   * surfaces much later as an archive in no recognizable format.
   */
  const bytes = await decompress(archive);

  await new Promise<void>((resolve, reject) => {
    const unpack = tar.extract({ cwd: dir });
    unpack.on("error", (error: Error) => {
      reject(
        new ScafoError("invalid-input", "Artifact is not a readable archive", {
          detail: "the decompressed bytes could not be read as a tar",
          cause: error,
        }),
      );
    });
    unpack.on("close", () => resolve());
    unpack.end(bytes);
  });
}

/** Decompresses an artifact, choosing the algorithm by its magic bytes. */
async function decompress(archive: Uint8Array): Promise<Buffer> {
  const failed = (detail: string, cause?: unknown): ScafoError =>
    new ScafoError("invalid-input", "Artifact is not a readable archive", { detail, cause });

  const inflate = startsWith(archive, ZSTD_MAGIC)
    ? decompressAsync
    : startsWith(archive, GZIP_MAGIC)
      ? gunzipAsync
      : null;

  if (inflate === null) {
    throw failed("the upload begins with neither a zstd frame nor a gzip member");
  }
  try {
    return await inflate(archive);
  } catch (error) {
    throw failed("the compressed stream is truncated or corrupt", error);
  }
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
}
