/*
 * The seam between placement and whatever actually serves an environment's
 * traffic on a node. Core describes the contract; a driver
 * (`scafo/drivers/runtime/celld`) implements it, and the daemon wires the two
 * together.
 */

import type { CapacityPlan } from "../capacity/compute.ts";
import type { EnvironmentRecord, PlainVarset } from "./registry.ts";
import type { ProcessSpec } from "./supervisor.ts";

/** One runtime process of an environment, as the planner sees it. */
export interface RuntimeProcess {
  /**
   * Id the process runs under in the supervisor: `project--env`.
   */
  processId: string;
  project: string;
  env: string;
  /** Varset supplied when this process started; absent for an adopted process. */
  configuredVarset?: string | null;
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
  project: string;
  env: EnvironmentRecord;
  /** Opened varset of the environment; null when it has none or its key is not held. */
  vars: PlainVarset | null;
  ports: { public: number; internal: number };
  node: RuntimeNodeInput;
  /** Transitional node capacity bounds; removed with Scafo credit admission. */
  capacity?: CapacityPlan;
  /** RSS credit reserved for this process while Scafo owns admission. */
  maxRssMb?: number;
  /**
   * Environment the process starts from, before the driver adds its own settings.
   *
   * `ProcessSpec.env` replaces a child's environment rather than extending it, so
   * a spec built without at least a `PATH` cannot resolve a command that was named
   * without a directory. The caller supplies this; a driver never reads the
   * environment it happens to be running in.
   */
  baseEnv?: Record<string, string>;
  /** Variables merged last. Names the driver reserves for itself are refused. */
  extraEnv?: Record<string, string>;
}

/** Runs one environment's Celld process on a node. */
export interface RuntimeDriver {
  /**
   * Grace a caller must give one of this driver's processes between `SIGTERM`
   * and `SIGKILL`. It is never shorter than the drain the driver configures the
   * process with, so a process always finishes draining before it is killed.
   */
  readonly stopGraceMs: number;
  /** Materializes the spec that runs one environment on this node. */
  processSpec(input: RuntimeSpecInput): ProcessSpec;
}
