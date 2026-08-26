/**
 * Every failure surfaced by scafo carries one of these codes. The code is the
 * stable contract: messages may change, codes may not.
 */
export type ScafoErrorCode =
  | "auth-invalid"
  | "auth-scope"
  | "trust-mismatch"
  | "cas-conflict"
  | "capability-missing"
  | "build-not-runtime-configurable"
  | "placement-unavailable"
  | "project-blocked"
  | "wake-unavailable"
  | "capacity-unavailable"
  | "draining"
  | "deploy-overloaded"
  | "deploy-timeout"
  | "store-nonconforming"
  | "not-found"
  | "immutable"
  | "lease-lost"
  | "reference-held"
  | "resource-limit"
  | "invalid-slug"
  | "invalid-varset"
  | "invalid-input";

/** RFC 9457 problem document, as produced by {@link ScafoError.toProblem}. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

/** Extra construction options for {@link ScafoError}; `cause` follows `ErrorOptions`. */
export interface ScafoErrorOptions extends ErrorOptions {
  /** Overrides the default HTTP status mapped from the error code. */
  status?: number;
  /** Human-readable specifics safe to expose to API clients. */
  detail?: string;
}

const DEFAULT_STATUS: Record<ScafoErrorCode, number> = {
  "auth-invalid": 401,
  "auth-scope": 403,
  "trust-mismatch": 403,
  "cas-conflict": 409,
  "capability-missing": 409,
  "build-not-runtime-configurable": 409,
  "placement-unavailable": 409,
  /* An admin of the fleet has stopped the project. A CONFLICT rather than a
     forbidden: nothing is wrong with the caller or with its key, and the same
     request works unchanged the moment the block is lifted. */
  "project-blocked": 409,
  /* A host that IS wakeable, refused for now: over the node's wake cap, or past
     the deadline the request was held for. Always answered with a `Retry-After`,
     because the very next try may well succeed. */
  "wake-unavailable": 503,
  "capacity-unavailable": 503,
  "draining": 503,
  "deploy-overloaded": 429,
  "deploy-timeout": 408,
  "store-nonconforming": 500,
  "not-found": 404,
  "immutable": 409,
  "lease-lost": 409,
  "reference-held": 409,
  "resource-limit": 413,
  "invalid-slug": 400,
  "invalid-varset": 400,
  "invalid-input": 400,
};

/**
 * The single error type used across scafo. `status` defaults to the HTTP status
 * mapped from `code` and can be overridden per throw site.
 */
export class ScafoError extends Error {
  readonly code: ScafoErrorCode;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ScafoErrorCode, message: string, opts?: ScafoErrorOptions) {
    super(message, opts);
    this.name = "ScafoError";
    this.code = code;
    this.status = opts?.status ?? DEFAULT_STATUS[code];
    this.detail = opts?.detail;
  }

  /** Serializes the error into an RFC 9457 `application/problem+json` body. */
  toProblem(): ProblemDetails {
    const problem: ProblemDetails = {
      type: `${PROBLEM_TYPE_PREFIX}${this.code}`,
      title: this.message,
      status: this.status,
    };
    if (this.detail !== undefined) problem.detail = this.detail;
    return problem;
  }
}

/** Prefix every problem document's `type` carries. */
export const PROBLEM_TYPE_PREFIX: string = "urn:scafo:";

/** Narrows an unknown thrown value to {@link ScafoError}. */
export function isScafoError(err: unknown): err is ScafoError {
  return err instanceof ScafoError;
}

/**
 * One line describing whatever was thrown, for a status field or an event that
 * records a failure rather than raising it.
 *
 * The specifics a scafo failure carries are the useful half — the message says
 * what went wrong and the detail says about what — so both are kept. Anything
 * else is reduced to its message, and a value that is not an error at all to
 * whatever it stringifies as.
 */
export function describeError(error: unknown): string {
  if (isScafoError(error)) {
    return error.detail === undefined ? error.message : `${error.message}: ${error.detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a problem document back into the failure it was rendered from — the
 * inverse of {@link ScafoError.toProblem}, for a client holding one answer from
 * another process.
 *
 * The code is the contract, and it has to survive the wire: a caller that
 * re-labelled every failure answer with a code of its own would report a
 * `trust-mismatch` — the one rejection that is authorization rather than
 * authentication, and the only one a CI job can act on — as something else
 * entirely. A `type` this build does not know becomes `fallback`, because a
 * newer node naming a code this one has never heard of is a real thing and not
 * worth crashing over.
 *
 * Every field is checked rather than trusted. The type says what a scafo node
 * answers with, but what arrives may have come from a proxy, a load balancer or
 * an error page, and a client that threw a `TypeError` over one of those would
 * report the wrong failure entirely.
 */
export function fromProblem(
  problem: ProblemDetails,
  fallback: ScafoErrorCode = "invalid-input",
): ScafoError {
  const type = typeof problem.type === "string" ? problem.type : "";
  const named = type.startsWith(PROBLEM_TYPE_PREFIX) ? type.slice(PROBLEM_TYPE_PREFIX.length) : "";
  /* `hasOwn` rather than `in`: the document comes off the wire, and `in` would
     take "constructor" or "toString" for a code and hand back a status that is
     a function. */
  const code = Object.hasOwn(DEFAULT_STATUS, named) ? (named as ScafoErrorCode) : fallback;

  const title = typeof problem.title === "string" ? problem.title : "Request failed";
  const status = Number.isInteger(problem.status) ? problem.status : DEFAULT_STATUS[code];

  return new ScafoError(code, title, {
    status,
    ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
  });
}
