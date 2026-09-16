/* Internal: bounded, runtime-neutral JSON request intake. */

import type { H3Event } from "h3";
import { safeJsonParse } from "unsecure/sanitize";
import { ScafoError } from "../core/error.ts";
import { assertPositiveSafeInteger } from "../core/utils/number.ts";

/** Maximum bytes accepted by a JSON control request when the operator names none. */
export const DEFAULT_JSON_BYTES: number = 65_536;

export interface JsonBodyOptions {
  /** Maximum bytes accepted, including JSON whitespace. */
  maxBytes?: number;
}

/** Reads one complete JSON body without ever aggregating past its byte limit. */
export async function readJsonBody(event: H3Event, opts?: JsonBodyOptions): Promise<unknown> {
  const maxBytes: unknown =
    opts === undefined || opts.maxBytes === undefined ? DEFAULT_JSON_BYTES : opts.maxBytes;
  assertPositiveSafeInteger(maxBytes, "maxBytes");

  const contentLength = validContentLength(event.req.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    cancel(event.req.body);
    throw tooLarge(maxBytes);
  }

  const stream = event.req.body;
  if (stream === null) return parse(new Uint8Array());

  const signal = event.req.signal;
  const reader = stream.getReader();
  const cancelOnAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (signal.aborted) cancelOnAbort();
    throwIfRequestAborted(signal);
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        if (signal.aborted) throw requestAborted(signal);
        throw malformed("the body could not be read", error);
      }
      throwIfRequestAborted(signal);
      if (result.done) break;

      const chunk = result.value;
      if (chunk.byteLength > maxBytes - bytes) {
        void reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  throwIfRequestAborted(signal);

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parse(body);
}

function validContentLength(value: string | null): number | null {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cancel(stream: ReadableStream<Uint8Array> | null): void {
  void stream?.cancel().catch(() => {});
}

function parse(body: Uint8Array): unknown {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
    /* A request body is a caller's text: it becomes an object without the keys
       every object answers for on its own. */
    return safeJsonParse<unknown>(raw);
  } catch (error) {
    throw malformed("the body is not valid UTF-8 JSON", error);
  }
}

function tooLarge(maxBytes: number): ScafoError {
  return new ScafoError("resource-limit", "JSON body is too large", {
    detail: `the JSON request body exceeds the configured limit of ${String(maxBytes)} bytes`,
  });
}

function malformed(detail: string, cause?: unknown): ScafoError {
  return new ScafoError("invalid-input", "Malformed request", { detail, cause });
}

function throwIfRequestAborted(signal: AbortSignal): void {
  if (signal.aborted) throw requestAborted(signal);
}

function requestAborted(signal: AbortSignal): ScafoError {
  const cause =
    signal.reason instanceof Error
      ? signal.reason
      : new ScafoError("invalid-input", "Request was aborted", {
          detail: "the transport supplied no Error abort reason",
        });
  return malformed("the body could not be read because the request was aborted", cause);
}
