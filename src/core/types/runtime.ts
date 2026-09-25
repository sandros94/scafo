/*
 * The seam between placement and whatever actually serves an application's
 * traffic on a node. Core describes the contract; a driver
 * (`scafo/drivers/runtime/celld`) implements it, and the daemon wires the two
 * together.
 */

import type { PortPair } from "../placement/ports.ts";
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
  /**
   * This Scafo node's registry id, which is also the name its runtime processes
   * are known by inside their own fleets.
   *
   * A NAME THAT SURVIVES A RESTART IS HALF OF DURABILITY. A runtime that
   * acknowledges a write once a peer holds it recovers that write at boot by
   * taking over the log of the PREDECESSOR OF THAT NAME. A process starting
   * under a name nothing wrote before has no predecessor to recover, so the
   * acknowledged write is simply not there — and there is one process per
   * application per node, so the node's own id is a name unique in the fleet and
   * the same one every time this machine comes back.
   */
  id: string;
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
  ports: PortPair;
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

/** Where one running process of this node is reached to be spoken to. */
export interface RuntimeReloadInput {
  /** The application the process serves; it is also the process's supervisor id. */
  application: string;
  /** Host the process's internal listener was bound on, as this node dials it. */
  host: string;
  /** Port of that internal listener. */
  port: number;
}

/** Where one running process of this node is asked whether it is serving yet. */
export interface RuntimeReadyInput {
  /** The application the process serves; it is also the process's supervisor id. */
  application: string;
  /** Host the process's PUBLIC listener was bound on, as this node dials it. */
  host: string;
  /**
   * Port of that public listener — the very port the fleet's routing would name.
   * Asking anywhere else would answer a question nobody has.
   */
  port: number;
}

/** The ports an application is to be started on, and what they replaced. */
export interface RuntimePorts {
  ports: PortPair;
  /**
   * The pair this one replaced, set only when the pair the application held here
   * could not be used again — something foreign was listening on it. The caller
   * says so in one line of the log; nothing else depends on it.
   */
  replaced?: PortPair;
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
  /**
   * Creates the private local directories one application's process works out
   * of, before it is started. Creating them twice is not an error: a process
   * that comes back finds the directories its predecessor left.
   */
  prepareLocalState(application: string): Promise<void>;
  /**
   * The two ports `application` is served on by this node, chosen once and kept
   * beside the rest of its local state.
   *
   * A PORT BELONGS TO AN APPLICATION FOR AS LONG AS THIS NODE KNOWS IT. Celld
   * ignores the `Host` header, so whichever process holds a port answers
   * everything sent there: were an application's ports to change hands while a
   * peer or an ingress still routed to them, one application's requests would be
   * answered by another application's process. So the pair is persisted on the
   * first start and handed back unchanged on every later one — after a process
   * exit, a daemon restart, a container re-created on the same state volume —
   * and released only when the application's local state is removed, which is
   * the one event that means this node will not serve it again.
   *
   * The pair is probed before it is handed back. A port a foreign process took
   * while the application was stopped must not wedge it, so a new pair is chosen
   * and persisted instead and {@link RuntimePorts.replaced} names the old one.
   *
   * Throws `ScafoError("placement-unavailable")` when the configured range has
   * fewer than two ports left on this node.
   */
  ports(application: string): Promise<RuntimePorts>;
  /**
   * Applications this node is holding local state for, whether or not one of
   * them is running. Anything under the directory this driver owns that is no
   * application name at all is not reported: it is not this driver's.
   */
  heldLocalState(): Promise<string[]>;
  /**
   * Removes everything this node holds locally for `application`, and answers
   * without complaint when there is nothing there.
   *
   * ONLY FOR AN APPLICATION THAT IS GONE FROM THE REGISTRY, and never while a
   * process for it runs here. The directory is a follower disk: it can hold
   * writes a peer acknowledged and the bucket has not got yet, and every other
   * reason a process stops — retirement, blocking, reassignment, a drain, a
   * daemon restart — is one the application may come back from.
   *
   * This is also where the application's ports are released, into a quarantine
   * that keeps them from a different application until nothing out there can
   * still be routing to them.
   */
  removeLocalState(application: string): Promise<void>;
  /**
   * Asks one process of this node whether it is serving yet, and answers what it
   * said: `true` for a process that answered its own health endpoint, `false` for
   * one that refused, answered otherwise, or did not answer in time.
   *
   * WHAT MAKES A PROCESS PUBLISHABLE. A spawned process holds a port before
   * anything is listening on it, and one that can never become ready holds it
   * forever; until this answers `true`, the node does not name the application in
   * the `serving` every ingress routes by. It is asked once per pass of a process
   * that has not answered yet and NEVER AGAIN once one has — readiness is not
   * liveness, and a run that answered is trusted until it exits.
   *
   * Never throws for a process that is simply not up: a refused connection, a
   * timeout and an error status are all `false`, because the caller does the same
   * thing with each of them. It is bounded by the driver to a fraction of a
   * reconcile interval, so a pass never waits on a wedged listener.
   */
  ready(input: RuntimeReadyInput): Promise<boolean>;
  /**
   * Asks a process of this node to adopt the fleet's current deployment NOW,
   * instead of when its own poll comes round.
   *
   * AN OPTIMIZATION AND NOTHING MORE. The runtime already notices a pointer that
   * moved, on a timer of its own; this only shortens the wait between a deploy
   * being recorded and the application serving it. Every caller therefore treats
   * a failure — a refused connection, a refusal, a listener that did not answer
   * in time — as "log once and carry on", and no state anywhere depends on it
   * having happened.
   *
   * Bounded by the driver: a caller never waits on this longer than a deploy can
   * afford. Throws whatever went wrong, so a caller may say what it was.
   */
  reload(input: RuntimeReloadInput): Promise<void>;
}
