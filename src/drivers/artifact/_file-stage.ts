import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { StagedArtifact } from "../../core/types/deploy.ts";

export interface FileStage {
  path: string;
  file: FileHandle;
  artifact(byteLength: number): StagedArtifact;
  dispose(): Promise<void>;
}

interface FileStageOptions {
  stagingDir?: string;
  remove?: typeof rm;
}

/** Allocates one exclusive file and the staged-artifact handle that owns it. */
export async function createFileStage(options: FileStageOptions = {}): Promise<FileStage> {
  const remove = options.remove ?? rm;
  const dir = await mkdtemp(join(options.stagingDir ?? tmpdir(), "scafo-artifact-"));
  const path = join(dir, "artifact.tar.zst");
  let disposed = false;
  let disposing: Promise<void> | undefined;

  try {
    const file = await open(path, "wx", 0o600);
    const dispose = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (disposing !== undefined) return disposing;
      const attempt = Promise.resolve().then(() => remove(dir, { recursive: true, force: true }));
      disposing = attempt;
      void attempt.then(
        () => {
          disposed = true;
        },
        () => {
          disposing = undefined;
        },
      );
      return attempt;
    };
    return {
      path,
      file,
      dispose,
      artifact(byteLength): StagedArtifact {
        return {
          byteLength,
          open(): ReadableStream<Uint8Array> {
            return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
          },
          dispose,
        };
      },
    };
  } catch (error) {
    await remove(dir, { recursive: true, force: true });
    throw error;
  }
}
