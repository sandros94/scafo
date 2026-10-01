/*
 * The artifact format, packed and unpacked by the same code the client and the daemon use. A
 * round trip is the whole contract: what a client packs is what the node that unpacks it must
 * see, byte for byte.
 */

import { gzipSync, zstdCompressSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header, type HeaderData } from "tar";
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

describe("an entry that would land outside the destination", () => {
  /* Larger than one decompressed chunk (16 KiB), so the parser pushes back and
     the entry after it arrives on a later turn of the event loop, outside any
     caller's try/catch — the shape that used to take the whole process down. */
  const BODY = new Uint8Array(64 * 1024).fill(7);

  it.each([
    {
      refused: "a link to an absolute path",
      entry: (root: string) => link("bin/python", join(root, "escaped")),
      names: (root: string) => ["bin/python", join(root, "escaped")],
    },
    {
      refused: "a link that climbs out",
      entry: () => link("bin/python", "../../escaped"),
      names: () => ["bin/python", "../../escaped"],
    },
    {
      refused: "a path that climbs out",
      entry: () => file("../escaped", "outside"),
      names: () => ["../escaped"],
    },
    {
      refused: "an absolute path",
      entry: (root: string) => file(join(root, "escaped"), "outside"),
      names: (root: string) => [join(root, "escaped")],
    },
  ])("refuses $refused after a large body, naming the entry", async ({ entry, names }) => {
    const root = await scratch();
    const dest = join(root, "dest");
    await mkdir(dest);
    const archive = zstdOf([file("big.bin", BODY), entry(root), file("after.txt", "after")]);

    const error = await rejectsWith(() => unpackArchive(archive, dest), "invalid-input");

    for (const name of names(root)) expect(error.detail).toContain(JSON.stringify(name));
    expect(await readdir(root)).toEqual(["dest"]);
    /* What came before the refusal was finished, not abandoned mid-write; what
       came after it was never written. */
    expect((await readdir(dest)).sort()).toEqual(["big.bin"]);
    expect((await stat(join(dest, "big.bin"))).size).toBe(BODY.byteLength);
  });

  it("refuses the same entry at the very start of the archive", async () => {
    const root = await scratch();
    const dest = join(root, "dest");
    await mkdir(dest);
    const archive = zstdOf([link("bin/python", "/usr/bin/python3"), file("big.bin", BODY)]);

    const error = await rejectsWith(() => unpackArchive(archive, dest), "invalid-input");

    expect(error.detail).toContain('"bin/python"');
    expect(error.detail).toContain('"/usr/bin/python3"');
    expect(await readdir(dest)).toEqual([]);
  });

  it("refuses an entry past the entry cap after a large body", async () => {
    const dest = await scratch();
    const archive = zstdOf([file("big.bin", BODY), file("a.txt", "a"), file("b.txt", "b")]);

    await expect(unpackArchive(archive, dest, { maxEntries: 2 })).rejects.toMatchObject({
      code: "resource-limit",
      status: 413,
    });
    expect((await readdir(dest)).sort()).toEqual(["a.txt", "big.bin"]);
  });
});

