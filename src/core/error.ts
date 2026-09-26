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
  | "placement-unavailable"
  | "application-blocked"
  | "deploys-frozen"
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
  | "invalid-input"
  | "version-skew"
  | "store-unavailable"
  | "publish-failed"
  | "internal";

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
  /**
   * How long the answering node asked the caller to wait before trying again,
   * in milliseconds, read off its `Retry-After`.
   *
   * NOT PART OF THE PROBLEM DOCUMENT, and never rendered into one: it is a
   * transport header, it is the answering node's to set, and it is carried here
   * only so a client that retries has the number the node named rather than one
   * it invented.
   */
  retryAfterMs?: number;
}

const DEFAULT_STATUS: Record<ScafoErrorCode, number> = {
  "auth-invalid": 401,
  "auth-scope": 403,
  "trust-mismatch": 403,
  "cas-conflict": 409,
  "capability-missing": 409,
  "placement-unavailable": 409,
  /* An admin of the fleet has stopped the application. A CONFLICT rather than a
     forbidden: nothing is wrong with the caller or with its key, and the same
     request works unchanged the moment the block is lifted. */
  "application-blocked": 409,
  /* An admin of the fleet has stopped deploy intake, for a maintenance or an
     upgrade. A CONFLICT rather than a forbidden, for the same reason a blocked
     application is one: nothing is wrong with the caller or with its key, and the
     same request works unchanged the moment the freeze is lifted. */
  "deploys-frozen": 409,
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
  "invalid-input": 400,
  /* Two Celld versions over one application's fleet. A CONFLICT rather than a
     capability that is missing: every binary involved is one scafo runs, and
     what is wrong is the fleet's state rather than the caller or its node. */
  "version-skew": 409,
  /* The store stopped answering, and the write that wanted it was repeated until
     there was nothing left to repeat. UNAVAILABLE rather than a bucket that
     misbehaves: nothing about the answer was wrong, there was no answer. */
  "store-unavailable": 503,
  /* Celld's publish command ended badly, and an exit code plus prose is all it
     says about why. A BAD GATEWAY rather than a bad request: the artifact, the
     engine and the bucket are all possible causes, and naming the caller for
     every one of them would be a guess. Its own output is kept as the detail. */
  "publish-failed": 502,
  /* Something failed that scafo has no name for. It is the node's own, never
     the caller's: a failure nobody can name is not one to blame on the request,
     and what it was is in the node's log rather than in the answer. */
  "internal": 500,
};

/**
 * The single error type used across scafo. `status` defaults to the HTTP status
 * mapped from `code` and can be overridden per throw site.
 */
export class ScafoError extends Error {
  readonly code: ScafoErrorCode;
  readonly status: number;
  readonly detail?: string;
  /** See {@link ScafoErrorOptions.retryAfterMs}; absent when nothing said one. */
  readonly retryAfterMs?: number;

  constructor(code: ScafoErrorCode, message: string, opts?: ScafoErrorOptions) {
    super(message, opts);
    this.name = "ScafoError";
    this.code = code;
    this.status = opts?.status ?? DEFAULT_STATUS[code];
    this.detail = opts?.detail;
    this.retryAfterMs = opts?.retryAfterMs;
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
  opts?: { retryAfterMs?: number },
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
    ...(opts?.retryAfterMs === undefined ? {} : { retryAfterMs: opts.retryAfterMs }),
  });
}
