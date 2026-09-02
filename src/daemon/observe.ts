/* Bounded in-memory observation seam. Snapshot is non-consuming; drain has one
   flusher owner. Persistence is handled separately. */

import type { OperatorRole } from "../core/types/registry.ts";

/** Events the ring holds before the oldest are dropped to make room. */
export const OBSERVED_RING_SIZE: number = 512;

/**
 * One thing that happened, as it is recorded.
 *
 * `at` is stamped by the emitter from its own clock rather than by the caller,
 * so every event of a run is on one timeline — including the durations, which
 * are measured against {@link Observability.nowMs}.
 */
export type ObservedEvent =
  /* A pass beginning. `kicked` distinguishes an explicitly requested pass from
     one the timer started. */
  | { at: string; type: "reconcile.pass.start"; kicked: boolean }
  /** A coordinator newly could not place an environment on an eligible live node. */
  | {
      at: string;
      type: "placement.pending";
      project: string;
      env: string;
      reason: "placement-unavailable";
    }
  | {
      at: string;
      type: "reconcile.pass.end";
      /** Actions the pass planned. */
      actions: number;
      /** Failures it recorded; a pass reports them rather than aborting on them. */
      failures: number;
      /** Reads, writes and deletes the pass spent on the bucket. */
      storeOps: number;
      /** Listings it spent, counted apart because they cost a page each. */
      listOps: number;
      durationMs: number;
    }
  | { at: string; type: "runtime.started"; processId: string }
  /**
   * A key the fleet now trusts, and who said so. THE AUDIT PAIR: `actor` is the
   * key the request was signed with, `subject` the key it was about, and `role`
   * the tier the subject landed at.
   *
   * Emitted by the `/v1/operators` routes and by nothing else — the bucket-side
   * ceremony (`scafo operator keygen --register`) writes the same record with NO DAEMON IN
   * THE PICTURE, so it has nowhere to emit from and these events honestly do not
   * cover it. What covers that path is the bucket's own access log.
   */
  | {
      at: string;
      type: "operator.trusted";
      actor: string;
      subject: string;
      role: OperatorRole;
    }
  /** A key the fleet has stopped trusting, at the tier it held when it went. */
  | {
      at: string;
      type: "operator.revoked";
      actor: string;
      subject: string;
      role: OperatorRole;
    }
  /**
   * A project an admin has stopped, and who stopped it. THE OTHER AUDIT PAIR:
   * `actor` is the key the request was signed with, and the SUBJECT is the
   * project rather than another key, so it lands in the `project` column the
   * counter records already use.
   *
   * Emitted by the `/v1/projects` routes and by nothing else. A block written
   * straight to the bucket has no daemon in the picture and is covered by the
   * bucket's own access log, exactly as the operator ceremony is.
   *
   * WHY it was blocked is not recorded, because core is not told: the policy
   * that decided lives downstream, and a reason field here would be a place for
   * one platform's invoice numbers to end up in another's audit trail.
   */
  | { at: string; type: "project.blocked"; actor: string; project: string }
  /** The same act undone. A project that was never blocked emits one too: the
      call was made, and what an audit records is what somebody did. */
  | { at: string; type: "project.unblocked"; actor: string; project: string };

/** An event as a caller writes it; the emitter stamps {@link ObservedEvent.at}. */
export type ObservedEventInput = WithoutAt<ObservedEvent>;

/** What the ring holds right now, and what it has already had to forget. */
export interface ObservedSnapshot {
  /** Events still in the ring, oldest first. */
  events: ObservedEvent[];
  /** Events dropped to make room, since this seam was created. */
  dropped: number;
}

/** What one drain took off the ring, and what it could not. */
export interface ObservedDrain {
  /** Events emitted since the last drain, oldest first. */
  events: ObservedEvent[];
  /** Events overwritten since the prior drain. */
  dropped: number;
}

/** Where the daemon reports what it did, and what the flusher reads it back from. */
export interface Observability {
  /** False makes all operations no-ops. */
  readonly enabled: boolean;
  /** Records one event, stamped with this seam's clock. */
  emit(event: ObservedEventInput): void;
  /** Epoch clock shared by event timestamps and local duration measurement. */
  nowMs(): number;
  /** Non-consuming oldest-first ring snapshot. */
  snapshot(): ObservedSnapshot;
  /** Consuming read for the sole flusher; concurrent drainers would split events. */
  drain(): ObservedDrain;
}

export interface ObservabilityOptions {
  /** Whether to record anything. */
  enabled: boolean;
  /** Clock every event is stamped from; defaults to `new Date()`. */
  now?: () => Date;
  /** Events held before the oldest is dropped. Defaults to {@link OBSERVED_RING_SIZE}. */
  ringSize?: number;
}

/** Builds a bounded observation ring that drops and counts oldest events. */
export function createObservability(opts: ObservabilityOptions): Observability {
  const now = opts.now ?? ((): Date => new Date());
  const nowMs = (): number => now().getTime();

  if (!opts.enabled) {
    return {
      enabled: false,
      emit: (): void => {},
      nowMs,
      snapshot: (): ObservedSnapshot => ({ events: [], dropped: 0 }),
      drain: (): ObservedDrain => ({ events: [], dropped: 0 }),
    };
  }

  const size = Math.max(1, opts.ringSize ?? OBSERVED_RING_SIZE);
  const ring: (ObservedEvent | undefined)[] = Array.from({ length: size });
  /* Total writes reveal snapshots overwritten by the ring. */
  let written = 0;
  /* Drain high-water mark uses the same sequence as writes. */
  let drained = 0;

  /** Events from `position` up to what has been written, oldest first. */
  const read = (position: number): ObservedEvent[] => {
    const events: ObservedEvent[] = [];
    for (let index = position; index < written; index++) {
      const event = ring[index % size];
      if (event !== undefined) events.push(event);
    }
    return events;
  };

  return {
    enabled: true,

    emit(event: ObservedEventInput): void {
      ring[written % size] = { at: now().toISOString(), ...event } as ObservedEvent;
      written++;
    },

    nowMs,

    snapshot(): ObservedSnapshot {
      return { events: read(Math.max(0, written - size)), dropped: Math.max(0, written - size) };
    },

    drain(): ObservedDrain {
      /* Events before `oldest` were overwritten before this drain. */
      const oldest = Math.max(0, written - size);
      const dropped = Math.max(0, oldest - drained);
      const events = read(Math.max(drained, oldest));
      drained = written;
      return { events, dropped };
    },
  };
}

/** Distributes over the union, so each variant keeps its own discriminant. */
type WithoutAt<T> = T extends { at: string } ? Omit<T, "at"> : never;
