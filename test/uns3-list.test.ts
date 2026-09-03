/* How the S3 store walks a listing across pages, whichever way the store pages. */

import type { S3Client } from "uns3";
import { describe, expect, it } from "vitest";
import { createUns3Store } from "../src/drivers/store/uns3.ts";
import { rejectsWith } from "./_helpers.ts";

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
