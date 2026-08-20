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
  body: string;
  /** Store-supplied ETag, kept verbatim (quotes included) so it round-trips into `ifMatch`. */
  etag: string;
}

export interface CasStore {
  /* Returns null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;
  /* MUST throw ScafoError("cas-conflict") when a condition fails (HTTP 412). */
  put(key: string, body: string, cas?: CasHeaders): Promise<{ etag: string }>;
  del(key: string): Promise<void>;
  /* All keys under prefix, lexicographically sorted, fully paginated. */
  list(prefix: string): Promise<string[]>;
}
