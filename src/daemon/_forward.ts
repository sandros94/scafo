/* Internal: the one hop a node makes to another node's daemon on a caller's behalf. */

import type { H3Event } from "h3";
import type { NodeRecord } from "../core/types/registry.ts";
import type { DaemonContext } from "./app.ts";
import { peerUrl, PROXIED_HEADER, PROXIED_VALUE } from "./_peer.ts";

export interface ForwardOptions {
  /**
   * The whole `authorization` header the hop presents. Which credential belongs
   * there is the forwarding route's decision, not this function's: a route that
   * has already authorized the request itself speaks as this node, and one whose
   * authorization only the peer can settle passes the caller's own through.
   */
  authorization: string;
}

/**
 * Forwards this request to `node` and returns what it answered, unchanged. The
 * peer's answer is the answer — including its problem document, which explains a
 * refusal better than a relayed summary.
 *
 * The hop is marked as one, so the node it reaches answers rather than forwards
 * again: the mesh is one hop between peers, and a ring of nodes each convinced
 * the next one should take the request would forward forever.
 */
export async function forwardToNode(
  daemon: DaemonContext,
  event: H3Event,
  node: NodeRecord,
  opts: ForwardOptions,
): Promise<Response> {
  /* Path AND query: a hop that dropped the query would carry out a different
     request than the one that was made. */
  const url = peerUrl(node, `${event.url.pathname}${event.url.search}`);
  const fetchFn = daemon.fetchFn ?? globalThis.fetch;
  const answer = await fetchFn(url, {
    method: event.req.method,
    headers: { authorization: opts.authorization, [PROXIED_HEADER]: PROXIED_VALUE },
  });

  const contentType = answer.headers.get("content-type");
  return new Response(await answer.text(), {
    status: answer.status,
    headers: contentType === null ? {} : { "content-type": contentType },
  });
}
