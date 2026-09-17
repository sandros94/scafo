import { S3Error, type S3Client } from "uns3";
import { ScafoError } from "../../core/error.ts";
import type { ByteRange, CasStore, StoredEntry, StoredObject } from "../../core/types/store.ts";
import { withRetry } from "../../core/utils/backoff.ts";

/**
 * How many tries a write gets, and the first step of the jittered wait between
 * them, doubled at each one — the same range a read-modify-write gives a
 * conditional write it lost.
 */
const WRITE_ATTEMPTS = 5;
const WRITE_BASE_MS = 50;

export interface Uns3StoreOptions {
  bucket: string;
  /** Joined to every key with "/", and stripped back off `list` results. */
  prefix?: string;
}

/** S3-compatible registry store requiring conditional writes and PUT ETags. */
export function createUns3Store(client: S3Client, opts: Uns3StoreOptions): CasStore {
  const bucket = opts.bucket;
  const prefix = normalizePrefix(opts.prefix);
  const toObjectKey = (key: string): string => prefix + key;
  const toStoreKey = (objectKey: string): string =>
    objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey;

  /** One GET, with a missing key answered as null rather than raised. */
  const fetchObject = async (objectKey: string, range?: ByteRange): Promise<Response | null> => {
    try {
      return await client.get({
        bucket,
        key: objectKey,
        range,
        /* A ranged read is only answered by a `206`. Demanding it is what turns
           a store that ignores `Range` into a failure: it replies `200` with
           the whole object, which uns3 then raises because the status was not
           the one asked for, rather than handing back bytes the caller would
           read as the range it wanted. */
        expectedStatus: range === undefined ? undefined : 206,
      });
    } catch (error) {
      const status = statusOf(error);
      if (status === 404) return null;
      if (range !== undefined && status === 200) {
        throw new ScafoError("store-nonconforming", "Store does not honour ranged reads", {
          detail: `"${objectKey}" was answered whole (HTTP 200) instead of the range that was asked for`,
          cause: error,
        });
      }
      throw error;
    }
  };

  /** Every object under a prefix, fully paginated, sorted by key. */
  const listEntries = async (keyPrefix: string): Promise<StoredEntry[]> => {
    const entries: StoredEntry[] = [];
    const prefix = toObjectKey(keyPrefix);
    let next: { continuationToken: string } | { query: { marker: string } } | undefined;

    do {
      const page = await client.list({ bucket, prefix, ...next });
      for (const object of page.contents) {
        /* File-backed stores materialize the folders between keys and list
           them as zero-byte entries ending in `/` — phantoms this store
           never wrote, which a caller iterating keys must never meet. */
        if (object.key.endsWith("/")) continue;
        entries.push({ key: toStoreKey(object.key), ...modifiedAt(object.lastModified) });
      }
      next = nextPage(page, prefix);
    } while (next !== undefined);

    return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };

  return {
    async get(key: string): Promise<StoredObject | null> {
      const objectKey = toObjectKey(key);
      const response = await fetchObject(objectKey);
      if (response === null) return null;
      return { body: await response.text(), etag: etagOf(response, objectKey) };
    },

    async getBytes(key: string, opts?: { range: ByteRange }): Promise<Uint8Array | null> {
      const response = await fetchObject(toObjectKey(key), opts?.range);
      if (response === null) return null;
      /* No ETag is read here on purpose: the only bodies this answers are the
         observation flushes, which are plain puts nothing ever conditions on. */
      return new Uint8Array(await response.arrayBuffer());
    },

    async put(key, body, cas): Promise<{ etag: string }> {
      const objectKey = toObjectKey(key);
      let response: Response;
      try {
        response = await repeatWrite("put", objectKey, () =>
          client.put({
            bucket,
            key: objectKey,
            body,
            /* Every record this registry keeps is JSON; the one thing written as
               bytes is an encoding that is not text at all, and claiming JSON for it
               would be a lie the bucket then serves to whatever reads it. */
            contentType: typeof body === "string" ? "application/json" : "application/octet-stream",
            ifMatch: cas?.ifMatch,
            ifNoneMatch: cas?.ifNoneMatch,
          }),
        );
      } catch (error) {
        /* Some S3-compatible stores answer create-conflicts with 409 instead of 412. */
        const status = statusOf(error);
        if (status === 412 || status === 409) throw casConflict(objectKey, error);
        throw error;
      }

      /* uns3 treats 412 as an expected status, so it arrives as a response. */
      if (response.status === 412) throw casConflict(objectKey);
      return { etag: etagOf(response, objectKey) };
    },

    async del(key: string): Promise<void> {
      const objectKey = toObjectKey(key);
      try {
        await repeatWrite("delete", objectKey, () => client.del({ bucket, key: objectKey }));
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
      }
    },

    async list(keyPrefix: string): Promise<string[]> {
      return (await listEntries(keyPrefix)).map((entry) => entry.key);
    },

    listEntries,
  };
}

