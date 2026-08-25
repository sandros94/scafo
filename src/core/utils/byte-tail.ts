import { ScafoError } from "../error.ts";

/** Fixed-size tail of a byte stream. Memory never exceeds the configured cap. */
export class ByteTail {
  readonly limit: number;
  #bytes: Uint8Array;
  #length = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ScafoError("invalid-input", "Invalid byte-tail limit", {
        detail: "limit must be a positive safe integer",
      });
    }
    this.limit = limit;
    this.#bytes = new Uint8Array(limit);
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.limit) {
      this.#bytes.set(chunk.subarray(chunk.byteLength - this.limit));
      this.#length = this.limit;
      return;
    }
    const keep = Math.min(this.#length, this.limit - chunk.byteLength);
    if (keep > 0) this.#bytes.copyWithin(0, this.#length - keep, this.#length);
    this.#bytes.set(chunk, keep);
    this.#length = keep + chunk.byteLength;
  }

  bytes(): Uint8Array {
    return this.#bytes.slice(0, this.#length);
  }
}

/** Decodes at most `limit` tail bytes without cutting a valid UTF-8 sequence. */
export function decodeUtf8Tail(bytes: Uint8Array, limit: number): string {
  let start = Math.max(0, bytes.byteLength - limit);
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  let end = bytes.byteLength;
  const selected = bytes.subarray(start, end);
  for (let trim = 0; trim <= 3 && end - trim >= start; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        selected.subarray(0, selected.byteLength - trim),
      );
    } catch {}
  }
  return new TextDecoder().decode(selected);
}