describe("a link judged by where it lands, not by its text", () => {
  it("unpacks a symlink that climbs to a sibling inside the destination, and the link works", async () => {
    const dest = await scratch();
    const archive = zstdOf([
      file("node_modules/pkg/bin/x", "#!/bin/sh\necho x\n"),
      link("node_modules/.bin/x", "../pkg/bin/x"),
    ]);

    await unpackArchive(archive, dest);

    expect(await readFile(join(dest, "node_modules/.bin/x"), "utf8")).toBe("#!/bin/sh\necho x\n");
  });

  it.each([
    { refused: "a nested symlink that climbs past the root", path: "a/b", linkpath: "../../x" },
    { refused: "a root symlink that climbs at all", path: "a", linkpath: "../x" },
    { refused: "a symlink that climbs out and back in", path: "a/b", linkpath: "../../dest/x" },
  ])("refuses $refused, naming the entry and its target", async ({ path, linkpath }) => {
    const root = await scratch();
    const dest = join(root, "dest");
    await mkdir(dest);

    const error = await rejectsWith(
      () => unpackArchive(zstdOf([link(path, linkpath)]), dest),
      "invalid-input",
    );

    expect(error.detail).toContain(JSON.stringify(path));
    expect(error.detail).toContain(JSON.stringify(linkpath));
    expect(error.detail).toContain("outside the extraction directory");
    expect(await readdir(root)).toEqual(["dest"]);
  });

  it("refuses an entry written through a symlink it climbed with, which tar guards", async () => {
    const root = await scratch();
    const dest = join(root, "dest");
    await mkdir(dest);
    /* `a/b` lands on the root itself, so `a/b/c` reads as one level deeper than
       it is: from the root, `../..` leaves it. */
    const archive = zstdOf([link("a/b", ".."), link("a/b/c", "../.."), file("after.txt", "x")]);

    await rejectsWith(() => unpackArchive(archive, dest), "invalid-input");
    expect(await readdir(root)).toEqual(["dest"]);
    expect(existsSync(join(dest, "c"))).toBe(false);
  });

  it("unpacks a hard link, whose target names a path from the archive root", async () => {
    const dest = await scratch();
    const archive = zstdOf([file("a/f", "shared"), hardlink("a/b/h", "a/f")]);

    await unpackArchive(archive, dest);

    expect(await readFile(join(dest, "a/b/h"), "utf8")).toBe("shared");
    expect((await stat(join(dest, "a/b/h"))).ino).toBe((await stat(join(dest, "a/f"))).ino);
  });

  it.each([
    { refused: "a hard link that climbs out of the root", path: "h", linkpath: "../x" },
    /* Read from its own directory this lands on `f`, inside; a hard link's
       target is read from the root, where it climbs out. */
    {
      refused: "a hard link read from the root, not its own directory",
      path: "a/h",
      linkpath: "../f",
    },
    { refused: "a hard link to an absolute path", path: "h", linkpath: "/etc/passwd" },
  ])("refuses $refused, naming the entry and its target", async ({ path, linkpath }) => {
    const root = await scratch();
    const dest = join(root, "dest");
    await mkdir(dest);
    const archive = zstdOf([file("f", "inside"), hardlink(path, linkpath)]);

    const error = await rejectsWith(() => unpackArchive(archive, dest), "invalid-input");

    expect(error.detail).toContain(JSON.stringify(path));
    expect(error.detail).toContain(JSON.stringify(linkpath));
    expect(error.detail).toContain("outside the extraction directory");
    expect(await readdir(root)).toEqual(["dest"]);
  });
});

describe("an unpack that fails part way through a file", () => {
  /* Incompressible and well past one decompressed chunk, so a cut in the
     compressed bytes lands inside the body with the file already open. */
  const BODY = noise(1024 * 1024);
  const TAR = tarOf([file("big.bin", BODY)]);
  const ZSTD = new Uint8Array(zstdCompressSync(TAR));
  const RUNS = 5;

  const failures: Record<string, (dest: string) => Promise<unknown>> = {
    "the expanded-byte cap": (dest) =>
      unpackArchive(stagedOf(ZSTD), dest, { maxBytes: BODY.byteLength / 4 }),
    "the abort signal": (dest) => {
      const controller = new AbortController();
      return unpackArchive(abortedMidBody(ZSTD, join(dest, "big.bin"), controller), dest, {
        signal: controller.signal,
      });
    },
    "a truncated zstd frame": (dest) =>
      unpackArchive(stagedOf(ZSTD.slice(0, ZSTD.byteLength / 2)), dest),
    "a corrupt zstd frame": (dest) => {
      const corrupt = ZSTD.slice();
      corrupt.fill(0xff, corrupt.byteLength / 2);
      return unpackArchive(stagedOf(corrupt), dest);
    },
  };

  it.skipIf(!existsSync("/proc/self/fd")).each(Object.keys(failures))(
    "holds no file open once it has rejected on %s",
    async (kind) => {
      const fail = failures[kind]!;
      const before = openFds();

      for (let run = 0; run < RUNS; run += 1) {
        await expect(fail(await scratch())).rejects.toBeInstanceOf(ScafoError);
      }

      expect(openFds(), `${kind}, ${String(RUNS)} runs`).toBe(before);
    },
  );

  it.each([
    { destination: "a file", make: (path: string) => writeFile(path, "") },
    { destination: "missing", make: () => Promise.resolve() },
  ])("settles as the node's own failure when the destination is $destination", async ({ make }) => {
    const notADirectory = join(await scratch(), "dest");
    await make(notADirectory);

    const error = await rejectsWith(() => unpackArchive(stagedOf(ZSTD), notADirectory), "internal");

    expect(error.status).toBe(500);
    expect(error.detail).toContain(JSON.stringify(notADirectory));
  });
});

