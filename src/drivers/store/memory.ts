import { ScafoError } from "../../core/error.ts";
import type { CasHeaders, CasStore, StoredObject } from "../../core/types/store.ts";

/**
 * In-process {@link CasStore} with the same conditional-write semantics as the
 * S3 driver. Intended for tests and local development — nothing is persisted.
 */
export class MemoryCasStore implements CasStore {
  readonly #objects = new Map<string, StoredObject>();
  #sequence = 0;

  /** Number of stored objects. */
  get size(): number {
    return this.#objects.size;
  }

  get(key: string): Promise<StoredObject | null> {
    const found = this.#objects.get(key);
    return Promise.resolve(found === undefined ? null : { ...found });
  }

  /* async so conflicts surface as rejections, matching the S3 driver. */
  async put(key: string, body: string, cas?: CasHeaders): Promise<{ etag: string }> {
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
