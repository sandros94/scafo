/* Internal: operator-ordered environment deletion, and the hop to the coordinator. */

import type { H3Event } from "h3";
import { signNodeToken } from "../core/auth/node-token.ts";
import { ScaloError } from "../core/error.ts";
import { readJson } from "../core/registry/cas.ts";
import { nowDate } from "../core/registry/context.ts";
import { isLeaseExpired } from "../core/registry/lease.ts";
import { getNode } from "../core/registry/nodes.ts";
import { coordinatorKey } from "../core/registry/paths.ts";
import { deleteEnvironment } from "../core/registry/reaper.ts";
import type { CoordinatorLease } from "../core/types/registry.ts";
import type { AgentContext, EnvironmentDeleted } from "./app.ts";

/**
 * Marks a request one node has already forwarded to another. A request carrying
 * it is never forwarded again: the mesh is one hop between peers, and a ring of
 * nodes each convinced the next one coordinates would forward forever.
 */
export const PROXIED_HEADER: string = "x-scalo-proxied";

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
  agent: AgentContext,
  event: H3Event,
): Promise<Response | EnvironmentDeleted> {
  const project = event.context.params?.project ?? "";
  const env = event.context.params?.env ?? "";
  const coordinator = agent.coordinator;

  let lease = await currentLease(agent);
  if (lease === null && coordinator !== undefined) {
    /* Nobody coordinates yet, which is the ordinary state of an installation
       that has just booted rather than a failure. This node offers itself once
       instead of asking the operator to come back later. */
    await coordinator.runOnce();
    lease = await currentLease(agent);
  }

  const handle = coordinator?.handle() ?? null;
  if (handle !== null && lease?.node === agent.nodeId) {
    return deleteEnvironment(agent.registry, project, env, handle);
  }

  if (lease === null) {
    throw new ScaloError("draining", "No node is coordinating", {
      detail:
        `no node holds the coordinator lease, and this one could not take it, so there is ` +
        `nowhere to carry out the deletion of "${project}/${env}" right now`,
    });
  }

  if (event.req.headers.get(PROXIED_HEADER) === "1") {
    /* Loop guard. The lease moved between the hop being decided and this node
       reading it, so the forward landed on a node that does not coordinate
       either. Refused rather than forwarded on: the caller retries against a
       settled lease, and no request circles the mesh. */
    throw new ScaloError("draining", "Not the coordinator", {
      detail:
        `this request was already forwarded once, and node "${agent.nodeId}" does not hold ` +
        `the coordinator lease — node "${lease.node}" does as of this read`,
    });
  }

  return forwardToCoordinator(agent, event, lease.node);
}

/** The lease as it stands, or null when nobody holds a live one. */
async function currentLease(agent: AgentContext): Promise<CoordinatorLease | null> {
  const found = await readJson<CoordinatorLease>(agent.registry, coordinatorKey());
  if (found === null) return null;
  /* An expired lease is a record nobody stands behind: its holder may be gone. */
  return isLeaseExpired(found.value, nowDate(agent.registry)) ? null : found.value;
}

/**
 * Forwards this request to the node holding the lease and returns what it
 * answered, unchanged. The coordinator's answer is the answer — including its
 * problem document, which explains a refusal better than a relayed summary.
 */
async function forwardToCoordinator(
  agent: AgentContext,
  event: H3Event,
  nodeId: string,
): Promise<Response> {
  const signingKey = agent.signingKey;
  if (signingKey === undefined) {
    throw new ScaloError("capability-missing", "This node cannot reach the coordinator", {
      detail:
        `it holds no signing key, so it cannot present a node token to node "${nodeId}"; ` +
        `send the request to the coordinator directly`,
    });
  }

  const record = await getNode(agent.registry, nodeId);
  const host = record.addresses.internal;
  /* An IPv6 literal is only a URL authority once it is bracketed. */
  const authority = host.includes(":") ? `[${host}]` : host;
  const url = `http://${authority}:${String(record.addresses.agentPort)}${event.url.pathname}`;

  /*
   * A FRESH token, signed by this node for itself. The caller's token is never
   * forwarded: a node token is single-use, so the one this request arrived with
   * was spent the moment it was verified here and the coordinator would refuse
   * it as a replay. Forwarding it would also hand one caller's credential to
   * another node, which is a thing this node is trusted not to do.
   */
  const token = await signNodeToken(signingKey, agent.nodeId);
  const fetchFn = agent.fetchFn ?? globalThis.fetch;
  const answer = await fetchFn(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}`, [PROXIED_HEADER]: "1" },
  });

  const contentType = answer.headers.get("content-type");
  return new Response(await answer.text(), {
    status: answer.status,
    headers: contentType === null ? {} : { "content-type": contentType },
  });
}
