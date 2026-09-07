/* How the S3 store walks a listing across pages, and what it asks of a ranged read. */

import { S3Error, type S3Client } from "uns3";
import { describe, expect, it } from "vitest";
import { createUns3Store } from "../src/drivers/store/uns3.ts";
import { rejectsWith } from "./_helpers.ts";

type GetParams = Parameters<S3Client["get"]>[0];
type ListParams = Parameters<S3Client["list"]>[0];
type ListPage = Awaited<ReturnType<S3Client["list"]>>;

function pageOf(keys: string[], more: Partial<ListPage> = {}): ListPage {
  return {
    contents: keys.map((key) => ({ key, size: 0, etag: undefined, lastModified: "" })),
    commonPrefixes: [],
    isTruncated: false,
    ...more,
  } as ListPage;
}

/** A client that answers each list call with the next scripted page, remembering what it was asked. */
function scripted(pages: ListPage[]): { client: S3Client; asked: ListParams[] } {
  const asked: ListParams[] = [];
  const client = {
    list: async (params: ListParams): Promise<ListPage> => {
      asked.push(params);
      const page = pages.shift();
      if (page === undefined) throw new Error("asked for a page past the last one");
      return page;
    },
  } as unknown as S3Client;
  return { client, asked };
}

describe("listing across pages", () => {
  it("follows a continuation token", async () => {
    const { client, asked } = scripted([
      pageOf(["p/a.json"], { isTruncated: true, nextContinuationToken: "t1" }),
      pageOf(["p/b.json"]),
    ]);

    const keys = await createUns3Store(client, { bucket: "b", prefix: "p" }).list("");

    expect(keys).toEqual(["a.json", "b.json"]);
    expect(asked[1]).toMatchObject({ continuationToken: "t1" });
  });

  it("follows a V1 marker from a store that ignores list-type=2, as a marker and not a token", async () => {
    const { client, asked } = scripted([
      pageOf(["p/a.json"], { isTruncated: true, nextMarker: "p/a.json" }),
      pageOf(["p/b.json"]),
    ]);

    const keys = await createUns3Store(client, { bucket: "b", prefix: "p" }).list("");

    expect(keys).toEqual(["a.json", "b.json"]);
    expect(asked[1]).toMatchObject({ query: { marker: "p/a.json" } });
    expect(asked[1]).not.toHaveProperty("continuationToken");
  });

  it("refuses a truncated page it has no way to walk past, rather than answering short", async () => {
    const { client } = scripted([pageOf(["p/a.json"], { isTruncated: true })]);

    await rejectsWith(
      () => createUns3Store(client, { bucket: "b", prefix: "p" }).list(""),
      "store-nonconforming",
    );
  });
});

describe("a ranged read", () => {
  it("asks for the range, and for the 206 that is the only right answer to it", async () => {
    const asked: GetParams[] = [];
    const client = {
      get: async (params: GetParams): Promise<Response> => {
        asked.push(params);
        return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
      },
    } as unknown as S3Client;

    const bytes = await createUns3Store(client, { bucket: "b", prefix: "p" }).getBytes(
      "o.parquet",
      {
        range: { start: 2, end: 4 },
      },
    );

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(asked[0]).toMatchObject({
      key: "p/o.parquet",
      range: { start: 2, end: 4 },
      expectedStatus: 206,
    });
  });

  it("leaves an unranged read exactly as it was", async () => {
    const asked: GetParams[] = [];
    const client = {
      get: async (params: GetParams): Promise<Response> => {
        asked.push(params);
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      },
    } as unknown as S3Client;

    await createUns3Store(client, { bucket: "b" }).getBytes("o.parquet");

    expect(asked[0]?.range).toBeUndefined();
    expect(asked[0]?.expectedStatus).toBeUndefined();
  });

  it("calls a store that answered the whole object nonconforming", async () => {
    /* What uns3 raises when the status was not the one demanded: the store
       ignored `Range` and served the whole object with a 200. */
    const ignored = new S3Error({ message: "unexpected status", status: 200 });
    const client = {
      get: async (): Promise<Response> => {
        throw ignored;
      },
    } as unknown as S3Client;

    const error = await rejectsWith(
      () =>
        createUns3Store(client, { bucket: "b" }).getBytes("o.parquet", {
          range: { start: 0, end: 3 },
        }),
      "store-nonconforming",
    );
    expect(error.message).toBe("Store does not honour ranged reads");
    expect(error.cause).toBe(ignored);
  });

  it("still answers null for a key that is not there", async () => {
    const client = {
      get: async (): Promise<Response> => {
        throw new S3Error({ message: "no such key", status: 404 });
      },
    } as unknown as S3Client;

    await expect(
      createUns3Store(client, { bucket: "b" }).getBytes("gone.parquet", {
        range: { start: 0, end: 3 },
      }),
    ).resolves.toBeNull();
  });
});
