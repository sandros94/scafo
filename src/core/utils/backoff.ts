import { secureRandomNumber } from "unsecure/random";
import { isScafoError } from "../error.ts";

export interface RetryOptions {
  /** Total tries, including the first one. Default 5. */
  attempts?: number;
  /** Base delay in ms, doubled per attempt. Default 50. */
  baseMs?: number;
  /** Upper bound for the pre-jitter delay in ms. Default 2000. */
  maxMs?: number;
  /**
   * A whole number of milliseconds from zero up to, and never reaching, the
   * window it is given. Injectable for deterministic tests; defaults to
   * `secureRandomNumber` from `unsecure/random`.
   */
  jitter?: (windowMs: number) => number;
  /** Decides whether a thrown value is worth retrying. Default: CAS conflicts only. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable for deterministic tests. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries `fn` with full jitter: a wait drawn from `[0, min(maxMs, baseMs * 2 ** attempt))`.
 * The last error is rethrown once attempts run out or when it is not retryable.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const attempts = opts?.attempts ?? 5;
  const baseMs = opts?.baseMs ?? 50;
  const maxMs = opts?.maxMs ?? 2000;
  const jitter = opts?.jitter ?? secureRandomNumber;
  const isRetryable = opts?.isRetryable ?? isCasConflict;
  const sleep = opts?.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt + 1 >= attempts || !isRetryable(error)) throw error;
      await sleep(jitter(backoffWindowMs(attempt, baseMs, maxMs)));
    }
  }
}

/**
 * How long the `attempt`-th retry waits: full jitter over an exponentially
 * growing window, drawn from `[0, min(maxMs, baseMs * 2 ** attempt))`.
 *
 * The very formula {@link withRetry} uses, exported for the loops that cannot be
 * one — a caller retrying until a DEADLINE rather than for a number of tries,
 * or one that has been told by the other end how long to wait. Jitter matters
 * more there than anywhere: fifty pipelines refused by the same full queue in
 * the same second would otherwise come back in the same second too.
 */
export function jitteredDelayMs(
  attempt: number,
  opts?: { baseMs?: number; maxMs?: number; jitter?: (windowMs: number) => number },
): number {
  const baseMs = opts?.baseMs ?? 50;
  const maxMs = opts?.maxMs ?? 2000;
  const jitter = opts?.jitter ?? secureRandomNumber;
  return jitter(backoffWindowMs(attempt, baseMs, maxMs));
}

/**
 * The window the `attempt`-th wait is drawn from, as the whole number of
 * milliseconds a secure draw takes: at least one, and never past `maxMs`.
 */
function backoffWindowMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.max(1, Math.floor(Math.min(maxMs, baseMs * 2 ** attempt)));
}

function isCasConflict(err: unknown): boolean {
  return isScafoError(err) && err.code === "cas-conflict";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
