/* Plumbing every agent route shares: bearer authentication and error rendering. */

import type { H3Event, HTTPError, Middleware } from "h3";
import type { NodeIdentity, NodeVerifier } from "../core/auth/node-token.ts";
import { isScaloError, type ProblemDetails, ScaloError } from "../core/error.ts";

/** Context key the verified caller is filed under for the rest of the request. */
const IDENTITY_KEY = "scaloIdentity";

/**
 * Guards a route with a node or operator token: `Authorization: Bearer <jws>`,
 * verified against the public keys the registry holds. The identity it resolves
 * is attached to the event, where {@link nodeIdentity} reads it back.
 *
 * Every rejection is the verifier's uniform `ScaloError("auth-invalid")`, so a
 * caller cannot tell a forged token from an expired or a replayed one.
 */
export function requireNodeToken(verifier: NodeVerifier): Middleware {
  return async (event, next) => {
    event.context[IDENTITY_KEY] = await verifier.verify(bearerToken(event));
    return next();
  };
}

/** The identity {@link requireNodeToken} verified, or undefined on open routes. */
export function nodeIdentity(event: H3Event): NodeIdentity | undefined {
  return event.context[IDENTITY_KEY] as NodeIdentity | undefined;
}

/**
 * Turns any failure into an RFC 9457 `application/problem+json` response: a
 * {@link ScaloError} keeps its code, status and detail, an error raised by the
 * HTTP layer itself (no route matched, malformed URL) keeps its status, and
 * anything unexpected becomes a bare 500 that reveals nothing about the node.
 *
 * Install as the app's `onError` hook; it is also what logs the unexpected ones.
 */
export function renderProblem(error: HTTPError): Response {
  const problem = toProblem(error);
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "content-type": "application/problem+json" },
  });
}

function toProblem(error: HTTPError): ProblemDetails {
  /* The HTTP layer wraps whatever a handler threw and keeps the original as `cause`. */
  if (isScaloError(error.cause)) return error.cause.toProblem();

  if (error.unhandled !== true) {
    return {
      type: "about:blank",
      title: error.statusText ?? error.message,
      status: error.status,
    };
  }

  /* Unexpected: the operator gets the whole error, the client gets a status. */
  console.error("[scalo] unhandled error while serving a request", error);
  return { type: "urn:scalo:internal", title: "Internal Server Error", status: 500 };
}

function bearerToken(event: H3Event): string {
  const header = event.req.headers.get("authorization") ?? "";
  const token = /^bearer\s+(?<token>\S+)$/i.exec(header)?.groups?.token;

  if (token === undefined) {
    /* Shaped like every other authentication failure: no message, no detail,
       the reason only in `cause` where it reaches the logs and not the client. */
    throw new ScaloError("auth-invalid", "Authentication failed", {
      cause: new Error("Authorization header is missing or is not a bearer token"),
    });
  }
  return token;
}
