/*
 * Running independent work in parallel WITHOUT letting the fan-out grow with the
 * size of the registry. A read loop over a listing is the shape this exists for:
 * sequential it costs one round trip per item, unbounded it points a whole
 * installation's worth of requests at the store at once.
 */

/** Work in flight at a time when a caller states no other bound. */
export const DEFAULT_CONCURRENCY: number = 8;

/**
 * A number of slots, handed out in the order they were asked for.
 *
 * Pass ONE of these to several {@link mapConcurrent} calls to bound them
 * TOGETHER: nested maps that each hold their own bound multiply, and the product
 * is what actually reaches the store.
 *
 * THE SLOT MUST NEVER BE HELD AROUND WORK THAT ASKS FOR ONE. Every holder has to
 * be able to finish without the gate, or a full gate has nothing left to hand
 * the work that would release it. In practice: take a slot at the LEAVES — the
 * reads themselves, or one item's whole sequence of them — and never around the
 * fan-out above them.
 */
export interface ConcurrencyGate {
  /** Slots this gate hands out at a time; at least 1. */
  readonly limit: number;
  /** Runs `fn` once a slot is free, and gives the slot back when it settles. */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** A gate of `limit` slots. Anything below 1, fractional or not a number is clamped. */
export function createConcurrencyGate(limit: number = DEFAULT_CONCURRENCY): ConcurrencyGate {
  const slots = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_CONCURRENCY;
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
  };
}

/**
 * `items` mapped through `fn`, at most `limit` at a time.
 *
 * ANSWERS IN INPUT ORDER, never in completion order, so what a caller reads out
 * of this does not depend on which store round trip came back first.
 *
 * REJECTS EXACTLY AS A SEQUENTIAL LOOP WOULD. Nothing is STARTED once a failure
 * has been recorded, whatever is already in flight is awaited before this
 * rejects — so no read outlives the call, and no rejection goes unhandled — and
 * the error raised is the one belonging to the LOWEST INDEX that failed. That is
 * the error `for (const item of items) await fn(item)` would have thrown: items
 * are started in order, so every index below a failing one has already been
 * started and is therefore accounted for. What differs is only that items after
 * the failure may have run: `fn` must be free of side effects a caller would
 * notice, which is what "independent reads" means here.
 *
 * `limit` may be a {@link ConcurrencyGate} shared with other calls; read its
 * caveat before nesting one map inside another.
 */
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
