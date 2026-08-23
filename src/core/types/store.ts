/* Minimal conditional-write object store the registry runs on. */

/** Conditional-write preconditions, mapped onto HTTP `If-Match` / `If-None-Match`. */
export interface CasHeaders {
  /** Write only when the current object ETag matches this value verbatim. */
  ifMatch?: string;
  /** Write only when the object does not exist yet. */
  ifNoneMatch?: "*";
}

/** An object body together with the ETag needed to condition the next write. */
export interface StoredObject {
  /**
   * The object as TEXT, which is what every record in this registry is. An object
   * written as bytes — the columnar observation files, and nothing else — reads
   * back through the same UTF-8 decode a bucket's own `Response.text()` applies,
   * so it is not read this way: those keys are read by whatever understands them.
   */
  body: string;
  /** Store-supplied ETag, kept verbatim (quotes included) so it round-trips into `ifMatch`. */
  etag: string;
}

export interface CasStore {
  /* Returns null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;
  /*
   * MUST throw ScafoError("cas-conflict") when a condition fails (HTTP 412).
   *
   * The body is TEXT for every record the registry keeps, and BYTES for an
   * encoding that is not UTF-8 — the observation flusher's columnar files. Bytes
   * are stored verbatim: a store that put them through a text round trip would
   * hand back replacement characters instead of the file that was written.
   */
  put(key: string, body: string | Uint8Array, cas?: CasHeaders): Promise<{ etag: string }>;
  del(key: string): Promise<void>;
  /* All keys under prefix, lexicographically sorted, fully paginated. */
  list(prefix: string): Promise<string[]>;
}
