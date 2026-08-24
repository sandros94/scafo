/*
 * Internal: the two hops a held request can take — down to the process a wake
 * has just brought up, or across to the daemon of a node the placement assigned.
 *
 * Both are the same act: the request is streamed on as it arrived, and whatever
 * answers is streamed back verbatim. What differs is where it is dialled and
 * which one header describes the hop.
 */

import type { H3Event } from "h3";
import type { NodeRecord } from "../core/types/registry.ts";
import { peerUrl, PROXIED_HEADER, PROXIED_VALUE } from "./_peer.ts";

/**
 * Headers that describe ONE hop and must never be carried to the next one. Sent
 * on and received back: a `connection` relayed to a runtime process, or a
 * `transfer-encoding` relayed back to the ingress, describes a connection that
 * is not the one it ends up on.
 */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  /* The upstream is dialled by address; the name the caller asked for travels as
     `x-forwarded-host`, which is what the ingress would have sent. */
  "host",
]);

/**
 * Headers of the ANSWER that describe how it arrived here rather than what it
 * is. `content-encoding` and `content-length` are the load-bearing pair: `fetch`
 * decodes a compressed body on the way in and leaves both headers in place, so
 * relaying them verbatim would label a plain body as gzip and give a length that
 * is not the one being sent.
 */
const HOP_BY_HOP_RESPONSE: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP,
  "content-encoding",
  "content-length",
  "proxy-authenticate",
]);

/**
 * Forwards the held request to a loopback process and answers with whatever it
 * says, streaming both ways.
 *
 * The request arrives here exactly as the ingress received it, so the process
 * must be told what the ingress knows and this hop would otherwise erase: the
 * name that was asked for and the scheme it was asked over. Both go in the
 * headers the runtime already trusts. A `x-forwarded-proto` that arrived with
 * the request is kept rather than restated — the ingress terminated the TLS and
 * is the only party that knows — and only a request that carries none is
 * described from this hop, which is the one scafo itself made.
 *
 * Status, headers and body come back untouched, including redirects: a `3xx` is
 * the application's answer to the caller and is never followed here.
 *
 * `upstreamHost` is WHERE THE PROCESS BINDS and is required for that reason: it
 * is loopback on a single node and the node's tunnel address on a fleet, where
 * `127.0.0.1` answers nothing at all. This is one of the three dialers of a
 * process this node started — the readiness gate and the ingress are the others
 * — and all three take the same value from `runtimeDialHost`.
 */
export function proxyToProcess(
  event: H3Event,
  opts: { port: number; host: string; upstreamHost: string; fetchFn?: typeof fetch },
): Promise<Response> {
  const headers = carriedHeaders(event);
  headers.set("x-forwarded-host", opts.host);
  headers.set(
    "x-forwarded-proto",
    event.req.headers.get("x-forwarded-proto") ?? event.url.protocol.replace(/:$/, ""),
  );

  const url = `http://${opts.upstreamHost}:${String(opts.port)}${event.url.pathname}${event.url.search}`;
  return relay(event, url, headers, opts.fetchFn);
}

/**
 * Forwards the held request to the daemon of a node the placement DID assign, and
 * answers with whatever that node says, streaming both ways.
 *
 * THE NAME THE WAKE WAS ASKED AT TRAVELS AS `x-forwarded-host`. The peer is
 * dialled by address, so `Host` names that address rather than the name — and
 * `fetch` forbids setting `host` on the way out in any case — while the remote
 * daemon decides which surface answers by name alone. The header the ingress
 * would have used is therefore what carries it, and the remote reads it BECAUSE
 * of the loop-guard header below; see `requestHost` in `wake.ts` for how narrow
 * that reading is and why.
 *
 * `x-forwarded-proto` is neither set nor restated here: whatever the ingress put
 * there travels with the rest of the request, and the remote's own hop down to
 * the process keeps it. This node knows nothing about that TLS the ingress at
 * the other end of the request does not already know.
 *
 * The loop guard rides along, so the node that receives this forwards it
 * nowhere: it serves the request or refuses it, whatever it reads the placement
 * as.
 */
export function forwardWake(
  event: H3Event,
  opts: { node: NodeRecord; host: string; fetchFn?: typeof fetch },
): Promise<Response> {
  const headers = carriedHeaders(event);
  headers.set("x-forwarded-host", opts.host);
  headers.set(PROXIED_HEADER, PROXIED_VALUE);

  const url = peerUrl(opts.node, `${event.url.pathname}${event.url.search}`);
  return relay(event, url, headers, opts.fetchFn);
}

/**
 * Sends the held request on and hands back what answered, both bodies streamed
 * rather than buffered: a wake is answered by an application, and an application
 * is entitled to stream megabytes or to take its time about it.
 */
async function relay(
  event: H3Event,
  url: string,
  headers: Headers,
  fetchFn?: typeof fetch,
): Promise<Response> {
  const method = event.req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : (event.req.body ?? undefined);

  const upstream = await (fetchFn ?? fetch)(url, {
    method,
    headers,
    body,
    /* Required by Node whenever a body is a stream, and this one always is. */
    ...(body === undefined ? {} : { duplex: "half" }),
    redirect: "manual",
    /* A caller that gave up takes the upstream request with it. */
    signal: event.req.signal,
  } as RequestInit);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream),
  });
}

/** The request's headers, minus the ones that belong to the hop it arrived over. */
function carriedHeaders(event: H3Event): Headers {
  const headers = new Headers();
  /* Anything a `connection` header nominates is hop-by-hop for this hop alone,
     whatever it is called. */
  const nominated = connectionTokens(event.req.headers.get("connection"));

  for (const [name, value] of event.req.headers) {
    if (HOP_BY_HOP.has(name) || nominated.has(name)) continue;
    headers.append(name, value);
  }
  return headers;
}

/**
 * The answer's headers, minus the ones that belong to the hop it came over.
 *
 * `set-cookie` is taken separately because it is the one header that legitimately
 * appears more than once: iterating `Headers` joins its values with a comma,
 * which is not a cookie a browser can read back.
 */
function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  const nominated = connectionTokens(upstream.headers.get("connection"));

  for (const [name, value] of upstream.headers) {
    if (HOP_BY_HOP_RESPONSE.has(name) || nominated.has(name) || name === "set-cookie") continue;
    headers.append(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) headers.append("set-cookie", cookie);

  return headers;
}

/** The header names a `connection` header nominates as hop-by-hop. */
function connectionTokens(connection: string | null): ReadonlySet<string> {
  return new Set(
    (connection ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}
