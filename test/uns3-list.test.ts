/* How the S3 store walks a listing across pages, and what it asks of a ranged read. */

import { S3Error, type S3Client } from "uns3";
import { describe, expect, it } from "vitest";
import { createUns3Store } from "../src/drivers/store/uns3.ts";
import { rejectionOf, rejectsWith } from "./_helpers.ts";

type GetParams = Parameters<S3Client["get"]>[0];
type ListParams = Parameters<S3Client["list"]>[0];
type ListPage = Awaited<ReturnType<S3Client["list"]>>;

function pageOf(keys: string[], more: Partial<ListPage> = {}): ListPage {
  return {
    contents: keys.map((key) => ({ key, size: 0, etag: `e-${key}`, lastModified: "" })),
    commonPrefixes: [],
    isTruncated: false,
    ...more,
  } as ListPage;
}

/** A page whose objects carry the times the store reported for them. */
function agedPage(times: Record<string, string>): ListPage {
  return {
    contents: Object.entries(times).map(([key, lastModified]) => ({
      key,
      size: 0,
      etag: `e-${key}`,
      lastModified,
    })),
    commonPrefixes: [],
    isTruncated: false,
  } as ListPage;
}

/** A page whose objects carry exactly the ETags the store sent, warts included. */
function etaggedPage(etags: Record<string, string | undefined>): ListPage {
  return {
    contents: Object.entries(etags).map(([key, etag]) => ({
      key,
      size: 0,
      etag,
      lastModified: "2026-01-01T00:00:00.000Z",
    })),
    commonPrefixes: [],
    isTruncated: false,
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

    const error = await rejectionOf(() =>
      createUns3Store(client, { bucket: "b", prefix: "p" }).list(""),
    );

    expect(error.code).toBe("store-nonconforming");
  });
});

describe("listing what the store said about each object", () => {
  it("carries the modification time of every key, across pages and without the prefix", async () => {
    const { client } = scripted([
      {
        ...agedPage({ "p/a.json": "2026-01-01T00:00:00.000Z" }),
        isTruncated: true,
        nextContinuationToken: "t1",
      } as ListPage,
      agedPage({ "p/b.json": "2026-01-02T03:04:05.000Z" }),
    ]);

    const entries = await createUns3Store(client, { bucket: "b", prefix: "p" }).listEntries("");

    expect(entries).toEqual([
      {
        key: "a.json",
        etag: `"e-p/a.json"`,
        lastModified: new Date("2026-01-01T00:00:00.000Z"),
        size: 0,
      },
      {
        key: "b.json",
        etag: `"e-p/b.json"`,
        lastModified: new Date("2026-01-02T03:04:05.000Z"),
        size: 0,
      },
    ]);
  });

  it("leaves the time out rather than inventing one the store did not send", async () => {
    const { client } = scripted([agedPage({ "p/a.json": "", "p/b.json": "whenever" })]);

    const entries = await createUns3Store(client, { bucket: "b", prefix: "p" }).listEntries("");

    expect(entries).toEqual([
      { key: "a.json", etag: `"e-p/a.json"`, size: 0 },
      { key: "b.json", etag: `"e-p/b.json"`, size: 0 },
    ]);
  });

  it("quotes a listed ETag the way a header carries one, weak marker taken off", async () => {
    /* The XML listing hands over the value with its quotes already stripped, and
       a weak marker `If-Match` would refuse. Both are normalized to the one form
       `get` and `put` answer with, so a cached listing entry is a precondition. */
    const { client } = scripted([
      etaggedPage({
        "p/bare.json": "abc123",
        "p/quoted.json": `"abc124"`,
        "p/weak.json": `W/abc125`,
      }),
    ]);

    const entries = await createUns3Store(client, { bucket: "b", prefix: "p" }).listEntries("");

    expect(entries.map((entry) => entry.etag)).toEqual([`"abc123"`, `"abc124"`, `"abc125"`]);
  });

  it("refuses a listing that named no ETag, because nothing could tell a change from none", async () => {
    const { client } = scripted([etaggedPage({ "p/a.json": undefined })]);

    const error = await rejectsWith(
      () => createUns3Store(client, { bucket: "b", prefix: "p" }).listEntries(""),
      "store-nonconforming",
    );
    expect(error.detail).toContain("p/a.json");
  });

  it("skips the folder phantoms a file-backed store lists, exactly as the keys do", async () => {
    const { client } = scripted([
      agedPage({
        "p/nested/": "2026-01-01T00:00:00.000Z",
        "p/nested/a.json": "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const entries = await createUns3Store(client, { bucket: "b", prefix: "p" }).listEntries("");

    expect(entries.map((entry) => entry.key)).toEqual(["nested/a.json"]);
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