/**
 * The listing's own timestamp as a date, or nothing at all when the store sent
 * one that does not read as a time. A missing age is not an old object: a caller
 * that deletes past an age reads the absence as too young to touch.
 */
function modifiedAt(lastModified: string | undefined): { lastModified?: Date } {
  if (lastModified === undefined) return {};
  const at = Date.parse(lastModified);
  return Number.isFinite(at) ? { lastModified: new Date(at) } : {};
}

/**
 * How the next listing page is asked for, or undefined on the last one. A store
 * that ignores `list-type=2` pages V1-style: it says the page is truncated and
 * hands back a marker rather than a continuation token. A truncated page that
 * offers neither is one the store can never be walked past, which is worse than
 * a short listing, since a reaper acting on one would treat the unseen keys as
 * gone.
 */
function nextPage(
  page: { isTruncated: boolean; nextContinuationToken?: string; nextMarker?: string },
  prefix: string,
): { continuationToken: string } | { query: { marker: string } } | undefined {
  if (!page.isTruncated) return undefined;
  if (page.nextContinuationToken !== undefined) {
    return { continuationToken: page.nextContinuationToken };
  }
  if (page.nextMarker !== undefined) return { query: { marker: page.nextMarker } };

  throw new ScafoError("store-nonconforming", "The store cut a listing short", {
    detail: `listing "${prefix}" was truncated with neither a continuation token nor a marker`,
  });
}

function normalizePrefix(prefix?: string): string {
  const trimmed = prefix?.replaceAll(/^\/+|\/+$/g, "");
  return trimmed === undefined || trimmed === "" ? "" : `${trimmed}/`;
}

function statusOf(error: unknown): number | undefined {
  return error instanceof S3Error ? error.status : undefined;
}

function etagOf(response: Response, objectKey: string): string {
  /* Kept verbatim, quotes included, so it round-trips into a later `ifMatch`. */
  const etag = response.headers.get("etag");
  if (etag === null) {
    throw new ScafoError("store-nonconforming", "The store returned no ETag", {
      detail: `"${objectKey}" was answered without an ETag header, conditional writes are impossible`,
    });
  }
  /* Strip weak marker: `If-Match` requires a strong ETag. */
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function casConflict(objectKey: string, cause?: unknown): ScafoError {
  return new ScafoError("cas-conflict", `Conditional write failed for "${objectKey}"`, {
    status: 412,
    detail: "the object changed since it was read",
    cause,
  });
}

/**
 * Runs one write, repeating the failures the S3 client will not repeat itself.
 *
 * That client retries GET and HEAD and nothing else, which is the only safe
 * default it can hold: it cannot know whether repeating a write is harmless.
 * Here it is known. Every record this registry writes is written under a
 * precondition, so a repeat of a write that had silently landed is refused by
 * that precondition rather than applied twice, and a caller handed a refusal
 * already reads the record back before it writes again. The single write that
 * carries no precondition is the observation flush, whose bytes are
 * last-writer-wins and say the same thing however often they land.
 *
 * A precondition failure is never repeated: that is the store answering, and the
 * answer is final. Only a store that did not answer is asked again.
 */
async function repeatWrite<T>(
  operation: string,
  objectKey: string,
  write: () => Promise<T>,
): Promise<T> {
  let tries = 0;
  try {
    return await withRetry(
      async () => {
        tries++;
        return await write();
      },
      { attempts: WRITE_ATTEMPTS, baseMs: WRITE_BASE_MS, isRetryable: isUnanswered },
    );
  } catch (error) {
    if (!isUnanswered(error)) throw error;
    throw storeUnavailable(operation, objectKey, tries, error);
  }
}

/**
 * Whether the store failed to answer, rather than answered a refusal. The
 * statuses are the transient ones — a rate limit, or a server-side failure other
 * than the two that say the request is one this store will never serve.
 */
function isUnanswered(error: unknown): boolean {
  if (error instanceof S3Error) {
    if (error.status === 429) return true;
    return error.status >= 500 && error.status !== 501 && error.status !== 505;
  }
  /* What `fetch` throws when nothing came back at all: a TypeError carrying the
     transport failure underneath it, and never a status. */
  return error instanceof TypeError && error.cause !== undefined;
}

function storeUnavailable(
  operation: string,
  objectKey: string,
  tries: number,
  cause: unknown,
): ScafoError {
  const answer =
    cause instanceof S3Error
      ? `HTTP ${String(cause.status)}${s3Specifics(cause)}`
      : `no answer (${cause instanceof Error ? cause.message : String(cause)})`;

  return new ScafoError("store-unavailable", "Store did not answer", {
    detail: `${operation} of "${objectKey}" failed with ${answer} after ${String(tries)} attempts`,
    cause,
  });
}

/** What the store called the failure, for an operator reading its own logs. */
function s3Specifics(error: S3Error): string {
  const named: string[] = [];
  if (error.code !== undefined) named.push(error.code);
  if (error.requestId !== undefined) named.push(`request ${error.requestId}`);
  return named.length === 0 ? "" : ` (${named.join(", ")})`;
}
