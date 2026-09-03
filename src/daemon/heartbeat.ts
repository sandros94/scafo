/* Periodically refreshes node liveness, and what the node serves, for the fleet. */

import { servingOf } from "../core/placement/serving.ts";
import { heartbeatNode, NODE_HEARTBEAT_INTERVAL_MS } from "../core/registry/nodes.ts";
import { isScafoError } from "../core/error.ts";
import type { DaemonContext } from "./app.ts";

/** What the heartbeat has managed lately. */
export interface HeartbeatStatus {
  /** ISO time this node last stamped its record; null before the first one lands. */
  lastBeatAt: string | null;
  /** Why the last beat did not land; null when it did. */
  lastFailure: string | null;
}

export interface Heartbeat {
  start(): void;
  /** Stops beating. A node on its way out must stop claiming to be available. */
  stop(): void;
  /**
   * One refresh, awaited. Never throws: a failed beat is recorded and retried.
   *
   * A call arriving while a beat is in flight is not dropped: that beat read the
   * node's state before the caller had something new to say, so one more runs
   * after it. Any number of such calls collapse into that one.
   */
  beat(): Promise<void>;
  status(): HeartbeatStatus;
}

export interface HeartbeatOptions {
  /** Time between beats. Defaults to {@link NODE_HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
}

/**
 * Builds a heartbeat loop. Failures are recorded and retried within liveness
 * tolerance.
 *
 * Each beat also publishes what the node serves, read off the reconcile loop —
 * but only once that loop has run: before its first pass the node has not
 * looked at its own processes, and a record saying "nothing" would pull every
 * route to this node for the seconds until it does.
 */
export function createHeartbeat(daemon: DaemonContext, opts?: HeartbeatOptions): Heartbeat {
  const intervalMs = opts?.intervalMs ?? NODE_HEARTBEAT_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<void> | null = null;
  let again = false;
  let lastBeatAt: string | null = null;
  let lastFailure: string | null = null;

  async function once(): Promise<void> {
    try {
      const reconcile = daemon.reconciler?.status();
      lastBeatAt = await heartbeatNode(
        daemon.registry,
        daemon.nodeId,
        reconcile === undefined || reconcile.lastRunAt === null
          ? undefined
          : { serving: servingOf(reconcile.processes) },
      );
      lastFailure = null;
    } catch (error) {
      lastFailure = describe(error);
    }
  }

  function beat(): Promise<void> {
    if (inFlight !== null) {
      again = true;
      return inFlight;
    }
    inFlight = (async () => {
      do {
        again = false;
        await once();
      } while (again);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    beat,

    start(): void {
      if (timer !== null) return;

      timer = setInterval(() => void beat(), intervalMs);
      /* Timer must not keep the process alive. */
      const handle = timer as { unref?: () => void };
      handle.unref?.();
    },

    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },

    status(): HeartbeatStatus {
      return { lastBeatAt, lastFailure };
    },
  };
}

/** The specifics a scafo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
