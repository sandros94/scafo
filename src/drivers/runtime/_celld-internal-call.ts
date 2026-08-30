/* Transport boundary for celld's internal operator API. */

import { isScafoError, ScafoError } from "../../core/error.ts";
import type { CelldInternalResponse } from "./_celld-internal-contract.ts";

interface CelldInternalRequest {
  method: "GET" | "POST";
  path: "/reload" | "/state";
  fetchFn: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
}

export async function callCelldInternal(
  origin: string,
  request: CelldInternalRequest,
): Promise<CelldInternalResponse> {
  const { method, path, fetchFn, timeoutMs } = request;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal =
    request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
  if (signal.aborted) {
    throw callFailed(method, path, timeoutMs, timeout, request.signal, signal.reason);
  }
  let response: Response;
  try {
    response = await abortable(
      fetchFn(`${origin}${path}`, { method, headers: { accept: "application/json" }, signal }),
      signal,
    );
  } catch (error) {
    throw callFailed(method, path, timeoutMs, timeout, request.signal, error);
  }

  let text: string;
  try {
    text = await abortable(response.text(), signal);
  } catch (error) {
    throw callFailed(method, path, timeoutMs, timeout, request.signal, error);
  }

  try {
    return { status: response.status, body: JSON.parse(text) as unknown, method, path };
  } catch (error) {
    throw invalidCelldInternalResponse(method, path, "answered something that is not JSON", error);
  }
}

export function celldInternalOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (cause) {
    throw new ScafoError("invalid-input", "Runtime internal endpoint is not a URL", {
      detail: `"${endpoint}" must be an HTTP or HTTPS origin`,
      cause,
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ScafoError("invalid-input", "Runtime internal endpoint is not an origin", {
      detail: `"${endpoint}" must contain only an HTTP or HTTPS origin`,
    });
  }
  return url.origin;
}

function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

function callFailed(
  method: string,
  path: string,
  timeoutMs: number,
  timeout: AbortSignal,
  caller: AbortSignal | undefined,
  cause: unknown,
): ScafoError {
  if (caller?.aborted && isScafoError(caller.reason)) return caller.reason;
  const what = timeout.aborted
    ? `timed out after ${String(timeoutMs)}ms`
    : caller?.aborted
      ? "was cancelled"
      : "could not be reached";
  return new ScafoError("capability-missing", "Runtime operator API failed", {
    status: 502,
    detail: `celld internal API ${what} for ${method} ${path}`,
    cause,
  });
}

export function invalidCelldInternalResponse(
  method: string,
  path: string,
  what: string,
  cause?: unknown,
): ScafoError {
  return new ScafoError("capability-missing", "Runtime operator API failed", {
    status: 502,
    detail: `celld internal API ${what} for ${method} ${path}`,
    cause,
  });
}