describe("an entry the unpacker could not write as it was archived", () => {
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)(
    "fails as the node's own failure, naming the entry and the system code",
    async () => {
      const dest = await scratch();
      await mkdir(join(dest, "ro"), { mode: 0o555 });
      /* Where /proc is missing, the descriptors go uncounted. */
      const fds = existsSync("/proc/self/fd") ? openFds : () => 0;
      const before = fds();

      const error = await rejectsWith(
        () => unpackArchive(zstdOf([file("ro/f.txt", "x"), file("after.txt", "after")]), dest),
        "internal",
      );

      expect(error.status).toBe(500);
      expect(error.detail).toContain('"ro/f.txt"');
      expect(error.detail).toContain("EACCES");
      expect(fds()).toBe(before);
    },
  );

  it("refuses a header whose checksum does not hold", async () => {
    const [header, body] = file("x.txt", "x");
    const broken = header!.slice();
    broken[0] = "y".charCodeAt(0);

    const dest = await scratch();

    const error = await rejectsWith(
      () => unpackArchive(zstdOf([file("a.txt", "a"), [broken, body!]]), dest),
      "invalid-input",
    );

    expect(error.detail).toContain("checksum");
  });

  it("refuses an entry that conflicts with an earlier one", async () => {
    const dest = await scratch();

    const error = await rejectsWith(
      () => unpackArchive(zstdOf([file("a", "a"), file("a/b", "b")]), dest),
      "invalid-input",
    );

    expect(error.detail).toContain('"a/b"');
    expect(error.detail).toContain("conflicts with an earlier entry");
  });

  it("refuses an entry kind it cannot write, which would leave its contents behind", async () => {
    const dest = await scratch();

    const error = await rejectsWith(
      () =>
        unpackArchive(
          zstdOf([
            [
              headerOf({ path: "sparse.bin", type: "SparseFile", mode: 0o644, size: 512 }),
              new Uint8Array(512),
            ],
          ]),
          dest,
        ),
      "invalid-input",
    );

    expect(error.detail).toContain('"sparse.bin"');
    expect(error.detail).toContain("SparseFile");
  });

  it("skips a FIFO, which has no contents to leave behind", async () => {
    const dest = await scratch();

    await unpackArchive(
      zstdOf([
        [headerOf({ path: "pipe", type: "FIFO", mode: 0o644, size: 0 })],
        file("a.txt", "a"),
      ]),
      dest,
    );

    expect(await readdir(dest)).toEqual(["a.txt"]);
  });
});

