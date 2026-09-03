/*
 * Internal: the `/v1/storage` routes, thin over the registry operations behind
 * them.
 *
 * A key is everything after `/v1/storage/objects/`, separators included, and is
 * spelled back to the caller exactly as it was given. Every route answers a
 * failure as the RFC 9457 problem document the rest of the API uses.
 */

import type { H3, H3Event, Middleware } from "h3";
import { ScafoError } from "../core/error.ts";
import { assertTlsKey } from "../core/registry/paths.ts";
import {
  deleteTlsObject,
  listTlsObjects,
  putTlsObject,
  readTlsObject,
  statTlsObject,
  type TlsStat,
} from "../core/registry/tls.ts";
import type { DaemonContext } from "./app.ts";
import type { StorageService } from "./storage.ts";

/** Where an object's own key begins; the wildcard takes the whole of the rest. */
const OBJECTS = "/v1/storage/objects";

/** Where a lock's name begins; a name may carry separators exactly as a key may. */
const LOCKS = "/v1/storage/locks";

/** What a read of a stored value is answered with: the bytes, and nothing about them. */
const OCTET_STREAM = "application/octet-stream";

/** How `recursive` may be spelled; anything else lists the immediate children. */
const TRUTHY = ["true", "1"];

/** Adds the storage routes to `app`, each behind the ingress token. */
export function registerStorageRoutes(
  app: H3,
  daemon: DaemonContext,
  storage: StorageService,
): void {
  const admitted: Middleware = (event, next) => {
    storage.admit(event);
    return next();
  };
  const guarded = { middleware: [admitted] };

  app.put(
    `${OBJECTS}/**:key`,
    async (event): Promise<Response> => {
      /* Read as BYTES, never as text: a value may be DER, and decoding one as
         UTF-8 replaces every byte that is not a character. */
      const value = new Uint8Array(await event.req.arrayBuffer());
      await putTlsObject(daemon.registry, objectKey(event), value);
      return empty();
    },
    guarded,
  );

  app.get(
    `${OBJECTS}/**:key`,
    async (event): Promise<Response> => {
      const key = objectKey(event);
      const found = await readTlsObject(daemon.registry, key);
      if (found === null) throw missing(key);

      return new Response(found.value, { headers: { "content-type": OCTET_STREAM } });
    },
    guarded,
  );

  app.delete(
    `${OBJECTS}/**:key`,
    async (event): Promise<Response> => {
      const key = objectKey(event);
      /* The key AND everything under it, because a caller deleting a name is
         deleting the directory that name may also be. */
      if ((await deleteTlsObject(daemon.registry, key)) === 0) throw missing(key);
      return empty();
    },
    guarded,
  );

  app.get(
    "/v1/storage/list",
    async (event): Promise<string[]> => {
      const prefix = event.url.searchParams.get("prefix") ?? "";
      const recursive = TRUTHY.includes(event.url.searchParams.get("recursive") ?? "");

      const keys = await listTlsObjects(daemon.registry, prefix, { recursive });
      /*
       * A prefix nothing is stored at or under is a MISS, not an empty list. The
       * caller's storage contract requires the two to be distinguishable, and an
       * empty array would say "this name exists and holds nothing" — which is a
       * different fact, and one this key space cannot even represent.
       *
       * A non-recursive listing counts a deep key as a match even though it
       * answers the child directory that key sits under rather than the key.
       */
      if (keys.length === 0) throw missing(prefix);
      return keys;
    },
    guarded,
  );

  app.get(
    "/v1/storage/stat",
    async (event): Promise<TlsStat> => {
      const key = event.url.searchParams.get("key") ?? "";
      const found = await statTlsObject(daemon.registry, key);
      if (found === null) throw missing(key);
      return found;
    },
    guarded,
  );

  /* Try-acquire, and it NEVER waits: a caller that wants a held lock asks again
     rather than holding a connection open for it. `409` means somebody has it. */
  app.post(
    `${LOCKS}/**:name`,
    async (event): Promise<Response> => {
      await storage.lock(lockName(event));
      return empty();
    },
    guarded,
  );

  /* Idempotent: a lock this node never took, or lost, is answered as released
     all the same, because the caller's next act must not depend on which. */
  app.delete(
    `${LOCKS}/**:name`,
    async (event): Promise<Response> => {
      await storage.unlock(lockName(event));
      return empty();
    },
    guarded,
  );
}

function objectKey(event: H3Event): string {
  const key = event.context.params?.key ?? "";
  assertTlsKey(key);
  return key;
}

function lockName(event: H3Event): string {
  const name = event.context.params?.name ?? "";
  assertTlsKey(name);
  return name;
}

function empty(): Response {
  return new Response(null, { status: 204 });
}

/** The one refusal a key that names nothing gets, whichever route was asked. */
function missing(key: string): ScafoError {
  return new ScafoError("not-found", "No such stored object", {
    detail:
      key === "" ? "nothing is stored at all" : `nothing is stored at "${key}", nor beneath it`,
  });
}
