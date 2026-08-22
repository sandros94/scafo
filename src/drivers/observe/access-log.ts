/*
 * Following the file an operator's ingress writes its access log to.
 *
 * A DRIVER BECAUSE IT TOUCHES A FILESYSTEM, and that is the whole of what it is
 * for. It knows nothing about what a line means — reading one is
 * `src/core/utils/access-log.ts`, which is pure — and nothing about what a line
 * is counted as. It hands out complete lines and stops there.
 *
 * IT STARTS AT THE FILE'S CURRENT END. Whatever the ingress logged before this
 * node came up was already served, by this node or another, and re-counting it
 * on every restart would invent traffic. A file that appears LATER is read from
 * its beginning, because a file created after we started has no history that
 * predates us.
 *
 * AND IT FOLLOWS ROTATION, WHICH IS THE TRAP. Both ingresses roll their own
 * logs: Caddy's file writer rolls at 100 MiB by default, and every logrotate
 * setup an operator already has does the same. Rolling is a RENAME plus a fresh
 * file at the same path — the open handle still points at the old inode — or, in
 * the `copytruncate` shape, the same inode cut back to zero. Both are watched
 * for, and in the rename case the file that was rotated away is DRAINED TO ITS
 * END before the new one is opened, so the lines written between the last poll
 * and the roll are not lost.
 *
 * POLLED RATHER THAN WATCHED. `fs.watch` reports a rename as one event on a path
 * it is no longer watching, misses changes entirely on several of the
 * filesystems a log lands on (bind mounts, network volumes, some container
 * overlays), and is not the same on every platform. A stat per second answers
 * every question this needs — size and identity — for a cost nothing can
 * measure, and it is the same answer everywhere.
 */

import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";

/** How often the file is looked at for growth and for replacement. */
export const DEFAULT_TAIL_INTERVAL_MS: number = 1_000;

/**
 * Longest partial line held while waiting for its newline. A line past this is
 * handed on as it stands and the rest of it read as another — bounded memory is
 * worth more than a single absurd line, and both halves are unreadable anyway,
 * so they land in the caller's malformed count rather than anywhere subtle.
 */
export const DEFAULT_MAX_LINE_BYTES: number = 64 * 1024;

/** Bytes read from the file at a time. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Follows one file, handing out the complete lines appended to it. */
export interface AccessLogTailer {
  /**
   * Opens the file at its current end and begins polling. A path that is not
   * there yet is not an error: it is picked up by the first poll that finds it.
   */
  start(): Promise<void>;
  /**
   * One pass over the file — what the timer does on its own. Exposed so a caller
   * can step it, and so a test needs no clock. Passes never overlap and never
   * reject; a caller awaiting one is awaiting a pass queued after any in flight.
   */
  poll(): Promise<void>;
  /**
   * Reads whatever is left, then closes the file. Idempotent, and TERMINAL: a
   * stopped tailer stays stopped, so a second stop — or a poll that arrives
   * after one — reads nothing and cannot re-open the file at its beginning.
   */
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
  /**
   * What went wrong reading the file — an unreadable path, a permission the node
   * does not have. REPORTED ONCE PER DISTINCT FAILURE rather than once per poll:
   * a log the node may not read would otherwise print every second forever, and
   * the same message repeated is not more information. The next successful pass
   * arms it again.
   */
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
  /* Which file the open handle IS, as the kernel names it. What says a path now
     holds a different file than the one being read. */
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
      /* Streaming, because a read can land in the middle of a multi-byte
         character and the two halves must decode as one. */
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
    /* Stat through the HANDLE rather than the path: a roll between the two would
       otherwise record the identity of a file this is not the one reading. */
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
        /* The path is gone — rolled away, or removed. Whatever is still open is
           the file it named, so it is read to its end rather than dropped, and
           the next pass picks up whatever takes the name. */
        await drain();
        return;
      }

      if (handle === null) await attach(false);
      else if (identify(present) !== identity) {
        await drain();
        await close();
        await attach(false);
      } else if (present.size < offset) {
        /* Truncated in place: the same file, cut back under us. Everything past
           the cut is new, and the partial line held from before it is gone. */
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
        /* THE ONE PLACE THE END IS THE STARTING POINT. Everything after this
           attaches at zero, because it is a file that did not exist when the
           node did. */
        if ((await peek(opts.path)) !== null) await attach(true);
      } catch (error) {
        report(error);
      }

      timer = setInterval(() => {
        if (!running) void poll();
      }, intervalMs);
      /* Never what keeps the process alive: the node runs until it is signalled,
         and a shutdown must not wait out a poll interval. */
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
      /* Read to the end before closing, so the lines written while the node was
         shutting down are counted. A partial line with no newline is left where
         it is: it is not a record yet. */
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