describe("a directory holding what an artifact cannot carry", () => {
  const mkfifo = process.platform !== "win32";

  it.skipIf(!mkfifo).each([
    { packed: "as it is", opts: {} },
    {
      packed: "with a file substituted",
      opts: { substitute: { name: "wrangler.jsonc", contents: "{}" } },
    },
  ])("packs its files intact past a FIFO, $packed", async ({ opts }) => {
    /* A hard link defers its target's body, which is when a FIFO's entry used to
       end out of turn and take another entry's place in the packer's queue. */
    linkSync(join(source, "index.mjs"), join(source, "hard.mjs"));
    execFileSync("mkfifo", [join(source, "pipe")]);
    const archive = await packDirectory(source, opts);
    const dest = await scratch();

    try {
      await unpackArchive(archive, dest);
    } finally {
      await archive.dispose();
    }

    expect((await readdir(dest)).sort()).toEqual([
      "assets",
      "hard.mjs",
      "index.mjs",
      "wrangler.jsonc",
    ]);
    await expect(readFile(join(dest, "index.mjs"), "utf8")).resolves.toBe(ENTRY);
    await expect(readFile(join(dest, "hard.mjs"), "utf8")).resolves.toBe(ENTRY);
  });
});

describe("a tar compressed twice", () => {
  /* The tar parser would undo a second layer by itself, past the meter: a 1 MiB
     cap would let this one write 32 MiB. The noise keeps it under the parser's
     own 1000:1 ratio check, which is no cap at all. */
  const TAR = tarOf([
    file("noise.bin", noise(256 * 1024)),
    file("big.bin", new Uint8Array(32 * 1024 * 1024)),
  ]);

  it.each([
    { inner: "gzip", bytes: () => gzipSync(TAR) },
    { inner: "zstd", bytes: () => zstdCompressSync(TAR) },
  ])("refuses $inner inside the artifact's own compression", async ({ bytes }) => {
    const dest = await scratch();
    const twice = stagedOf(new Uint8Array(zstdCompressSync(bytes())));

    const error = await rejectsWith(
      () => unpackArchive(twice, dest, { maxBytes: 1024 * 1024 }),
      "invalid-input",
    );

    expect(error.detail).toContain("compressed again");
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

function file(path: string, body: string | Uint8Array): Uint8Array[] {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return [headerOf({ path, type: "File", mode: 0o644, size: bytes.byteLength }), padded(bytes)];
}

function link(path: string, linkpath: string): Uint8Array[] {
  return [headerOf({ path, type: "SymbolicLink", mode: 0o777, size: 0, linkpath })];
}

function hardlink(path: string, linkpath: string): Uint8Array[] {
  return [headerOf({ path, type: "Link", mode: 0o644, size: 0, linkpath })];
}

function headerOf(data: HeaderData): Uint8Array {
  const header = new Header({ ...data, mtime: new Date(0) });
  header.encode();
  return new Uint8Array(header.block ?? []);
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.byteLength / 512) * 512);
  out.set(bytes);
  return out;
}

/* A tar written block by block, so a test controls entry order and names that
   no directory on disk could hold. */
function tarOf(entries: Uint8Array[][]): Buffer {
  return Buffer.concat([...entries.flat(), new Uint8Array(1024)]);
}

function zstdOf(entries: Uint8Array[][]): StagedArtifact {
  return stagedOf(new Uint8Array(zstdCompressSync(tarOf(entries))));
}

/** Deterministic bytes no compressor can shrink (xorshift32). */
function noise(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = 0x9e3779b9;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 0xff;
  }
  return out;
}

function openFds(): number {
  return readdirSync("/proc/self/fd").length;
}

/**
 * The first half of `bytes`, then — once the unpacker has opened `opened` — the
 * signal aborted while the source is still waiting for the rest. The magic read
 * opens the artifact too, and is served the first half alone.
 */
function abortedMidBody(
  bytes: Uint8Array,
  opened: string,
  controller: AbortController,
): StagedArtifact {
  const half = bytes.subarray(0, bytes.byteLength / 2);
  return {
    byteLength: bytes.byteLength,
    open: () => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        async pull(stream): Promise<void> {
          if (!sent) {
            sent = true;
            stream.enqueue(half);
            return;
          }
          while (!existsSync(opened)) await new Promise((resolve) => setImmediate(resolve));
          controller.abort(new ScafoError("lease-lost", "Publish authority was lost"));
          await new Promise<never>(() => {});
        },
      });
    },
    dispose: () => Promise.resolve(),
  };
}
