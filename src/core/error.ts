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
      type: `urn:scalo:${this.code}`,
      title: this.message,
      status: this.status,
    };
    if (this.detail !== undefined) problem.detail = this.detail;
    return problem;
  }
}

/** Narrows an unknown thrown value to {@link ScaloError}. */
export function isScaloError(err: unknown): err is ScaloError {
  return err instanceof ScaloError;
}
