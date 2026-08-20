import { S3Error, type S3Client } from "uns3";
import { ScafoError } from "../../core/error.ts";
import type { CasStore, StoredObject } from "../../core/types/store.ts";

export interface Uns3StoreOptions {
  bucket: string;
  /** Joined to every key with "/", and stripped back off `list` results. */
  prefix?: string;
}

/**
 * Backs the registry with an S3-compatible bucket. The bucket MUST support
 * conditional writes (`If-Match` / `If-None-Match`) and MUST return an `ETag`
 * header on PUT — stores that do not are rejected with `store-nonconforming`.
 */
export function createUns3Store(client: S3Client, opts: Uns3StoreOptions): CasStore {
  const bucket = opts.bucket;
  const prefix = normalizePrefix(opts.prefix);
  const toObjectKey = (key: string): string => prefix + key;
  const toStoreKey = (objectKey: string): string =>
    objectKey.startsWith(prefix) ? objectKey.slice(prefix.length) : objectKey;

  return {
    async get(key: string): Promise<StoredObject | null> {
      const objectKey = toObjectKey(key);
      let response: Response;
      try {
        response = await client.get({ bucket, key: objectKey });
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
      return { body: await response.text(), etag: etagOf(response, objectKey) };
    },

    async put(key, body, cas): Promise<{ etag: string }> {
      const objectKey = toObjectKey(key);
      let response: Response;
      try {
        response = await client.put({
          bucket,
          key: objectKey,
          body,
          contentType: "application/json",
          ifMatch: cas?.ifMatch,
          ifNoneMatch: cas?.ifNoneMatch,
        });
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
      try {
        await client.del({ bucket, key: toObjectKey(key) });
      } catch (error) {
        if (statusOf(error) !== 404) throw error;
      }
    },

    async list(keyPrefix: string): Promise<string[]> {
      const keys: string[] = [];
      let continuationToken: string | undefined;

      do {
        const page = await client.list({
          bucket,
          prefix: toObjectKey(keyPrefix),
          continuationToken,
        });
        for (const object of page.contents) {
          /* File-backed stores (Bunny) materialize the folders between keys
             and list them as zero-byte entries ending in `/`. They are not
             objects this store ever wrote, and a caller iterating keys must
             never meet one. */
          if (object.key.endsWith("/")) continue;
          keys.push(toStoreKey(object.key));
        }
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken !== undefined);

      return keys.sort();
    },
  };
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
  /*
   * The one normalization applied: a `W/` weakness marker is stripped. Stores
   * with a transforming edge in front (Bunny) answer a compressed GET with the
   * SAME value the PUT returned, marked weak because the transfer encoding
   * differed — but `If-Match` mandates strong comparison, so a weak tag sent
   * back verbatim is refused by the very store that issued it, and every
   * read-modify-write chain deadlocks against its own reads. On a store whose
   * ETag is the object's content identity, the marker carries no information
   * the value does not; the strong form is what conditional writes accept.
   */
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function casConflict(objectKey: string, cause?: unknown): ScafoError {
  return new ScafoError("cas-conflict", `Conditional write failed for "${objectKey}"`, {
    status: 412,
    detail: "the object changed since it was read",
    cause,
  });
}
