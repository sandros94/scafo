/*
 * The seam between placement and whatever actually serves an application's
 * traffic on a node. Core describes the contract; a driver
 * (`scafo/drivers/runtime/celld`) implements it, and the daemon wires the two
 * together.
 */

import type { ApplicationRecord } from "./registry.ts";
import type { ProcessSpec } from "./supervisor.ts";

/** One runtime process of an application, as the planner sees it. */
export interface RuntimeProcess {
  /** The application this process serves; also its id in the supervisor. */
  application: string;
  /** A failed supervisor stop must be retried before any other lifecycle action. */
  teardownPending?: true;
  /** Loopback port serving public traffic. */
  port: number;
  /** Loopback port reserved for node-to-node traffic. */
  internalPort: number;
}

/** The bucket a runtime process reads its fleet from, and how peers reach this node. */
export interface RuntimeNodeInput {
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix every object of this installation lives under, when the bucket is shared. */
  keyPrefix?: string;
  accessKey: string;
  secretKey: string;
  /** Host other nodes reach this one at; advertised together with the internal port. */
  advertiseHost: string;
  /**
   * Address the process binds its listeners to. Defaults to loopback, which is
   * all a single node needs: its ingress is on the same host, and nothing else
   * may reach a runtime process directly.
   *
   * A multi-node fleet is the case that needs more. Peers dial each other at
   * {@link RuntimeNodeInput.advertiseHost} and the internal port to reach the
   * process that owns a cell, and a loopback-bound listener cannot answer a peer
   * on another host — the advertised address is reachable only if something is
   * listening on it. Widening this puts an unauthenticated peer listener on that
   * network, so it belongs behind the same transport decision every other
   * exposed address is.
   */
  bindHost?: string;
}

/** Everything one runtime process is materialized from. */
export interface RuntimeSpecInput {
  application: ApplicationRecord;
  ports: { public: number; internal: number };
  node: RuntimeNodeInput;
  /**
   * Environment the process starts from, before the driver adds its own settings.
   *
   * `ProcessSpec.env` replaces a child's environment rather than extending it, so
   * a spec built without at least a `PATH` cannot resolve a command that was named
   * without a directory. The caller supplies this; a driver never reads the
   * environment it happens to be running in.
   */
  baseEnv?: Record<string, string>;
}

/** Runs one application's Celld process on a node. */
export interface RuntimeDriver {
  /**
   * Grace a caller must give one of this driver's processes between `SIGTERM`
   * and `SIGKILL`. It is never shorter than the drain the driver configures the
   * process with, so a process always finishes draining before it is killed.
   */
  readonly stopGraceMs: number;
  /** Materializes the spec that runs one application on this node. */
  processSpec(input: RuntimeSpecInput): ProcessSpec;
}
