import { S3Error, type S3Client } from "uns3";
import { ScafoError } from "../../core/error.ts";
import type { CasStore, StoredObject } from "../../core/types/store.ts";

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
  const fetchObject = async (objectKey: string): Promise<Response | null> => {
    try {
      return await client.get({ bucket, key: objectKey });
    } catch (error) {
      if (statusOf(error) === 404) return null;
      throw error;
    }
  };

  return {
    async get(key: string): Promise<StoredObject | null> {
      const objectKey = toObjectKey(key);
      const response = await fetchObject(objectKey);
      if (response === null) return null;
      return { body: await response.text(), etag: etagOf(response, objectKey) };
    },

    async getBytes(key: string): Promise<Uint8Array | null> {
      const response = await fetchObject(toObjectKey(key));
      if (response === null) return null;
      /* No ETag is read here on purpose: the only bodies this answers are the
         observation flushes, which are plain puts nothing ever conditions on. */
      return new Uint8Array(await response.arrayBuffer());
    },

    async put(key, body, cas): Promise<{ etag: string }> {
      const objectKey = toObjectKey(key);
      let response: Response;
      try {
        response = await client.put({
          bucket,
          key: objectKey,
          body,
          /* Every record this registry keeps is JSON; the one thing written as
             bytes is an encoding that is not text at all, and claiming JSON for it
             would be a lie the bucket then serves to whatever reads it. */
          contentType: typeof body === "string" ? "application/json" : "application/octet-stream",
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
          /* File-backed stores materialize the folders between keys and list
             them as zero-byte entries ending in `/` — phantoms this store
             never wrote, which a caller iterating keys must never meet. */
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
