/*
 * The heartbeat: this node saying it is still there, often enough that the
 * coordinator can tell a node that is running from one that stopped.
 *
 * It is the ONLY signal placement has. A node that stops beating is counted out
 * after three intervals and its environments are given to nodes that are still
 * beating, so this loop keeps running for exactly as long as the node is willing
 * to serve — and stops the moment it is not.
 */

import { heartbeatNode, NODE_HEARTBEAT_INTERVAL_MS } from "../core/registry/nodes.ts";
import { isScaloError } from "../core/error.ts";
import type { AgentContext } from "./app.ts";

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

/**
 * Builds the heartbeat loop for this node. Nothing runs until
 * {@link Heartbeat.start} is called, or {@link Heartbeat.beat} is awaited.
 *
 * A beat that fails is recorded and nothing more. One lost beat costs nothing —
 * the liveness window is three of them — and a node that took itself down over
 * an unreachable bucket would turn a registry blip into an outage of everything
 * it runs.
 */
export function createHeartbeat(agent: AgentContext, opts?: HeartbeatOptions): Heartbeat {
  const intervalMs = opts?.intervalMs ?? NODE_HEARTBEAT_INTERVAL_MS;

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let lastBeatAt: string | null = null;
  let lastFailure: string | null = null;

  async function beat(): Promise<void> {
    /* Beats must not overlap: a slow bucket would otherwise queue up writes of
       timestamps that are already stale by the time they land. */
    if (inFlight) return;
    inFlight = true;

    try {
      lastBeatAt = await heartbeatNode(agent.registry, agent.nodeId);
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
      /* The loop must never be the reason the process stays alive. */
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

/** The specifics a scalo failure carries are the useful half; keep both. */
function describe(error: unknown): string {
  if (isScaloError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}
