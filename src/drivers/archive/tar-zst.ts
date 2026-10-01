/* The streamed tar+zstd artifact format shared by the CLI and deploy runner. */

import { createWriteStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
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
  type?: string;
}

/** What tar hands a `warn` listener: the error itself, or a record beside a message. */
interface TarWarning {
  code?: string;
  syscall?: string;
  name?: string;
  entry?: TarEntry;
  header?: TarEntry;
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
    opts: {
      cwd: string;
      portable: boolean;
      gzip: false;
      filter(path: string, stat: Stats): boolean;
    },
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
    onwarn(code: string, message: string, data: TarWarning): void;
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
        ? tar.create(
            { cwd: dir, portable: true, gzip: false, filter: (_, stat) => packable(stat) },
            ["."],
          )
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
    filter: (name, entry) =>
      entry instanceof tar.ReadEntry || (name !== path && packable(entry as Stats)),
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

/*
 * Only what an artifact can carry is walked. tar's packer ends the entry of a
 * socket, FIFO or device out of turn, which takes another entry's place in its
 * queue: the archive comes out corrupt, or the pack never finishes.
 */
function packable(stat: Stats): boolean {
  return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
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
  let failure: ScafoError | undefined;
  /*
   * The filter must never throw. It runs inside the parser's write(), and a pipe
   * that sees write() throw answers with a destroy() tar's parser does not have:
   * once the parser has pushed back, that is an uncaught TypeError on a later
   * tick, and the process goes down. The first failure — a refused entry, or one
   * tar could not write, which it reports only as a warning — is recorded
   * instead; every entry after it is skipped, the archive drains through the
   * byte cap, the unpacker finishes the writes already under way, and the
   * failure is raised once the pipeline has settled.
   */
  const extract = tar.extract({
    cwd: dir,
    filter(path, entry): boolean {
      if (failure !== undefined) return false;
      entries += 1;
      failure = refusalOf(path, {
        linkpath: entry.linkpath,
        type: entry.type,
        entries,
        maxEntries,
      });
      return failure === undefined;
    },
    onwarn(code, message, data): void {
      failure ??= warningFailure(code, { message, data });
    },
  });
  const closed = closedOf(extract);
  /* Ignored before any filter sees it: a kind tar does not know, or a header too large to read. */
  extract.on("ignoredEntry", (entry: TarEntry) => {
    failure ??= uncarried(entry);
  });
  extract.on("error", (error: TarWarning & Error) => {
    if (error.name !== "CwdError") return;
    failure ??= new ScafoError("internal", "Artifact could not be unpacked", {
      detail: `the extraction directory ${JSON.stringify(dir)} is missing or not a directory: ${String(error.code)}`,
      cause: error,
    });
  });
  let expanded = 0;
  let head = new Uint8Array(0);
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
      /*
       * tar decompresses a gzip or zstd stream it is handed by itself, past this
       * meter, and aborts in a way that never closes the file it was writing. The
       * first bytes decide it, and they pass through here before tar sees them.
       */
      if (head.byteLength < ZSTD_MAGIC.length) {
        head = new Uint8Array([...head, ...chunk.subarray(0, ZSTD_MAGIC.length - head.byteLength)]);
        if (startsWith(head, GZIP_MAGIC) || startsWith(head, ZSTD_MAGIC)) {
          callback(
            unreadable(
              "the decompressed bytes are compressed again; send one tar, compressed once",
            ),
          );
          return;
        }
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
    /* A failed pipeline leaves tar's unpacker as it was, its file open. Ending
       it closes that file, and the rejection waits for it. What failed first is
       what is raised, not a write the ending cut short. */
    const first = failure;
    extract.end();
    await closed;
    if (first !== undefined) throw first;
    if (isScafoError(error)) throw error;
    throwIfAborted(signal);
    throw unreadable(
      decompressionFailed
        ? "the compressed stream is truncated or corrupt"
        : "the decompressed bytes could not be read as a tar",
      error,
    );
  }
  if (failure !== undefined) throw failure;
}

/**
 * Settles once the unpacker has closed every file it opened: tar emits `end`
 * only after its input has ended and no write is pending. Not `close`, which a
 * failed pipeline emits on a stream it cannot destroy. The one exception is a
 * destination that is not a directory, which tar reports as a `CwdError` before
 * it opens anything, and after which it never ends. Listening for `error` also
 * keeps an error raised by ending it from going unhandled.
 */
function closedOf(extract: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    extract.once("end", () => resolve());
    extract.on("error", (error: Error) => {
      if (error.name === "CwdError") resolve();
    });
  });
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

