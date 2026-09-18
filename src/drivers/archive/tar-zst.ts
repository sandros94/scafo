/* The streamed tar+zstd artifact format shared by the CLI and deploy runner. */

import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createZstdCompress, createZstdDecompress } from "node:zlib";
import { isScafoError, ScafoError } from "../../core/error.ts";
import {
  DEFAULT_ARCHIVE_ENTRIES,
  DEFAULT_ARTIFACT_BYTES,
  type StagedArtifact,
} from "../../core/types/deploy.ts";
import { assertPositiveSafeInteger } from "../../core/utils/number.ts";
import { createFileStage } from "../artifact/_file-stage.ts";

const ZSTD_MAGIC: number[] = [0x28, 0xb5, 0x2f, 0xfd];
const GZIP_MAGIC: number[] = [0x1f, 0x8b];

interface TarEntry {
  path: string;
  linkpath?: string;
}

interface TarHeader {
  path: string;
  mode: number;
  size: number;
  type: "File";
  mtime: Date;
}

interface TarReadEntry {
  write(chunk: Uint8Array): unknown;
  end(): unknown;
}

interface TarPack extends NodeJS.ReadableStream {
  add(entry: string | TarReadEntry): unknown;
  end(): unknown;
}

interface TarModule {
  create(
    opts: { cwd: string; portable: boolean; gzip: false },
    entries: string[],
  ): NodeJS.ReadableStream;
  Pack: new (opts: {
    cwd: string;
    portable: boolean;
    gzip: false;
    filter(path: string, entry: unknown): boolean;
  }) => TarPack;
  Header: new (data: TarHeader) => object;
  ReadEntry: new (header: object) => TarReadEntry;
  extract(opts: {
    cwd: string;
    filter(path: string, entry: TarEntry): boolean;
  }): NodeJS.WritableStream;
}

/** One root file of the packed directory, archived with these bytes instead. */
export interface FileSubstitution {
  /** File name at the root of `dir`, such as `wrangler.jsonc`. */
  name: string;
  /** Text archived under that entry; the file on disk is never touched. */
  contents: string;
}

export interface PackDirectoryOptions {
  signal?: AbortSignal;
  /**
   * Archives one root file with different bytes, leaving the directory on disk
   * exactly as it is. The entry keeps its name and the portable mode every other
   * file of the archive gets; nothing else about the archive changes.
   */
  substitute?: FileSubstitution;
}

/** Mode every substituted entry is archived with; `portable` normalizes to it. */
const SUBSTITUTED_MODE = 0o644;

