/* Internal: operator-ordered environment deletion, and the hop to the coordinator. */

import type { H3Event } from "h3";
import { signNodeToken } from "../core/auth/node-token.ts";
import { ScafoError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate } from "../core/registry/context.ts";
import { isLeaseExpired } from "../core/registry/lease.ts";
import { getNode } from "../core/registry/nodes.ts";
import { coordinatorKey } from "../core/registry/paths.ts";
import { deleteEnvironment } from "../core/registry/reaper.ts";
import type { CoordinatorLease } from "../core/types/registry.ts";
import type { DaemonContext, EnvironmentDeleted } from "./app.ts";
import { forwardToNode } from "./_forward.ts";
import { isProxiedHop } from "./_peer.ts";

/**
 * Whether the request asked for a forced deletion, which bypasses the
 * retirement-grace requirement.
 *
 * Only `force=1` and `force=true` count, and anything else — a typo, a `yes`, an
 * empty value — reads as NOT forced. That direction is the safe one: a caller
 * who meant to force and was not understood gets the refusal, which says exactly
 * how to proceed, rather than the deletion they could not undo.
 *
 * The grace itself is deliberately not settable over the wire. An operator who
 * wants to shorten it is asking for the deletion to happen now, and `force` is
 * that request stated plainly.
 */
export function forceRequested(event: H3Event): boolean {
  const asked = event.url.searchParams.get("force")?.toLowerCase();
  return asked === "1" || asked === "true";
}

/**
 * Deletes an environment, wherever the coordinator happens to be.
 *
 * Deleting is lease-gated — S3 has no conditional delete, so the lease is the
 * only thing keeping two deleters apart — which means exactly one node in the
 * installation can carry it out. Rather than telling an operator which node that
 * is, any node accepts the request and forwards it to the one holding the lease.
 *
 * Three outcomes, in order: this node holds the lease and does the work; nobody
 * holds it, so this node offers itself once and then either does the work or
 * finds out who won; another node holds it, and the request is forwarded there
 * once and its answer returned verbatim.
 */
export async function deleteEnvironmentRequest(
  daemon: DaemonContext,
  event: H3Event,
): Promise<Response | EnvironmentDeleted> {
  const project = event.context.params?.project ?? "";
  const env = event.context.params?.env ?? "";
  const force = forceRequested(event);
  const coordinator = daemon.coordinator;

  let lease = await currentLease(daemon);
  if (lease === null && coordinator !== undefined) {
    /* Nobody coordinates yet, which is the ordinary state of an installation
       that has just booted rather than a failure. This node offers itself once
       instead of asking the operator to come back later. */
    await coordinator.runOnce();
    lease = await currentLease(daemon);
  }

  const handle = coordinator?.handle() ?? null;
  if (handle !== null && lease?.node === daemon.nodeId) {
    return deleteEnvironment(daemon.registry, project, env, handle, { force });
  }

  if (lease === null) {
    throw new ScafoError("draining", "No node is coordinating", {
      detail:
        `no node holds the coordinator lease, and this one could not take it, so there is ` +
        `nowhere to carry out the deletion of "${project}/${env}" right now`,
    });
  }

  if (isProxiedHop(event.req.headers)) {
    /* Loop guard. The lease moved between the hop being decided and this node
       reading it, so the forward landed on a node that does not coordinate
       either. Refused rather than forwarded on: the caller retries against a
       settled lease, and no request circles the mesh. */
    throw new ScafoError("draining", "Not the coordinator", {
      detail:
        `this request was already forwarded once, and node "${daemon.nodeId}" does not hold ` +
        `the coordinator lease — node "${lease.node}" does as of this read`,
    });
  }

  return forwardToCoordinator(daemon, event, lease.node);
}

/** The lease as it stands, or null when nobody holds a live one. */
async function currentLease(daemon: DaemonContext): Promise<CoordinatorLease | null> {
  const found = await readJson<CoordinatorLease>(daemon.registry, coordinatorKey());
  if (found === null) return null;
  /* An expired lease is a record nobody stands behind: its holder may be gone. */
  return isLeaseExpired(found.value, nowDate(daemon.registry)) ? null : found.value;
}

/**
 * Forwards this request to the node holding the lease, speaking as this node.
 *
 * The caller's own authorization was settled HERE — an operator's scope is
 * checked against the project in the path before any of this — so the hop
 * carries this node's identity rather than the caller's, and the coordinator
 * answers a peer of its own installation.
 */
async function forwardToCoordinator(
  daemon: DaemonContext,
  event: H3Event,
  nodeId: string,
): Promise<Response> {
  const signingKey = daemon.signingKey;
  if (signingKey === undefined) {
    throw new ScafoError("capability-missing", "This node cannot reach the coordinator", {
      detail:
        `it holds no signing key, so it cannot present a node token to node "${nodeId}"; ` +
        `send the request to the coordinator directly`,
    });
  }

  const record = await getNode(daemon.registry, nodeId);
  /*
   * A FRESH token, signed by this node for itself. The caller's token is never
   * forwarded: a node token is single-use, so the one this request arrived with
   * was spent the moment it was verified here and the coordinator would refuse
   * it as a replay. Forwarding it would also hand one caller's credential to
   * another node, which is a thing this node is trusted not to do.
   */
  const token = await signNodeToken(signingKey, daemon.nodeId);
  return forwardToNode(daemon, event, record, { authorization: `Bearer ${token}` });
}
