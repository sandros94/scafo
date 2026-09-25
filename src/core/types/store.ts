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
   * The object's ETag, in the SAME FORM {@link CasStore.get} and
   * {@link CasStore.put} answer with, so a listed entry and a read of the same
   * key compare equal with `===` and a cached one conditions a later write.
   *
   * REQUIRED, because it is what makes "read only what changed" possible: a
   * caller holding a listing and a cache of ETags knows which keys it has to
   * read and which it may skip. A store whose listing carries no ETag for an
   * entry is `ScafoError("store-nonconforming")` — there is nothing to compare,
   * and guessing "changed" would read the whole installation every pass while
   * guessing "unchanged" would never see a write at all.
   */
  etag: string;
  /**
   * When the store says the object was last written, when its listing carried a
   * timestamp that reads as a date. A store that said nothing usable leaves it
   * out rather than guessing, and a caller that needs an age reads the absence
   * as "not old enough to act on".
   */
  lastModified?: Date;
  /**
   * How many bytes the listing says the object holds, when it said. Nothing acts
   * on it: it is evidence for an operator reading a listing beside a `head` and a
   * `get` of the same key, which is the one place they can disagree.
   */
  size?: number;
}

/**
 * What the store says about one object without answering its body: the metadata
 * of a `HEAD`, or null when the store says there is no such object.
 *
 * EVERY FIELD IS OPTIONAL, deliberately. This is the read a diagnosis uses, and
 * the object it is pointed at is by definition one the store is answering
 * strangely about — a `HEAD` that came back without an ETag is itself the
 * finding, not a failure to raise over.
 */
export interface StoredHead {
  /** The ETag, in the form {@link CasStore.get} answers with, when there was one. */
  etag?: string;
  /** The object's length as the store declared it, when it declared one. */
  size?: number;
  /** When the store says it was last written, when it said something usable. */
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
   * What the store says about a key without reading it, or null when it says
   * there is nothing there.
   *
   * THE ONLY READ THAT ASKS THE STORE ABOUT AN OBJECT RATHER THAN FOR IT, and it
   * exists because those two answers can disagree. A bucket can hold a key its
   * listing names and its `HEAD` answers `200` for, whose `GET` is a `404` —
   * which is exactly what wedged a Celld node lease and is what `scafo app
   * lease` was written to diagnose. A listing is answered from the store's own
   * index and a `get` from the body; without this third read there is no way to
   * tell a corrupt object from a missing one, and nothing else here needs it.
   */
  head(key: string): Promise<StoredHead | null>;
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
