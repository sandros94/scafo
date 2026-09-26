/* Which two ports one application holds on a node, and for how long. */

import { ScafoError } from "../error.ts";

/**
 * First port of the default range. BELOW Linux's ephemeral range (32768-60999
 * unless the machine changed it): a port an outgoing connection is using as its
 * source refuses a listener with EADDRINUSE, so a range inside it has any
 * connection of the machine taking, for a moment, a port an application holds —
 * and a held pair that will not bind is a pair that has to move.
 */
export const DEFAULT_PORT_RANGE_START: number = 24_000;

/** Ports the default range spans from its start, giving 24000-24998. */
export const DEFAULT_PORT_RANGE_SPAN: number = 998;

/**
 * Lowest port a range may start at: everything below is the privileged range a
 * process started by an unprivileged node cannot bind anyway, and on a
 * host-network deployment it is where the machine's own services live.
 */
export const LOWEST_RANGE_PORT: number = 1024;

/** Highest port there is. */
export const HIGHEST_RANGE_PORT: number = 65_535;

/**
 * How long a released pair is kept from every OTHER application by default.
 *
 * LONG ENOUGH FOR THE FLEET TO STOP POINTING AT IT. The routing every ingress
 * reads is rendered from node records a peer re-reads on its own timer, and an
 * ingress polls that routing on a timer of its own again. Until both have turned
 * over, something out there still sends this application's traffic to that port
 * — and the process that ignores the `Host` header and answers it is whichever
 * one holds the port by then. Ten minutes is several turns of every one of those
 * timers.
 */
export const DEFAULT_PORT_QUARANTINE_MS: number = 600_000;

/** The two ports one application's process listens on. */
export interface PortPair {
  /** Port public traffic reaches the process on. */
  public: number;
  /** Port peers and this node's own reload calls reach it on. */
  internal: number;
}

/** The ports a node may choose from, both ends included. */
export interface PortRange {
  start: number;
  end: number;
}

export interface ChoosePortsInput {
  range: PortRange;
  /** Ports other applications of this node hold; never offered. */
  held: Iterable<number>;
  /** Ports released too recently to be given to a different application. */
  quarantined: Iterable<number>;
  /**
   * Whether `port` can really be bound on this node right now. A port some
   * foreign process holds is skipped: the range is the node's by convention and
   * by nothing else.
   */
  isFree: (port: number) => Promise<boolean>;
  /** Randomness in `[0, 1)`; injected so a caller can make a choice repeatable. */
  /**
   * A whole number from `min` up to, and never reaching, `max`, that is not in
   * `ignore` — the contract of `secureRandomNumber` in `unsecure/random`, which
   * is what a node passes. Only asked while something is left to draw.
   */
  random: (min: number, max: number, ignore: Set<number>) => number;
}

/**
 * Chooses the two ports an application will hold on this node.
 *
 * AT RANDOM, AND INDEPENDENTLY. Consecutive pairs handed out in order make the
 * ports a function of the order processes happen to start, which is how one
 * application ends up on the port another one held a moment ago; picking at
 * random from the whole range, with both halves drawn separately, leaves nothing
 * for that order to decide. Neither half is derivable from the other, so a peer
 * or an ingress holding a stale public port cannot accidentally address an
 * internal listener either.
 *
 * Pure but for the two seams it is given: every port it offers has been through
 * `isFree`, and `random` is the only source of choice. Throws
 * `ScafoError("placement-unavailable")` naming the range when fewer than two of
 * its ports are available.
 */
export async function choosePorts(input: ChoosePortsInput): Promise<PortPair> {
  const { start, end } = input.range;
  assertPortRange(input.range);

  /* Everything a draw may not answer with: what another application holds, what
     was released too recently, and — as the walk goes on — every port already
     drawn, so a port is probed at most once. */
  const excluded = new Set<number>();
  for (const port of [...input.held, ...input.quarantined]) {
    if (port >= start && port <= end) excluded.add(port);
  }
  const size = end - start + 1;

  const chosen: number[] = [];
  while (chosen.length < 2 && excluded.size < size) {
    const port = input.random(start, end + 1, excluded);
    excluded.add(port);

    if (await input.isFree(port)) chosen.push(port);
  }

  if (chosen.length < 2) {
    throw new ScafoError("placement-unavailable", "No free port pair", {
      detail:
        `fewer than two ports in ${String(start)}-${String(end)} are free on this node: ` +
        `the rest are held by its other applications, held by a foreign process, or ` +
        `released too recently to be given away`,
    });
  }
  return { public: chosen[0] as number, internal: chosen[1] as number };
}

/**
 * Refuses a range no node could place a pair in, naming the setting that carries
 * each end so an operator knows which one to correct.
 */
export function assertPortRange(range: PortRange, fields?: { start?: string; end?: string }): void {
  const startField = fields?.start ?? "runtime.portRangeStart";
  const endField = fields?.end ?? "runtime.portRangeEnd";
  const invalid = (detail: string): ScafoError =>
    new ScafoError("invalid-input", "Invalid port range", { detail });

  if (
    !Number.isInteger(range.start) ||
    range.start < LOWEST_RANGE_PORT ||
    range.start > HIGHEST_RANGE_PORT - 1
  ) {
    throw invalid(
      `"${startField}" must be a port in ${String(LOWEST_RANGE_PORT)}-` +
        `${String(HIGHEST_RANGE_PORT - 1)}, got ${String(range.start)}`,
    );
  }
  if (
    !Number.isInteger(range.end) ||
    range.end > HIGHEST_RANGE_PORT ||
    range.end < range.start + 1
  ) {
    throw invalid(
      `"${endField}" must be a port between ${String(range.start + 1)} and ` +
        `${String(HIGHEST_RANGE_PORT)}, so the range holds at least two ports, ` +
        `got ${String(range.end)}`,
    );
  }
}

/** The end of the default range for `start`, never reaching past the last port. */
export function defaultPortRangeEnd(start: number): number {
  return Math.min(start + DEFAULT_PORT_RANGE_SPAN, HIGHEST_RANGE_PORT);
}
