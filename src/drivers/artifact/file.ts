import { ScafoError } from "../../core/error.ts";
import type {
  ArtifactStager,
  ArtifactStageOptions,
  StagedArtifact,
} from "../../core/types/deploy.ts";
import { assertPositiveSafeInteger } from "../../core/utils/number.ts";
import { createFileStage } from "./_file-stage.ts";

export interface FileArtifactStagerOptions {
  /** Parent for exclusive artifact directories. Defaults to the OS temp directory. */
  stagingDir?: string;
}

/** Streams received artifacts into exclusive files without buffering them in memory. */
export function createFileArtifactStager(opts?: FileArtifactStagerOptions): ArtifactStager {
  return {
    async stage(
      source: ReadableStream<Uint8Array>,
      stageOpts: ArtifactStageOptions,
    ): Promise<StagedArtifact> {
      assertPositiveSafeInteger(stageOpts.maxBytes, "maxBytes");
      const stage = await createFileStage(opts?.stagingDir);
      const reader = source.getReader();
      let received = 0;
      const cancel = (): void => {
        void reader.cancel(stageOpts.signal.reason).catch(() => {});
      };
      stageOpts.signal.addEventListener("abort", cancel, { once: true });

      try {
        for (;;) {
          throwIfAborted(stageOpts.signal);
          const next = await reader.read();
          throwIfAborted(stageOpts.signal);
          if (next.done) break;
          const chunk = next.value;
          const after = received + chunk.byteLength;
          if (after > stageOpts.maxBytes) {
            throw new ScafoError("resource-limit", "Artifact is too large", {
              detail: `the upload exceeded the ${String(stageOpts.maxBytes)}-byte received-artifact limit`,
            });
          }
          for (let offset = 0; offset < chunk.byteLength;) {
            const { bytesWritten } = await stage.file.write(
              chunk,
              offset,
              chunk.byteLength - offset,
            );
            if (bytesWritten === 0) throw new Error("artifact staging made no write progress");
            offset += bytesWritten;
          }
          received = after;
        }
        await stage.file.close();
        return stage.artifact;
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        await stage.file.close().catch(() => {});
        await stage.dispose();
        throw error;
      } finally {
        stageOpts.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    },
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new ScafoError("invalid-input", "Artifact upload was cancelled");
}
