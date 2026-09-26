import { describe, expect, it } from "vitest";
import { DEPLOY_METADATA_HEADER } from "../src/daemon/_intake.ts";
import { fromBase64Url } from "../src/core/utils/base64.ts";
import { uploadArtifact } from "../src/cli/commands/deploy.ts";

describe("the CLI deploy upload", () => {
  it("hands fetch a raw stream rather than a form, blob, or artifact buffer", async () => {
    const sent = await upload("shop");

    expect(sent.url).toBe("https://node.test/v1/applications/shop/deploys");
    expect(sent.init?.body).toBeInstanceOf(ReadableStream);
    expect(sent.init?.body).not.toBeInstanceOf(FormData);
    expect(sent.init?.body).not.toBeInstanceOf(Blob);
    const headers = new Headers(sent.init?.headers);
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get(DEPLOY_METADATA_HEADER)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("addresses the application the flags resolved to, and says nothing else about it", async () => {
    /* `--name shop --env preview` is an application name and not a second field:
       the node is told "shop-preview" and never told there was an env. */
    const sent = await upload("shop-preview");

    expect(sent.url).toBe("https://node.test/v1/applications/shop-preview/deploys");
    const metadata = sentMetadata(sent.init);
    expect(metadata).toEqual({});
    expect(metadata).not.toHaveProperty("environment");
  });
});

/** The metadata header of a request, read back. */
function sentMetadata(init: RequestInit | undefined): Record<string, unknown> {
  const encoded = new Headers(init?.headers).get(DEPLOY_METADATA_HEADER) as string;
  return JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Record<string, unknown>;
}

/** One upload, with the request it made. */
async function upload(
  application: string,
): Promise<{ url: string; init: RequestInit | undefined }> {
  let url = "";
  let init: RequestInit | undefined;
  const fetchFn = async (input: string | URL | Request, given?: RequestInit): Promise<Response> => {
    url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    init = given;
    return new Response(
      JSON.stringify({ id: `${application}.a1b2c3d4a1b2c3d4`, application, state: "accepted" }),
      { status: 202 },
    );
  };

  await uploadArtifact({
    nodeUrl: "https://node.test",
    token: "token",
    application,
    metadata: {},
    artifact: {
      byteLength: 3,
      open: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
      dispose: () => Promise.resolve(),
    },
    fetchFn: fetchFn as typeof fetch,
  });
  return { url, init };
}
