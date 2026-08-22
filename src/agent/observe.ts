/*
 * What a node saw itself do: the seam every observable moment of the agent is
 * reported through, and the bounded ring those reports land in.
 *
 * EMISSION ONLY. Nothing here is persisted, exported or served — a later phase
 * flushes {@link Observability.snapshot} somewhere. What this settles is the
 * SHAPE of an event and the cost of a node that is not observing.
 *
 * THE SEAM IS THREADED, NEVER IMPORTED AS A GLOBAL. It reaches the code that
 * emits through {@link AgentContext} and the executor's deps, exactly as the
 * clock and the weighted draw do, so a test states what a pass observed rather
 * than reaching into module state to find out.
 *
 * AN ABSENT SEAM COSTS NOTHING, AND THAT IS THE POINT OF IT BEING OPTIONAL.
 * Every emission site is written `observe?.emit({ ... })`: optional chaining
 * short-circuits the whole call, so the event object is NEVER BUILT on a node
 * that is not observing. A site that needs a local first guards with
 * `if (observe !== undefined)` for the same reason. A disabled instance exists
 * too — it drops what it is handed — but the agent is only ever given one while
 * observability is on, so the allocations behind the guard are never paid for.
 */

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
  | { at: string; type: "gate.failed"; processId: string; attempts: number };

/** An event as a caller writes it; the emitter stamps {@link ObservedEvent.at}. */
export type ObservedEventInput = WithoutAt<ObservedEvent>;

/** What the ring holds right now, and what it has already had to forget. */
export interface ObservedSnapshot {
  /** Events still in the ring, oldest first. */
  events: ObservedEvent[];
  /** Events dropped to make room, since this seam was created. */
  dropped: number;
}

/** Where the agent reports what it did, and what a later phase reads it back from. */
export interface Observability {
  /**
   * Whether anything is recorded at all. False makes every call below a no-op —
   * but see the file header: the agent is handed no seam at all when it is off,
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
 * Builds the seam the agent reports through.
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
    };
  }

  const size = Math.max(1, opts.ringSize ?? OBSERVED_RING_SIZE);
  const ring: (ObservedEvent | undefined)[] = Array.from({ length: size });
  /* Every event ever emitted, which is what says how many fell out of the ring. */
  let written = 0;

  return {
    enabled: true,

    emit(event: ObservedEventInput): void {
      ring[written % size] = { at: now().toISOString(), ...event } as ObservedEvent;
      written++;
    },

    nowMs,

    snapshot(): ObservedSnapshot {
      const events: ObservedEvent[] = [];
      const oldest = Math.max(0, written - size);
      for (let index = oldest; index < written; index++) {
        const event = ring[index % size];
        if (event !== undefined) events.push(event);
      }
      return { events, dropped: oldest };
    },
  };
}

/** Distributes over the union, so each variant keeps its own discriminant. */
type WithoutAt<T> = T extends { at: string } ? Omit<T, "at"> : never;
