/*
 * What a node saw itself do: the seam every observable moment of the daemon is
 * reported through, and the bounded ring those reports land in.
 *
 * EMISSION AND A RING, AND NOTHING HERE REACHES THE BUCKET. What this settles is
 * the SHAPE of an event and the cost of a node that is not observing; the
 * flusher beside it (`src/daemon/observe-flush.ts`) is what takes the events off
 * the ring and writes them.
 *
 * TWO READERS, AND ONLY ONE OF THEM CONSUMES. {@link Observability.snapshot} is a
 * WINDOW on the recent past: it reads without consuming, so any number of
 * callers see the same events. {@link Observability.drain} is the FLUSHER'S, and
 * there may only be one — it takes everything since the last drain and moves a
 * high-water mark past it, so a second drainer would silently halve what each of
 * them wrote. What it reports as dropped is what fell out of the ring BEFORE it
 * could be read, which is the flusher's own loss rather than the ring's total.
 *
 * THE SEAM IS THREADED, NEVER IMPORTED AS A GLOBAL. It reaches the code that
 * emits through {@link DaemonContext} and the executor's deps, exactly as the
 * clock and the weighted draw do, so a test states what a pass observed rather
 * than reaching into module state to find out.
 *
 * AN ABSENT SEAM COSTS NOTHING, AND THAT IS THE POINT OF IT BEING OPTIONAL.
 * Every emission site is written `observe?.emit({ ... })`: optional chaining
 * short-circuits the whole call, so the event object is NEVER BUILT on a node
 * that is not observing. A site that needs a local first guards with
 * `if (observe !== undefined)` for the same reason. A disabled instance exists
 * too — it drops what it is handed — but the daemon is only ever given one while
 * observability is on, so the allocations behind the guard are never paid for.
 */

import type { OperatorRole } from "../core/types/registry.ts";
import type { CreditPlacementFailureReason } from "../core/placement/credits.ts";

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
  /* A held request let through this node's concurrent-wake cap, with what its
     Host resolved to and how many wakes this node is holding including it. */
  | {
      at: string;
      type: "wake.admitted";
      id: string;
      host: string;
      /** What the Host named: a whole environment, or one build recalled at its own host. */
      kind: "environment" | "build";
      project: string;
      env: string;
      /** The build a `build` target names; absent for an environment. */
      build?: string;
      inFlight: number;
    }
  /* Turned away AT the cap, having stamped nothing and started nothing. */
  | { at: string; type: "wake.refused"; id: string; host: string }
  /**
   * What resolving this request's Host and its placement cost the bucket.
   * Emitted once the request is admitted, because a refusal has nothing to
   * attribute the cost to.
   */
  | { at: string; type: "wake.resolved"; id: string; storeOps?: number }
  /* The stamp the reconcile loop starts things from is IN THE BUCKET — not
     merely timestamped, which is a distinction a wake's latency is made of. */
  | { at: string; type: "wake.stamped"; id: string }
  | { at: string; type: "wake.kicked"; id: string }
  /* The application answered, and this is what it answered with. A successful
     wake leaves this trace and no other. */
  | { at: string; type: "wake.served"; id: string; port: number; status: number }
  /**
   * A wake this node was holding that ended without an application answering it.
   * `"deadline"` is the surface's own outcome; anything else is the description
   * of what was raised, a hop that could not be made included.
   */
  | { at: string; type: "wake.failed"; id: string; reason: string }
  /* A pass beginning. `kicked` tells a pass a wake asked for from one the timer
     came round to, which is the difference between a wake's latency and the
     interval's. */
  | { at: string; type: "reconcile.pass.start"; kicked: boolean }
  /** A coordinator newly could not admit an environment under its credit plan. */
  | {
      at: string;
      type: "placement.pending";
      project: string;
      env: string;
      reason: CreditPlacementFailureReason;
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
  /* The moment a runtime process exists. Everything a wake is waiting for
     starts here, and the pointer hold it was spawned under runs past it. */
  | { at: string; type: "rollout.spawned"; processId: string; build: string }
  /* The pointer hold is over and the rollout has given the environment's lock
     back. It may well land AFTER the gate below: the hold guards the pointer,
     not the gate, and the two deliberately overlap. */
  | { at: string; type: "rollout.holdEnded"; processId: string }
  | {
      at: string;
      type: "gate.passed";
      processId: string;
      /** Probe attempts the driver reported; `0` from a driver that reports none. */
      attempts: number;
      durationMs: number;
    }
  | { at: string; type: "gate.failed"; processId: string; attempts: number }
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
   * wake and counter records already use.
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
  /**
   * Events that fell out of the ring since the last drain, before this one could
   * read them. Nonzero means the drainer is slower than the node emits, or the
   * ring is too small for the interval between drains — never that the events
   * were uninteresting.
   */
  dropped: number;
}

/** Where the daemon reports what it did, and what the flusher reads it back from. */
export interface Observability {
  /**
   * Whether anything is recorded at all. False makes every call below a no-op —
   * but see the file header: the daemon is handed no seam at all when it is off,
   * so a disabled instance is what a caller who always builds one gets.
   */
  readonly enabled: boolean;
  /** Records one event, stamped with this seam's clock. */
  emit(event: ObservedEventInput): void;
  /**
   * This seam's clock in epoch milliseconds. What a caller measures a span
   * against, so a `durationMs` and the `at` beside it can never come from two
   * different clocks.
   */
  nowMs(): number;
  /**
   * The ring as it stands, oldest first. Reading does NOT consume: the ring is
   * a window on the recent past, and two readers see the same events.
   */
  snapshot(): ObservedSnapshot;
  /**
   * Everything emitted since the last drain, CONSUMED — a second call answers
   * only what arrived in between.
   *
   * FOR THE FLUSHER AND FOR NOTHING ELSE. It moves a high-water mark rather than
   * clearing the ring, so {@link Observability.snapshot} still shows the window
   * it always did; but two drainers would each take half the events and neither
   * would know it, which is why the daemon only ever builds one.
   */
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

/**
 * Builds the seam the daemon reports through.
 *
 * The ring is BOUNDED and never grows: a node nobody is reading events off must
 * not accumulate them, so the oldest are dropped and counted rather than kept.
 * {@link ObservedSnapshot.dropped} is what says a reader is too slow or the ring
 * too small — it is never silent about what it forgot.
 */
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
  /* Every event ever emitted, which is what says how many fell out of the ring. */
  let written = 0;
  /* How far the drainer has read. Counted in the same units as `written`, so the
     arithmetic below never has to look at the ring to know what it missed. */
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
      /* The oldest position the ring can still answer for. Anything the drainer
         had not reached by the time it was overwritten is gone, and counted. */
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
