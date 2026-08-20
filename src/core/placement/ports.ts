/* Loopback port pairs for the runtime processes a node runs. */

import { ScafoError } from "../error.ts";
import type { PortView } from "./reconcile.ts";

/** First port of the default range. */
export const DEFAULT_PORT_RANGE_START: number = 42_000;

/** Ports the default range spans from its start, giving 42000-42998. */
export const DEFAULT_PORT_RANGE_SPAN: number = 998;

export interface PortAllocatorOptions {
  /** Ports already in use; a pair overlapping one of them is skipped. */
  taken?: Iterable<number>;
  /** First port of the range. Defaults to {@link DEFAULT_PORT_RANGE_START}. */
  start?: number;
  /** Last port of the range. Defaults to `start` plus {@link DEFAULT_PORT_RANGE_SPAN}. */
  end?: number;
}

/**
 * Hands out consecutive `public`/`internal` port pairs from a range, skipping
 * every pair that overlaps a port already in use. Pairs are handed out at even
 * offsets from the start of the range, so the two halves of a pair always belong
 * to the same process.
 *
 * The allocator remembers what it handed out, so one instance can serve a whole
 * planning pass. Throws `ScafoError("placement-unavailable")` once the range is
 * exhausted.
 */
export function createPortAllocator(opts?: PortAllocatorOptions): PortView {
  const start = opts?.start ?? DEFAULT_PORT_RANGE_START;
  const end = opts?.end ?? start + DEFAULT_PORT_RANGE_SPAN;
  assertRange(start, end);

  const taken = new Set<number>(opts?.taken ?? []);

  return {
    nextPorts(): { public: number; internal: number } {
      for (let base = start; base + 1 <= end; base += 2) {
        if (taken.has(base) || taken.has(base + 1)) continue;

        taken.add(base);
        taken.add(base + 1);
        return { public: base, internal: base + 1 };
      }
      throw new ScafoError("placement-unavailable", "No free port pair", {
        detail: `every port pair in ${String(start)}-${String(end)} is already in use on this node`,
      });
    },
  };
}

function assertRange(start: number, end: number): void {
  const invalid = (detail: string): ScafoError =>
    new ScafoError("invalid-input", "Invalid port range", { detail });

  if (!Number.isInteger(start) || start < 1 || start > 65_534) {
    throw invalid(`the range must start at a port in 1-65534, got ${String(start)}`);
  }
  if (!Number.isInteger(end) || end > 65_535 || end < start + 1) {
    throw invalid(
      `the range must end at a port between ${String(start + 1)} and 65535, got ${String(end)}`,
    );
  }
}
