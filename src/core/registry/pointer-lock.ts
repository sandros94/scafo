/*
 * The lock that serializes every writer of ONE ENVIRONMENT'S DEPLOYMENT POINTER.
 *
 * There is one pointer per environment in the whole fleet and a runtime process
 * reads it ONCE, while it starts. Two writers move it, from any node, at any
 * time: a reconciler's rollout (activate, then spawn the process that reads it)
 * and the deploy service (`celld deploy` bundles, uploads, and moves the same
 * pointer). Unserialized, a deploy landing between an activation and the spawned
 * process's read hands that process the WRONG version under the RIGHT process
 * id — a build-hash host serving another build's code, with the registry, the
 * routing and the process ids all still saying otherwise.
 *
 * So both writers take this lock, and neither may write the pointer without it.
 */

import { ScafoError } from "../error.ts";
import { LOCK_POLL_MS, LOCK_REFRESH_MS, LOCK_STALE_MS, type LockSpace } from "./locks.ts";
import { pointerLockKey } from "./paths.ts";

/**
 * How long a rollout keeps the lock PAST THE SPAWN, for the process to make its
 * one read of the pointer.
 *
 * The read is a single bucket GET in the runtime's early boot — before it can
 * bind a listener, let alone serve — and nothing the agent can see reports it:
 * supervised processes inherit the agent's streams, so their output cannot be
 * attributed to them, and the supervisor seam carries no other signal. A bounded
 * hold is therefore the whole of the guarantee, and the bound is sized to the
 * STALL CEILING of a real store rather than to its usual round-trip: a bucket
 * that answers in milliseconds still stalls individual requests for seconds
 * under load, and it is exactly the stalled read this hold must outlive.
 *
 * It is NOT the readiness gate, which takes tens of seconds: cross-node rollouts
 * of one environment now serialize on this window, so it buys correctness at the
 * cost of exactly this much, per leg, per node.
 */
export const POINTER_READ_HOLD_MS: number = 3_000;

/**
 * Longest a rollout waits for the lock before giving up on this pass.
 *
 * Short on purpose. A rollout that cannot have the pointer is not urgent — the
 * writer holding it is a deploy that will ask for its own rollout the moment it
 * lands — so it records the failure and lets the pass carry on with every other
 * environment, rather than stalling the loop behind a bundle that takes minutes.
 */
export const ROLLOUT_LOCK_TIMEOUT_MS: number = 5_000;

/**
 * Longest a deploy waits for the lock before failing.
 *
 * Long on purpose, and it is the opposite trade: a deploy is background work
 * with a status a client polls, it has nothing useful to do without the pointer,
 * and what it is usually waiting out is a rollout's {@link POINTER_READ_HOLD_MS}
 * — seconds. What it may also wait out is another node's deploy of the same
 * environment, which is bundling, and that is the latency this buys.
 */
export const DEPLOY_LOCK_TIMEOUT_MS: number = 60_000;

/** Where the pointer locks live, and how long they wait. */
export const POINTER_LOCK_SPACE: LockSpace = {
  keyOf: keyOfPointerName,
  refreshMs: LOCK_REFRESH_MS,
  staleMs: LOCK_STALE_MS,
  pollMs: LOCK_POLL_MS,
};

/** Name one environment's pointer lock is taken under: `<project>/<env>`. */
export function pointerLockName(project: string, env: string): string {
  return `${project}/${env}`;
}

function keyOfPointerName(name: string): string {
  const [project, env, ...rest] = name.split("/");
  if (project === undefined || env === undefined || rest.length > 0) {
    throw new ScafoError("invalid-input", "Invalid pointer lock name", {
      detail: `"${name}" must name one environment as "<project>/<env>"`,
    });
  }
  return pointerLockKey(project, env);
}