export interface UnpackArchiveOptions {
  maxBytes?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

let loaded: Promise<TarModule> | undefined;

/** Packs a directory into a file-backed `.tar.zst` without aggregating its bytes. */
export async function packDirectory(
  dir: string,
  opts?: PackDirectoryOptions,
): Promise<StagedArtifact> {
  const tar = await loadTar();
  const stage = await createFileStage();
  await stage.file.close();

  try {
    await pipeline(
      opts?.substitute === undefined
        ? tar.create({ cwd: dir, portable: true, gzip: false }, ["."])
        : packSubstituted(tar, dir, opts.substitute),
      createZstdCompress(),
      createWriteStream(stage.path, { flags: "w", mode: 0o600 }),
      ...(opts?.signal === undefined ? [] : [{ signal: opts.signal }]),
    );
    return stage.artifact((await stat(stage.path)).size);
  } catch (error) {
    await stage.dispose();
    throw error;
  }
}

/**
 * The directory, with the substituted file written from memory in place of the
 * one on disk.
 *
 * The replacement is added as a tar entry of its own, under the name the walked
 * file would have had, and the walk's own copy is filtered out so the archive
 * holds exactly one. The two share a path, so the filter tells them apart by
 * what it is handed beside it: the entry itself for one that was added, the
 * file's stat for one the walk found. Entry ORDER is the one thing that differs
 * from an untouched pack, and nothing that reads a tar depends on it.
 */
function packSubstituted(tar: TarModule, dir: string, file: FileSubstitution): TarPack {
  const path = `./${file.name}`;
  const bytes = new TextEncoder().encode(file.contents);
  const pack = new tar.Pack({
    cwd: dir,
    portable: true,
    gzip: false,
    filter: (name, entry) => name !== path || entry instanceof tar.ReadEntry,
  });

  const entry = new tar.ReadEntry(
    new tar.Header({
      path,
      mode: SUBSTITUTED_MODE,
      size: bytes.byteLength,
      type: "File",
      mtime: new Date(),
    }),
  );
  pack.add(entry);
  entry.write(bytes);
  entry.end();

  pack.add(".");
  pack.end();
  return pack;
}

/** Streams a staged zstd or gzip tar into `dir`, enforcing expansion and entry caps. */
export async function unpackArchive(
  archive: StagedArtifact,
  dir: string,
  opts?: UnpackArchiveOptions,
): Promise<void> {
  const maxBytes = opts?.maxBytes === undefined ? DEFAULT_ARTIFACT_BYTES : opts.maxBytes;
  const maxEntries = opts?.maxEntries === undefined ? DEFAULT_ARCHIVE_ENTRIES : opts.maxEntries;
  assertPositiveSafeInteger(maxBytes, "maxBytes");
  assertPositiveSafeInteger(maxEntries, "maxEntries");
  const signal = opts?.signal;
  const magic = await readMagic(archive, signal);
  const kind = startsWith(magic, ZSTD_MAGIC)
    ? "zstd"
    : startsWith(magic, GZIP_MAGIC)
      ? "gzip"
      : null;
  if (kind === null) {
    throw unreadable("the upload begins with neither a zstd frame nor a gzip member");
  }

  const tar = await loadTar();
  const decompressor = kind === "zstd" ? createZstdDecompress() : createGunzip();
  let decompressionFailed = false;
  decompressor.once("error", () => (decompressionFailed = true));
  let entries = 0;
  let extractionFailure: ScafoError | undefined;
  const extract = tar.extract({
    cwd: dir,
    filter(path, entry): boolean {
      try {
        assertArchivePath(path, entry.linkpath);
        entries += 1;
        if (entries > maxEntries) {
          throw new ScafoError("resource-limit", "Artifact has too many entries", {
            detail: `the archive exceeded the ${String(maxEntries)}-entry limit`,
          });
        }
        return true;
      } catch (error) {
        if (isScafoError(error)) extractionFailure = error;
        throw error;
      }
    },
  });
  let expanded = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      const after = expanded + chunk.byteLength;
      if (after > maxBytes) {
        callback(
          new ScafoError("resource-limit", "Artifact expands too large", {
            detail: `the archive exceeded the ${String(maxBytes)}-byte expanded-artifact limit`,
          }),
        );
        return;
      }
      expanded = after;
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(archive.open() as Parameters<typeof Readable.fromWeb>[0]),
      decompressor,
      meter,
      extract,
      ...(signal === undefined ? [] : [{ signal }]),
    );
  } catch (error) {
    if (extractionFailure !== undefined) throw extractionFailure;
    if (isScafoError(error)) throw error;
    throwIfAborted(signal);
    throw unreadable(
      decompressionFailed
        ? "the compressed stream is truncated or corrupt"
        : "the decompressed bytes could not be read as a tar",
      error,
    );
  }
}

async function readMagic(archive: StagedArtifact, signal?: AbortSignal): Promise<Uint8Array> {
  const reader = archive.open().getReader();
  const magic = new Uint8Array(4);
  let offset = 0;
  const cancel = (): void => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (offset < magic.length) {
      throwIfAborted(signal);
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      const take = Math.min(next.value.byteLength, magic.length - offset);
      magic.set(next.value.subarray(0, take), offset);
      offset += take;
    }
    return magic.subarray(0, offset);
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    await reader.cancel(signal?.reason).catch(() => {});
    reader.releaseLock();
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new ScafoError("invalid-input", "Artifact processing was cancelled");
}

function assertArchivePath(path: string, linkpath?: string): void {
  for (const candidate of linkpath === undefined ? [path] : [path, linkpath]) {
    const normalized = candidate.replaceAll("\\", "/");
    if (isAbsolute(normalized) || normalized.split("/").includes("..")) {
      throw unreadable(
        `archive entry ${JSON.stringify(candidate)} escapes the extraction directory`,
      );
    }
  }
}

function unreadable(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Artifact is not a readable archive", { detail, cause });
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((byte, index) => bytes[index] === byte);
}

function loadTar(): Promise<TarModule> {
  loaded ??= import("tar") as Promise<unknown> as Promise<TarModule>;
  return loaded;
}
