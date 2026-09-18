/* Plumbing every route of the node API shares: bearer authentication and error rendering. */

import type { H3Event, HTTPError, Middleware } from "h3";
import type { NodeIdentity, NodeVerifier } from "../core/auth/node-token.ts";
import { isScafoError, type ProblemDetails, ScafoError } from "../core/error.ts";
import type { RegistryContext } from "../core/registry/context.ts";
import { getOperator, type TrustedOperator } from "../core/registry/operators.ts";
import { stableStringify } from "../core/utils/json.ts";

/** Context key the verified caller is filed under for the rest of the request. */
const IDENTITY_KEY = "scafoIdentity";

/** Verifies a bearer token and attaches its identity. Authentication failures
    remain uniformly `auth-invalid`. */
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

/** Requires a current operator token. Re-reads its record so a cached revoked or
    replaced key cannot administer durable authority. */
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

/** Renders RFC 9457 errors. Unexpected failures are logged and return a bare 500. */
export function renderProblem(error: HTTPError): Response {
  return problemResponse(
    toProblem(error),
    isScafoError(error.cause) && error.cause.code === "deploy-overloaded"
      ? { "retry-after": "1" }
      : undefined,
  );
}

/** Builds a consistent problem response with optional status headers. */
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

  /* Do not expose unexpected internals to clients. */
  console.error("[scafo] unhandled error while serving a request", error);
  return new ScafoError("internal", "Internal Server Error").toProblem();
}

/** Reads a bearer token; missing and malformed headers are `auth-invalid`. */
export function bearerToken(event: H3Event): string {
  const header = event.req.headers.get("authorization") ?? "";
  const token = /^bearer\s+(?<token>\S+)$/i.exec(header)?.groups?.token;

  if (token === undefined) {
    /* Preserve uniform client-visible authentication failure. */
    throw new ScafoError("auth-invalid", "Authentication failed", {
      cause: new Error("Authorization header is missing or is not a bearer token"),
    });
  }
  return token;
}
