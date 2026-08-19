/**
 * Every failure surfaced by scalo carries one of these codes. The code is the
 * stable contract: messages may change, codes may not.
 */
export type ScaloErrorCode =
  | "auth-invalid"
  | "auth-scope"
  | "trust-mismatch"
  | "cas-conflict"
  | "capability-missing"
  | "build-not-runtime-configurable"
  | "placement-unavailable"
  | "draining"
  | "store-nonconforming"
  | "not-found"
  | "immutable"
  | "lease-lost"
  | "reference-held"
  | "invalid-slug"
  | "invalid-varset"
  | "invalid-input";

/** RFC 9457 problem document, as produced by {@link ScaloError.toProblem}. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

/** Extra construction options for {@link ScaloError}; `cause` follows `ErrorOptions`. */
export interface ScaloErrorOptions extends ErrorOptions {
  /** Overrides the default HTTP status mapped from the error code. */
  status?: number;
  /** Human-readable specifics safe to expose to API clients. */
  detail?: string;
}

const DEFAULT_STATUS: Record<ScaloErrorCode, number> = {
  "auth-invalid": 401,
  "auth-scope": 403,
  "trust-mismatch": 403,
  "cas-conflict": 409,
  "capability-missing": 409,
  "build-not-runtime-configurable": 409,
  "placement-unavailable": 409,
  "draining": 503,
  "store-nonconforming": 500,
  "not-found": 404,
  "immutable": 409,
  "lease-lost": 409,
  "reference-held": 409,
  "invalid-slug": 400,
  "invalid-varset": 400,
  "invalid-input": 400,
};

/**
 * The single error type used across scalo. `status` defaults to the HTTP status
 * mapped from `code` and can be overridden per throw site.
 */
export class ScaloError extends Error {
  readonly code: ScaloErrorCode;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ScaloErrorCode, message: string, opts?: ScaloErrorOptions) {
    super(message, opts);
    this.name = "ScaloError";
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
export const PROBLEM_TYPE_PREFIX: string = "urn:scalo:";

/** Narrows an unknown thrown value to {@link ScaloError}. */
export function isScaloError(err: unknown): err is ScaloError {
  return err instanceof ScaloError;
}

/**
 * Reads a problem document back into the failure it was rendered from — the
 * inverse of {@link ScaloError.toProblem}, for a client holding one answer from
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
 * Every field is checked rather than trusted. The type says what a scalo node
 * answers with, but what arrives may have come from a proxy, a load balancer or
 * an error page, and a client that threw a `TypeError` over one of those would
 * report the wrong failure entirely.
 */
export function fromProblem(
  problem: ProblemDetails,
  fallback: ScaloErrorCode = "invalid-input",
): ScaloError {
  const type = typeof problem.type === "string" ? problem.type : "";
  const named = type.startsWith(PROBLEM_TYPE_PREFIX) ? type.slice(PROBLEM_TYPE_PREFIX.length) : "";
  /* `hasOwn` rather than `in`: the document comes off the wire, and `in` would
     take "constructor" or "toString" for a code and hand back a status that is
     a function. */
  const code = Object.hasOwn(DEFAULT_STATUS, named) ? (named as ScaloErrorCode) : fallback;

  const title = typeof problem.title === "string" ? problem.title : "Request failed";
  const status = Number.isInteger(problem.status) ? problem.status : DEFAULT_STATUS[code];

  return new ScaloError(code, title, {
    status,
    ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
  });
}
