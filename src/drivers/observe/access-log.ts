/* Polls an ingress access log. Existing files start at EOF; new files start at
   zero. Drains renamed files before switching and resets after copytruncate. */

import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

/** How often the file is looked at for growth and for replacement. */
export const DEFAULT_TAIL_INTERVAL_MS: number = 1_000;

/** Maximum buffered partial-line bytes; larger lines are emitted in fragments. */
export const DEFAULT_MAX_LINE_BYTES: number = 64 * 1024;

/** Bytes read from the file at a time. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Follows one file, handing out the complete lines appended to it. */
export interface AccessLogTailer {
  /** Opens at EOF. A missing path is picked up by a later poll. */
  start(): Promise<void>;
  /** Queues one non-overlapping, non-rejecting pass. */
  poll(): Promise<void>;
  /** Drains and closes the file. Stopping is terminal and idempotent. */
  stop(): Promise<void>;
}

export interface AccessLogTailOptions {
  /** File the ingress writes its access log to. */
  path: string;
  /** Called once per complete line, in the order the file holds them. */
  onLine: (line: string) => void;
  /** How often the file is polled; {@link DEFAULT_TAIL_INTERVAL_MS} by default. */
  intervalMs?: number;
  /** Longest partial line held; {@link DEFAULT_MAX_LINE_BYTES} by default. */
  maxLineBytes?: number;
  /** Called once per distinct read failure; a successful pass resets it. */
  onError?: (error: unknown) => void;
}

/**
 * Builds a tailer for one file. Nothing is opened until {@link
 * AccessLogTailer.start}.
 */
export function createAccessLogTailer(opts: AccessLogTailOptions): AccessLogTailer {
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_TAIL_INTERVAL_MS);
  const maxLineBytes = Math.max(1, opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  const chunk = new Uint8Array(READ_CHUNK_BYTES);

  let handle: FileHandle | null = null;
  /* Device and inode identify the open file across path replacement. */
  let identity: string | null = null;
  let offset = 0;
  let partial = "";
  let decoder = new TextDecoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let running = false;
  let queue: Promise<void> = Promise.resolve();
  let reported: string | undefined;

  const report = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === reported) return;
    reported = message;
    opts.onError?.(error);
  };

  const emit = (line: string): void => {
    const written = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (written === "") return;
    try {
      opts.onLine(written);
    } catch (error) {
      report(error);
    }
  };

  const feed = (text: string): void => {
    partial += text;

    let from = 0;
    for (;;) {
      const newline = partial.indexOf("\n", from);
      if (newline < 0) break;
      emit(partial.slice(from, newline));
      from = newline + 1;
    }
    partial = partial.slice(from);
    if (partial.length > maxLineBytes) {
      emit(partial);
      partial = "";
    }
  };

  const drain = async (): Promise<void> => {
    if (handle === null) return;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) return;
      offset += bytesRead;
      /* Preserve multi-byte characters across read boundaries. */
      feed(decoder.decode(chunk.subarray(0, bytesRead), { stream: true }));
    }
  };

  const close = async (): Promise<void> => {
    const held = handle;
    handle = null;
    identity = null;
    if (held !== null) await held.close();
  };

  const attach = async (atEnd: boolean): Promise<void> => {
    const opened = await open(opts.path, "r");
    /* Stat the handle: the path may rotate between open and stat. */
    const stats = await opened.stat();
    handle = opened;
    identity = identify(stats);
    offset = atEnd ? stats.size : 0;
    partial = "";
    decoder = new TextDecoder();
  };

  const pass = async (): Promise<void> => {
    if (stopped) return;
    running = true;
    try {
      const present = await peek(opts.path);
      if (present === null) {
        /* Drain the unlinked/renamed file before reopening its path. */
        await drain();
        return;
      }

      if (handle === null) await attach(false);
      else if (identify(present) !== identity) {
        await drain();
        await close();
        await attach(false);
      } else if (present.size < offset) {
        /* copytruncate: discard the old partial line and reread from zero. */
        offset = 0;
        partial = "";
        decoder = new TextDecoder();
      }

      await drain();
      reported = undefined;
    } catch (error) {
      report(error);
    } finally {
      running = false;
    }
  };

  const poll = (): Promise<void> => {
    queue = queue.then(pass);
    return queue;
  };

  return {
    async start(): Promise<void> {
      if (stopped || timer !== null) return;

      try {
        /* Ignore pre-start history; files created later start at zero. */
        if ((await peek(opts.path)) !== null) await attach(true);
      } catch (error) {
        report(error);
      }

      timer = setInterval(() => {
        if (!running) void poll();
      }, intervalMs);
      /* Polling must not keep the process alive. */
      const ticker = timer as { unref?: () => void };
      ticker.unref?.();
    },

    poll,

    async stop(): Promise<void> {
      if (stopped) return;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      /* Count complete lines written before shutdown; retain no partial line. */
      await poll();
      stopped = true;
      await close().catch(report);
    },
  };
}

/* ------------------------------------------------------------------ internal */

/** What the path holds right now, or null when it holds nothing. */
async function peek(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Which file this is, as the kernel names it: device and inode together. */
function identify(stats: Stats): string {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
