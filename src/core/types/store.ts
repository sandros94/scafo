/* Minimal conditional-write object store the registry runs on. */

/** Conditional-write preconditions, mapped onto HTTP `If-Match` / `If-None-Match`. */
export interface CasHeaders {
  /** Write only when the current object ETag matches this value verbatim. */
  ifMatch?: string;
  /** Write only when the object does not exist yet. */
  ifNoneMatch?: "*";
}

/**
 * A span of an object, as HTTP means it: `Range: bytes=start-end`, zero-based,
 * with BOTH ENDS INCLUSIVE. The same shape uns3 takes, so a driver hands it
 * straight through rather than translating an off-by-one at every call.
 */
export interface ByteRange {
  /** Zero-based offset of the first byte wanted. */
  start: number;
  /** Zero-based offset of the last byte wanted, inclusive. */
  end: number;
}

/** One object a listing named, together with what the listing itself said about it. */
export interface StoredEntry {
  /** The key, exactly as {@link CasStore.list} would have returned it. */
  key: string;
  /**
   * When the store says the object was last written, when its listing carried a
   * timestamp that reads as a date. A store that said nothing usable leaves it
   * out rather than guessing, and a caller that needs an age reads the absence
   * as "not old enough to act on".
   */
  lastModified?: Date;
}

/** An object body together with the ETag needed to condition the next write. */
export interface StoredObject {
  /**
   * The object as TEXT, which is what every record in this registry is. An object
   * written as bytes — the columnar observation files, and nothing else — reads
   * back through the same UTF-8 decode a bucket's own `Response.text()` applies,
   * so it is not read this way: {@link CasStore.getBytes} is.
   */
  body: string;
  /** Store-supplied ETag, kept verbatim (quotes included) so it round-trips into `ifMatch`. */
  etag: string;
}

export interface CasStore {
  /* Returns null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;
  /*
   * The object EXACTLY as it was written, or null when the key does not exist.
   *
   * The one read that is not text, and it is a second method rather than a
   * second field on {@link StoredObject} because the two reads want different
   * things. A registry read wants the record AND the ETag that conditions the
   * next write; a read of an observation flush wants a columnar file, is never
   * conditioned on anything, and would be destroyed by the UTF-8 decode `get`
   * applies — a Parquet file through a `TextDecoder` is no longer one. Nothing
   * needs both, so nothing pays for both.
   *
   * With a `range`, the answer is EXACTLY the bytes it asked for — the store's
   * own `206`, not a slice taken here. A store that ignores `Range` answers the
   * whole object with a `200` instead, and a driver that let that through would
   * hand back bytes the caller then reads as the range it wanted; it MUST throw
   * `ScafoError("store-nonconforming")` instead. Cell runtimes read their
   * artifacts by range, so a store that cannot do this cannot serve them.
   */
  getBytes(key: string, opts?: { range: ByteRange }): Promise<Uint8Array | null>;
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
  /*
   * The same listing in the same order, each key carrying what the store said
   * about the object beside it.
   *
   * A LISTING RATHER THAN A `head` PER KEY, because a bucket listing already
   * answers with a modification time on every page {@link CasStore.list}
   * already walks: asking the age of a prefix holding thousands of shared asset
   * blobs costs the requests the listing costs, where one `head` each would
   * cost one request per blob. It is a second method rather than a richer
   * `list` because every other caller here wants keys and nothing else.
   */
  listEntries(prefix: string): Promise<StoredEntry[]>;
}
