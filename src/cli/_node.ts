/*
 * Internal: how a command talks to a node's API — one call, one fresh
 * token, and a failure answer read back as the failure it describes.
 *
 * Shared by every command that reaches a node rather than the bucket, so they
 * all report a refusal the same way. What a node answers is what the operator
 * sees.
 */

import { signNodeToken } from "../core/auth/node-token.ts";
import { fromProblem, type ProblemDetails, ScafoError } from "../core/error.ts";
import type { OperatorKeyFile } from "./_operator-key.ts";

/** Mints one bearer token per request; a spent one is refused as a replay. */
export type Authorize = () => Promise<string>;

/**
 * Signs one token per request with an operator key.
 *
 * A fresh token every time is not caution but necessity: a node spends the `jti`
 * of each token it accepts, so the second request to present the same one is
 * refused as a replay.
 */
export function operatorSigner(key: OperatorKeyFile): Authorize {
  return () => signNodeToken(key.privateKey, key.id);
}

/** A {@link RequestInit}, plus the seam that decides who actually makes the call. */
export interface NodeCallOptions extends RequestInit {
  /** How the call is made; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Required by Node fetch for a streaming request body. */
  duplex?: "half";
}

/** One node, and who is speaking to it: what every group of commands is built on. */
export interface NodeOptions {
  /** Base URL of the node daemon, without a trailing separator. */
  url: string;
  /** Mints one fresh token per call; node tokens are single-use. */
  authorize: Authorize;
  /** How the calls are made; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * One call to the daemon, with a failure answer turned back into the failure it
 * describes.
 *
 * The problem document's own code is kept rather than replaced. It is the stable
 * half of the contract, and a caller acts on it: `trust-mismatch` says the token
 * is fine and the application does not admit it — a policy to fix — while
 * `auth-invalid` says the token itself did not hold up. Flattening both into one
 * code here would hand the caller the one thing the API is careful to keep
 * distinguishable, already thrown away.
 *
 * An answer that carries no problem document at all is only an HTTP status, so
 * it becomes the generic failure it is.
 */
export async function nodeRequest(
  url: string,
  token: string,
  opts?: NodeCallOptions,
): Promise<Response> {
  /* Destructured out rather than passed through: it is this module's seam, not
     something `fetch` should ever be handed. */
  const { fetchFn = globalThis.fetch, ...init } = opts ?? {};
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);

  const response = await fetchFn(url, { ...init, headers });
  if (response.ok) return response;

  /* Carried onto the failure rather than dropped: a node that refuses a deploy
     because its queue is full says how long to wait, and a caller that retried
     on a number of its own would be ignoring the only party that knows. */
  const retryAfterMs = retryAfterOf(response.headers.get("retry-after"));

  /* Whatever answered may not have been a node at all — a proxy, a gateway, an
     error page — so the body is only used when it looks like a problem
     document, and is otherwise the bare status it really is. */
  const body: unknown = await response.json().catch(() => null);
  const problem = body as Partial<ProblemDetails> | null;
  if (typeof problem?.type !== "string" || typeof problem.title !== "string") {
    throw new ScafoError("invalid-input", `Node answered ${String(response.status)}`, {
      status: response.status,
      detail: `${init.method ?? "GET"} ${url}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  throw fromProblem(
    { ...(problem as ProblemDetails), status: response.status },
    undefined,
    retryAfterMs === undefined ? {} : { retryAfterMs },
  );
}

/**
 * A `Retry-After` header as milliseconds, or undefined when there was none or it
 * said nothing usable.
 *
 * Both spellings HTTP allows: a number of seconds, and an absolute date. A date
 * already in the past is no wait at all rather than a negative one.
 */
export function retryAfterOf(header: string | null): number | undefined {
  if (header === null) return undefined;

  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** Strips the trailing separator an operator's `--node` often carries. */
export function nodeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}
