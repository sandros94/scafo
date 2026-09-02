/* Periodically refreshes node liveness for coordinator placement. */

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
  /** One refresh, awaited. Never throws: a failed beat is recorded and retried. */
  beat(): Promise<void>;
  status(): HeartbeatStatus;
}

export interface HeartbeatOptions {
  /** Time between beats. Defaults to {@link NODE_HEARTBEAT_INTERVAL_MS}. */
  intervalMs?: number;
}

/** Builds a heartbeat loop. Failures are recorded and retried within liveness tolerance. */
export function createHeartbeat(daemon: DaemonContext, opts?: HeartbeatOptions): Heartbeat {
  const intervalMs = opts?.intervalMs ?? NODE_HEARTBEAT_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lastBeatAt: string | null = null;
  let lastFailure: string | null = null;

  async function beat(): Promise<void> {
    /* Prevent queued stale heartbeat writes. */
    if (inFlight) return;
    inFlight = true;

    try {
      lastBeatAt = await heartbeatNode(daemon.registry, daemon.nodeId);
      lastFailure = null;
    } catch (error) {
      lastFailure = describe(error);
    } finally {
      inFlight = false;
    }
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
