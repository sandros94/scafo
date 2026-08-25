/* Plumbing every route of the node API shares: bearer authentication and error rendering. */

import type { H3Event, HTTPError, Middleware } from "h3";
import type { NodeIdentity, NodeVerifier } from "../core/auth/node-token.ts";
import { isScafoError, type ProblemDetails, ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { getOperator, type TrustedOperator } from "../core/registry/operators.ts";
import { stableStringify } from "../core/utils/json.ts";

/** Context key the verified caller is filed under for the rest of the request. */
const IDENTITY_KEY = "scafoIdentity";

/**
 * Guards a route with a node or operator token: `Authorization: Bearer <jws>`,
 * verified against the public keys the registry holds. The identity it resolves
 * is attached to the event, where {@link nodeIdentity} reads it back.
 *
 * Every rejection is the verifier's uniform `ScafoError("auth-invalid")`, so a
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
 * Guards a route with an OPERATOR's token: the same verification
 * {@link requireNodeToken} does, with the namespace the exact verification key
 * resolved from carried on the identity it returns.
 *
 * Every other authenticated route accepts any key the registry holds, because a
 * node calling a peer and an operator calling a node are the same kind of caller
 * there. Key administration is not: a node daemon that has been taken over must
 * not be able to write its installation a new operator, so a machine's own
 * token is authenticated here and then refused.
 *
 * That refusal is `ScafoError("auth-scope")` rather than the uniform
 * authentication rejection, and deliberately so — the caller has already proved
 * which key it holds, so there is nothing left to withhold, and telling it that
 * this surface is an operator's is the difference between a fixable mistake and
 * a mystery. A caller holding no node key at all never reaches the question.
 *
 * Key and project administration additionally read the current operator record
 * and require it to equal the authorization resolved with the signing key. The
 * verifier's public-key cache remains the revocation bound for ordinary work,
 * but a revoked cached key cannot use that window to mint durable authority.
 * A replacement record cannot lend its role or scope to the old signing key.
 */
export function requireOperatorToken(
  verifier: NodeVerifier,
  registry: RegistryContext,
): Middleware {
  return async (event, next) => {
    const identity = await verifier.verify(bearerToken(event));

    if (identity.kind !== "operator") {
      throw new ScafoError("auth-scope", "Not an operator of this fleet", {
        detail:
          `"${identity.nodeId}" is not an operator key of this installation, and the keys a ` +
          `fleet trusts are an operator's to administer`,
      });
    }

    const current = await getOperator(registry, identity.nodeId);
    if (current === null || stableStringify(current) !== stableStringify(identity.operator)) {
      throw new ScafoError("auth-invalid", "Authentication failed", {
        cause: new Error(`Operator authority for "${identity.nodeId}" is no longer current`),
      });
    }

    event.context[IDENTITY_KEY] = identity;
    return next();
  };
}

/**
 * The operator authorization the verifier resolved with its exact cached key,
 * or undefined when the verified caller is a node or no guard ran.
 */
export function operatorIdentity(event: H3Event): TrustedOperator | undefined {
  const identity = nodeIdentity(event);
  return identity?.kind === "operator" ? identity.operator : undefined;
}

/**
 * Turns any failure into an RFC 9457 `application/problem+json` response: a
 * {@link ScafoError} keeps its code, status and detail, an error raised by the
 * HTTP layer itself (no route matched, malformed URL) keeps its status, and
 * anything unexpected becomes a bare 500 that reveals nothing about the node.
 *
 * Install as the app's `onError` hook; it is also what logs the unexpected ones.
 */
export function renderProblem(error: HTTPError): Response {
  return problemResponse(
    toProblem(error),
    isScafoError(error.cause) && error.cause.code === "deploy-overloaded"
      ? { "retry-after": "1" }
      : undefined,
  );
}

/**
 * One problem document as an HTTP answer, and the single place their shape is
 * decided: what {@link renderProblem} ends in, and what a handler answering a
 * failure of its own — rather than throwing one — must go through, so that every
 * refusal a caller sees is the same document with the same content type.
 *
 * `headers` is for what a status needs beyond the body: a `Retry-After` on the
 * `503` a held request is given when it cannot be served in time.
 */
export function problemResponse(
  problem: ProblemDetails,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

function toProblem(error: HTTPError): ProblemDetails {
  /* The HTTP layer wraps whatever a handler threw and keeps the original as `cause`. */
  if (isScafoError(error.cause)) return error.cause.toProblem();

  if (error.unhandled !== true) {
    return {
      type: "about:blank",
      title: error.statusText ?? error.message,
      status: error.status,
    };
  }

  /* Unexpected: the operator gets the whole error, the client gets a status. */
  console.error("[scafo] unhandled error while serving a request", error);
  return { type: "urn:scafo:internal", title: "Internal Server Error", status: 500 };
}

/**
 * The bearer token a request presents. Throws the same
 * `ScafoError("auth-invalid")` every other rejection uses when there is none, so
 * a missing header is indistinguishable from a bad one.
 */
export function bearerToken(event: H3Event): string {
  const header = event.req.headers.get("authorization") ?? "";
  const token = /^bearer\s+(?<token>\S+)$/i.exec(header)?.groups?.token;

  if (token === undefined) {
    /* Shaped like every other authentication failure: no message, no detail,
       the reason only in `cause` where it reaches the logs and not the client. */
    throw new ScafoError("auth-invalid", "Authentication failed", {
      cause: new Error("Authorization header is missing or is not a bearer token"),
    });
  }
  return token;
}
