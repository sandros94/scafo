import { ScafoError } from "../../core/error.ts";
import type { ByteRange, CasHeaders, CasStore, StoredObject } from "../../core/types/store.ts";

/** In-process `CasStore` matching S3 conditional-write semantics; not persistent. */
/** An object as it was written, before a reader asked for it as text. */
interface StoredBytes {
  body: string | Uint8Array;
  etag: string;
}

export class MemoryCasStore implements CasStore {
  /* Preserve bytes exactly, including binary observations. */
  readonly #objects = new Map<string, StoredBytes>();
  #sequence = 0;

  /** Number of stored objects. */
  get size(): number {
    return this.#objects.size;
  }

  get(key: string): Promise<StoredObject | null> {
    const found = this.#objects.get(key);
    if (found === undefined) return Promise.resolve(null);
    return Promise.resolve({
      body: typeof found.body === "string" ? found.body : new TextDecoder().decode(found.body),
      etag: found.etag,
    });
  }

  /** Original bytes, or null when absent; a `range` is answered as a 206 is. */
  getBytes(key: string, opts?: { range: ByteRange }): Promise<Uint8Array | null> {
    const found = this.#objects.get(key);
    if (found === undefined) return Promise.resolve(null);
    const bytes =
      typeof found.body === "string" ? new TextEncoder().encode(found.body) : found.body;
    /* Both ends inclusive, which is one past the end for `subarray`. */
    return Promise.resolve(
      opts === undefined ? bytes : bytes.subarray(opts.range.start, opts.range.end + 1),
    );
  }

  /* async so conflicts surface as rejections, matching the S3 driver. */
  async put(key: string, body: string | Uint8Array, cas?: CasHeaders): Promise<{ etag: string }> {
    const current = this.#objects.get(key);

    if (cas?.ifNoneMatch === "*" && current !== undefined) {
      throw conflict(key, `object already exists with etag ${current.etag}`);
    }
    if (cas?.ifMatch !== undefined && cas.ifMatch !== current?.etag) {
      throw conflict(
        key,
        current === undefined
          ? `expected etag ${cas.ifMatch} but the object does not exist`
          : `expected etag ${cas.ifMatch} but found ${current.etag}`,
      );
    }

    this.#sequence++;
    const etag = `m${this.#sequence}`;
    this.#objects.set(key, { body, etag });
    return Promise.resolve({ etag });
  }

  del(key: string): Promise<void> {
    this.#objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string): Promise<string[]> {
    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return Promise.resolve(keys);
  }

  /** Drops every object; the etag sequence keeps running. */
  clear(): void {
    this.#objects.clear();
  }
}

export function createMemoryStore(): MemoryCasStore {
  return new MemoryCasStore();
}

function conflict(key: string, detail: string): ScafoError {
  return new ScafoError("cas-conflict", `Conditional write failed for "${key}"`, {
    status: 412,
    detail,
  });
}