/** Why the entry at `path`, the `entries`-th of the archive, may not be extracted, if it may not. */
function refusalOf(
  path: string,
  opts: {
    linkpath: string | undefined;
    type: string | undefined;
    entries: number;
    maxEntries: number;
  },
): ScafoError | undefined {
  const { linkpath, type, entries, maxEntries } = opts;
  if (escapes(path)) {
    return unreadable(`archive entry ${JSON.stringify(path)} escapes the extraction directory`);
  }
  if (linkpath !== undefined && linkEscapes(path, { linkpath, type })) {
    return unreadable(
      `archive entry ${JSON.stringify(path)} links to ${JSON.stringify(linkpath)}, outside the extraction directory`,
    );
  }
  if (entries > maxEntries) {
    return new ScafoError("resource-limit", "Artifact has too many entries", {
      detail: `the archive exceeded the ${String(maxEntries)}-entry limit`,
    });
  }
  return undefined;
}

/* Codes a write fails with when the archive itself is at odds with itself. */
const CONFLICTS: ReadonlySet<string> = new Set(["EEXIST", "EISDIR", "ENOTDIR", "ENOTEMPTY"]);
/* Entry kinds tar skips that hold no contents an artifact could miss. */
const CONTENTLESS: ReadonlySet<string> = new Set(["FIFO", "CharacterDevice", "BlockDevice"]);

/**
 * Whether a warning tar raised while unpacking fails it, and whose fault it is:
 * a write this node could not make is the node's (`internal`); anything about
 * the archive's own entries is the archive's (`invalid-input`).
 */
function warningFailure(
  code: string,
  opts: { message: string; data: TarWarning },
): ScafoError | undefined {
  const { message, data } = opts;
  const entry = data.entry ?? data.header;
  const named = nameOf(entry);
  const errno = data.code !== undefined && /^E[A-Z0-9]+$/.test(data.code) ? data.code : undefined;

  if (code === "TAR_ENTRY_INFO") return undefined;
  if (code === "TAR_ENTRY_UNSUPPORTED") {
    return entry !== undefined && CONTENTLESS.has(entry.type ?? "") ? undefined : uncarried(entry);
  }
  if (code !== "TAR_ENTRY_ERROR") return unreadable(`${named} is malformed: ${message}`, data);
  if (errno === undefined) return unreadable(`${named} could not be unpacked: ${message}`, data);
  if (CONFLICTS.has(errno)) {
    return unreadable(`${named} conflicts with an earlier entry: ${errno}`, data);
  }
  return new ScafoError("internal", "Artifact could not be unpacked", {
    detail: `${named} could not be written on this node: ${errno}${data.syscall === undefined ? "" : ` (${data.syscall})`}`,
    cause: data,
  });
}

function nameOf(entry: TarEntry | undefined): string {
  return entry?.path === undefined
    ? "an archive entry"
    : `archive entry ${JSON.stringify(entry.path)}`;
}

function uncarried(entry: TarEntry | undefined): ScafoError {
  const named = nameOf(entry);
  return unreadable(
    `${named} is a ${entry?.type ?? "kind of"} entry, which an artifact cannot carry`,
  );
}

function escapes(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return isAbsolute(normalized) || normalized.split("/").includes("..");
}

/*
 * A symlink's target is read from the directory of the entry that carries it,
 * so `node_modules/.bin/x -> ../pkg/bin/x` lands inside and is kept; only where
 * it resolves to decides. A hard link's target is a path from the archive root,
 * which tar refuses outright once it holds a `..`, so the entry-path rule is
 * the one that applies to it. Writing an entry THROUGH a symlink is tar's own
 * guard (`SymlinkError`), which is what keeps a chain of in-bounds links from
 * adding up to an escape.
 */
function linkEscapes(path: string, opts: { linkpath: string; type: string | undefined }): boolean {
  const { linkpath, type } = opts;
  if (type !== "SymbolicLink") return escapes(linkpath);
  const target = linkpath.replaceAll("\\", "/");
  if (isAbsolute(target)) return true;
  const landed = posix.normalize(posix.join(posix.dirname(path.replaceAll("\\", "/")), target));
  return landed === ".." || landed.startsWith("../");
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
