import { describe, expect, it } from "vitest";
import { DEPLOY_METADATA_HEADER } from "../src/daemon/_intake.ts";
import { uploadArtifact } from "../src/cli/commands/deploy.ts";

describe("the CLI deploy upload", () => {
  it("hands fetch a raw stream rather than a form, blob, or artifact buffer", async () => {
    let calledUrl = "";
    let called: RequestInit | undefined;
    const fetchFn = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calledUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      called = init;
      return new Response(JSON.stringify({ id: "1", project: "shop", state: "accepted" }), {
        status: 202,
      });
    };

    await uploadArtifact({
      nodeUrl: "https://node.test",
      token: "token",
      project: "shop",
      metadata: { runtimeConfigurable: false, environment: "production" },
      artifact: {
        open: () => new Blob([new Uint8Array([1, 2, 3])]).stream(),
        dispose: () => Promise.resolve(),
      },
      fetchFn: fetchFn as typeof fetch,
    });

    expect(calledUrl).toBe("https://node.test/v1/projects/shop/deploys");
    expect(called?.body).toBeInstanceOf(ReadableStream);
    expect(called?.body).not.toBeInstanceOf(FormData);
    expect(called?.body).not.toBeInstanceOf(Blob);
    const headers = new Headers(called?.headers);
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get(DEPLOY_METADATA_HEADER)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
