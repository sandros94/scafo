/*
 * The seam between placement and whatever actually serves an environment's
 * traffic on a node. Core describes the contract; a driver
 * (`scafo/drivers/runtime/celld`) implements it, and the daemon wires the two
 * together.
 */

import type { CapacityPlan } from "../capacity/compute.ts";
import type { BuildRecord, EnvironmentRecord, PlainVarset } from "./registry.ts";
import type { ProcessSpec } from "./supervisor.ts";

/** One runtime process of an environment, as the planner sees it. */
export interface RuntimeProcess {
  /**
   * Id the process runs under in the supervisor: `project--env--build`, with an
   * `--r<n>` suffix when an earlier attempt at the same three parts is still around.
   */
  processId: string;
  project: string;
  env: string;
  /** Build this process serves. Fixed at spawn: serving another one takes another process. */
  build: string;
  /** Loopback port serving public traffic. */
  port: number;
  /** Loopback port reserved for node-to-node traffic. */
  internalPort: number;
  /** True once the process has passed its readiness gate. */
  ready: boolean;
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
   * all a single node needs: its ingress and its readiness probe are on the same
   * host, and nothing else may reach a runtime process directly.
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
  /** Build to serve; the process loads it once, while it starts. */
  build: BuildRecord;
  /** Opened varset of the environment; null when it has none or its key is not held. */
  vars: PlainVarset | null;
  ports: { public: number; internal: number };
  node: RuntimeNodeInput;
  /** Node capacity the process is bounded by; omitted leaves the runtime's own defaults. */
  capacity?: CapacityPlan;
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

/** How hard a readiness gate tries, and what it accepts. */
export interface ProbeOptions {
  /** Path the application-level probe requests. Defaults to `/`. */
  path?: string;
  /** Status the application-level probe must stay below. Defaults to 500. */
  expectBelow?: number;
  /** Times the gate is tried before it fails. */
  attempts?: number;
  /** Wait between attempts, in milliseconds. */
  delayMs?: number;
  /** Injected `fetch`; defaults to the global one. */
  fetchFn?: typeof fetch;
  /**
   * Called once as each attempt begins, for a caller counting how hard a gate
   * had to try.
   *
   * How LONG a gate took is the caller's own measurement, but how MANY attempts
   * it cost is only knowable from inside — a gate that passed first time and one
   * that passed on the twelfth answer the same `true`, and the difference is
   * what says a build is slow to come up rather than merely up. A driver that
   * does not report attempts simply never calls this, and a caller counting them
   * reads zero.
   */
  onAttempt?: () => void;
}

/** Runs one environment's build on a node, and says when it is ready to serve. */
export interface RuntimeDriver {
  /**
   * Grace a caller must give one of this driver's processes between `SIGTERM`
   * and `SIGKILL`. It is never shorter than the drain the driver configures the
   * process with, so a process always finishes draining before it is killed.
   */
  readonly stopGraceMs: number;
  /** Materializes the spec that runs one environment's build on this node. */
  processSpec(input: RuntimeSpecInput): ProcessSpec;
  /**
   * Points the fleet's activation pointer at a version, so the NEXT process
   * started against that fleet serves it. Running processes are unaffected: they
   * read the pointer once, while they start.
   */
  activateVersion(fleetPrefix: string, celldVersionId: string): Promise<void>;
  /** Whether a running process passes its readiness gate. */
  probeReady(process: RuntimeProcess, opts?: ProbeOptions): Promise<boolean>;
}
