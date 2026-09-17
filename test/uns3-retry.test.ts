/* What the S3 store does with a write a store failed to answer, and with one it refused. */

import { S3Error, type S3Client } from "uns3";
import { describe, expect, it } from "vitest";
import { createUns3Store } from "../src/drivers/store/uns3.ts";
import { rejectsWith } from "./_helpers.ts";

/** What a scripted call answers with: a response, or something thrown instead. */
type Answer = Response | Error;

/** A client whose every write answers what the script says, in call order. */
function scripted(answer: (call: number) => Answer): { client: S3Client; calls: string[] } {
  const calls: string[] = [];
  const respond = (operation: string): Response => {
    const given = answer(calls.length);
    calls.push(operation);
    if (given instanceof Error) throw given;
    return given;
  };

  const client = {
    put: async (): Promise<Response> => respond("put"),
    del: async (): Promise<Response> => respond("del"),
  } as unknown as S3Client;

  return { client, calls };
}

/** A write the store accepted, carrying the ETag the next write conditions on. */
function accepted(etag: string): Response {
  return new Response(null, { status: 200, headers: { etag } });
}

/** A transient server-side failure, as the S3 client raises one. */
function transient(status: number): S3Error {
  return new S3Error({
    message: "we encountered an internal error",
    status,
    code: "InternalError",
    requestId: "AE7D5B1C9F204E38",
  });
}

/** What `fetch` throws when the request never got an answer at all. */
function unreachable(): TypeError {
  return new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
}

describe("a write the store failed to answer", () => {
  it("is repeated, and the second answer is the one the caller gets", async () => {
    const { client, calls } = scripted((call) =>
      call === 0 ? transient(500) : accepted('"second"'),
    );

    const written = await createUns3Store(client, { bucket: "b" }).put("keys/one.json", "{}", {
      ifNoneMatch: "*",
    });

    expect(written).toEqual({ etag: '"second"' });
    expect(calls).toEqual(["put", "put"]);
  });

  it("is repeated when nothing answered it at all", async () => {
    const { client, calls } = scripted((call) => (call === 0 ? unreachable() : accepted('"v2"')));

    await expect(
      createUns3Store(client, { bucket: "b" }).put("keys/one.json", "{}", { ifMatch: '"v1"' }),
    ).resolves.toEqual({ etag: '"v2"' });
    expect(calls).toEqual(["put", "put"]);
  });

  it("is repeated for a delete too, which is a write like any other", async () => {
    const { client, calls } = scripted((call) => (call === 0 ? transient(503) : accepted('"v2"')));

    await expect(
      createUns3Store(client, { bucket: "b" }).del("keys/one.json"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["del", "del"]);
  });

  it("gives up as a store that is unavailable, naming what it was told and how often", async () => {
    const { client, calls } = scripted(() => transient(500));

    const error = await rejectsWith(
      () => createUns3Store(client, { bucket: "b", prefix: "p" }).put("keys/one.json", "{}"),
      "store-unavailable",
    );

    expect(error.status).toBe(503);
    expect(error.message).toBe("Store did not answer");
    expect(error.detail).toContain('put of "p/keys/one.json"');
    expect(error.detail).toContain("HTTP 500");
    expect(error.detail).toContain("InternalError");
    expect(error.detail).toContain("AE7D5B1C9F204E38");
    expect(error.detail).toContain(`${String(calls.length)} attempts`);
    expect(calls).toHaveLength(5);
  });

  it("says so for a request that never reached the store either", async () => {
    const { client } = scripted(() => unreachable());

    const error = await rejectsWith(
      () => createUns3Store(client, { bucket: "b" }).put("keys/one.json", "{}"),
      "store-unavailable",
    );

    expect(error.detail).toContain("fetch failed");
    expect(error.detail).toContain("5 attempts");
  });
});

describe("a write the store answered", () => {
  it("takes a failed precondition for the final answer it is, and asks once", async () => {
    for (const status of [412, 409]) {
      const { client, calls } = scripted(() => new S3Error({ message: "precondition", status }));

      const error = await rejectsWith(
        () =>
          createUns3Store(client, { bucket: "b" }).put("keys/one.json", "{}", {
            ifNoneMatch: "*",
          }),
        "cas-conflict",
      );

      expect(error.status, String(status)).toBe(412);
      expect(calls, String(status)).toEqual(["put"]);
    }
  });

  it("hands a refusal back untouched rather than asking again", async () => {
    /* A bad request, and the two server-side statuses that say this store will
       never serve the request however often it is sent. */
    for (const status of [400, 403, 501, 505]) {
      const refused = new S3Error({ message: "refused", status });
      const { client, calls } = scripted(() => refused);

      await expect(
        createUns3Store(client, { bucket: "b" }).put("keys/one.json", "{}"),
        String(status),
      ).rejects.toBe(refused);
      expect(calls, String(status)).toEqual(["put"]);
    }
  });

  it("still takes a missing key as a delete that is already done", async () => {
    const { client, calls } = scripted(() => new S3Error({ message: "no such key", status: 404 }));

    await expect(
      createUns3Store(client, { bucket: "b" }).del("gone.json"),
    ).resolves.toBeUndefined();
    expect(calls).toEqual(["del"]);
  });
});
