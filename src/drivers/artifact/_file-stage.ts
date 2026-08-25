import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { StagedArtifact } from "../../core/types/deploy.ts";

export interface FileStage {
  path: string;
  file: FileHandle;
  artifact: StagedArtifact;
  dispose(): Promise<void>;
}

/** Allocates one exclusive file and the staged-artifact handle that owns it. */
export async function createFileStage(stagingDir?: string): Promise<FileStage> {
  const dir = await mkdtemp(join(stagingDir ?? tmpdir(), "scafo-artifact-"));
  const path = join(dir, "artifact.tar.zst");
  let disposed = false;

  try {
    const file = await open(path, "wx", 0o600);
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    };
    return {
      path,
      file,
      dispose,
      artifact: {
        open(): ReadableStream<Uint8Array> {
          return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
        },
        dispose,
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
