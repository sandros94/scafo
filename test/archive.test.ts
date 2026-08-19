/*
 * The artifact format, packed and unpacked by the same code the client and the
 * agent use. A round trip is the whole contract: what a client packs is what the
 * node that unpacks it must see, byte for byte.
 */

import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { packDirectory, unpackArchive } from "../src/drivers/archive/tar-zst.ts";
import { rejectsWith } from "./_helpers.ts";

const CONFIG = '{ "name": "demo" /* the app */ }';
const ENTRY = "export default { fetch: () => new Response('hi') };";

let source: string;

beforeEach(async () => {
  source = await mkdtemp(join(tmpdir(), "scalo-pack-"));
  await writeFile(join(source, "wrangler.jsonc"), CONFIG);
  await writeFile(join(source, "index.mjs"), ENTRY);
  await mkdir(join(source, "assets"));
  await writeFile(join(source, "assets", "logo.svg"), "<svg/>");
});

describe("a directory packed and unpacked again", () => {
  it("arrives with the same files and the same contents", async () => {
    const archive = await packDirectory(source);
    const dest = await scratch();

    await unpackArchive(archive, dest);

    /* The directory's contents, not the directory itself: paths inside the
       archive are relative to what was packed. */
    expect((await readdir(dest)).sort()).toEqual(["assets", "index.mjs", "wrangler.jsonc"]);
    await expect(readFile(join(dest, "wrangler.jsonc"), "utf8")).resolves.toBe(CONFIG);
    await expect(readFile(join(dest, "assets", "logo.svg"), "utf8")).resolves.toBe("<svg/>");
  });

  it("is a zstd frame, which is what the artifact key promises", async () => {
    const archive = await packDirectory(source);
    const magic = Array.from(archive.subarray(0, 4));

    expect(magic).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
  });
});

describe("compression the upload chose for itself", () => {
  it("reads a gzipped tar just as happily, going by the bytes and not the name", async () => {
    /* Recompressed from the tar inside a real artifact, so this is the same
       archive arriving under the other compression a client might pick. */
    const { zstdDecompressSync } = await import("node:zlib");
    const tarBytes = zstdDecompressSync(await packDirectory(source));
    const dest = await scratch();

    await unpackArchive(new Uint8Array(gzipSync(tarBytes)), dest);

    await expect(readFile(join(dest, "index.mjs"), "utf8")).resolves.toBe(ENTRY);
  });
});

describe("what is not an artifact", () => {
  it("refuses bytes compressed with neither", async () => {
    const dest = await scratch();

    const error = await rejectsWith(
      () => unpackArchive(new TextEncoder().encode("not compressed at all"), dest),
      "invalid-input",
    );

    expect(error.detail).toContain("neither a zstd frame nor a gzip member");
  });

  it("refuses a compressed stream that was cut short", async () => {
    const archive = await packDirectory(source);
    const dest = await scratch();

    /* A cut-short frame does not always fail as decompression — it can yield the
       part of the archive that did arrive, which is then refused as the
       incomplete tar it is. Either way nothing is written. */
    const error = await rejectsWith(
      () => unpackArchive(archive.slice(0, 20), dest),
      "invalid-input",
    );

    expect(error.message).toBe("Artifact is not a readable archive");
    expect(await readdir(dest)).toEqual([]);
  });

  it("refuses compressed bytes that are not a tar", async () => {
    const dest = await scratch();

    const error = await rejectsWith(
      () => unpackArchive(new Uint8Array(gzipSync(Buffer.from("hello, not a tar"))), dest),
      "invalid-input",
    );

    expect(error.detail).toContain("could not be read as a tar");
    expect(await readdir(dest)).toEqual([]);
  });
});

function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scalo-unpack-"));
}
