import { isScaloError } from "../error.ts";

export interface RetryOptions {
  /** Total tries, including the first one. Default 5. */
  attempts?: number;
  /** Base delay in ms, doubled per attempt. Default 50. */
  baseMs?: number;
  /** Upper bound for the pre-jitter delay in ms. Default 2000. */
  maxMs?: number;
  /** Returns a value in `[0, 1)`. Injectable for deterministic tests. Default `Math.random`. */
  jitter?: () => number;
  /** Decides whether a thrown value is worth retrying. Default: CAS conflicts only. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable for deterministic tests. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Retries `fn` with full jitter (`random() * min(maxMs, baseMs * 2 ** attempt)`).
 * The last error is rethrown once attempts run out or when it is not retryable.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const attempts = opts?.attempts ?? 5;
  const baseMs = opts?.baseMs ?? 50;
  const maxMs = opts?.maxMs ?? 2000;
  const jitter = opts?.jitter ?? Math.random;
  const isRetryable = opts?.isRetryable ?? isCasConflict;
  const sleep = opts?.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt + 1 >= attempts || !isRetryable(error)) throw error;
      await sleep(jitter() * Math.min(maxMs, baseMs * 2 ** attempt));
    }
  }
}

function isCasConflict(err: unknown): boolean {
  return isScaloError(err) && err.code === "cas-conflict";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
