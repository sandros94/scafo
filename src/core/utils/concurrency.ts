/* Bounded parallel work for independent operations. */

/** Work in flight at a time when a caller states no other bound. */
export const DEFAULT_CONCURRENCY: number = 8;

/** FIFO concurrency slots. Share one gate across nested work, but never hold a
    slot while awaiting work that needs that gate. */
export interface ConcurrencyGate {
  /** Slots this gate hands out at a time; at least 1. */
  readonly limit: number;
  /** Runs `fn` once a slot is free, and gives the slot back when it settles. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** A {@link ConcurrencyGate} that may decline excess queued work without starting it. */
export interface BoundedConcurrencyGate extends ConcurrencyGate {
  /** Starts work when a slot or bounded queue place is available, else returns null. */
  tryRun: <T>(fn: () => Promise<T>) => Promise<T> | null;
}

export interface ConcurrencyGateOptions {
  /** Maximum callers waiting for a slot. Absent leaves the queue unbounded. */
  maxQueue?: number;
}

/** A gate of `limit` slots. Anything below 1, fractional or not a number is clamped. */
export function createConcurrencyGate(
  limit: number = DEFAULT_CONCURRENCY,
  opts?: ConcurrencyGateOptions,
): BoundedConcurrencyGate {
  const slots = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_CONCURRENCY;
  const maxQueue =
    opts?.maxQueue === undefined
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(opts.maxQueue)
        ? Math.max(0, Math.floor(opts.maxQueue))
        : 0;
  const waiting: Array<() => void> = [];
  let active = 0;

  /* The slot is taken INSIDE the handover rather than after it, so two callers
     woken in the same turn cannot both read the same free slot. */
  const acquire = (): Promise<void> => {
    if (active < slots) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active++;
        resolve();
      });
    });
  };

  return {
    limit: slots,

    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        active--;
        waiting.shift()?.();
      }
    },

    tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
      if (active >= slots && waiting.length >= maxQueue) return null;
      return this.run(fn);
    },
  };
}

/** Maps independent work with bounded concurrency. Results preserve input order;
    failure waits in-flight work and rejects with the lowest failing index. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number | ConcurrencyGate,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const gate = typeof limit === "number" ? createConcurrencyGate(limit) : limit;
  const results: R[] = [];
  let failedAt = items.length;
  let failure: unknown;

  await Promise.all(
    items.map(async (item, index) =>
      gate.run(async () => {
        /* Behind a failure the sequential loop never reached. A LOWER index
           still runs, which is what makes the error below deterministic. */
        if (index > failedAt) return;

        try {
          results[index] = await fn(item, index);
        } catch (error) {
          if (index >= failedAt) return;
          failedAt = index;
          failure = error;
        }
      }),
    ),
  );

  if (failedAt < items.length) throw failure;
  return results;
}
