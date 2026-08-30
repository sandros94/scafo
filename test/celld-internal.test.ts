/*
 * The private operator surface of one celld process. These calls go only to
 * its internal listener; the public listener and ingress never carry them.
 */

import { describe, expect, it, vi } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import {
  createCelldInternalClient,
  type CelldInternalClient,
} from "../src/drivers/runtime/_celld-internal.ts";
import { rejectsWith } from "./_helpers.ts";

const ENDPOINT = "http://127.0.0.1:42101";

describe("the celld internal operator client", () => {
  it("posts the exact reload path and decodes an adopted generation", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        outcome: "adopted",
        generation: 2,
        version: "20260830-aabb",
        prefix: "deploy/app/20260830-aabb",
        future: "ignored",
      }),
    );

    const result = await client(fetchFn).reload();

    expect(result).toEqual({
      outcome: "adopted",
      generation: 2,
      version: "20260830-aabb",
      prefix: "deploy/app/20260830-aabb",
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${ENDPOINT}/reload`);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("accepts the prefix-less unchanged shape v0.4 declares", async () => {
    const result = await client(
      answering(200, { ok: true, outcome: "unchanged", generation: 4, version: "v4" }),
    ).reload();

    expect(result).toEqual({ outcome: "unchanged", generation: 4, version: "v4" });
  });

  it("tolerates a future prefix on an unchanged outcome", async () => {
    const result = await client(
      answering(200, {
        ok: true,
        outcome: "unchanged",
        generation: 4,
        version: "v4",
        prefix: "deploy/app/v4",
      }),
    ).reload();

    expect(result).toEqual({
      outcome: "unchanged",
      generation: 4,
      version: "v4",
      prefix: "deploy/app/v4",
    });
  });

  it("returns a failed adoption as an outcome rather than an HTTP exception", async () => {
    const result = await client(
      answering(422, {
        ok: false,
        outcome: "failed",
        version: "broken",
        prefix: "deploy/app/broken",
        error: "module did not compile",
      }),
    ).reload();

    expect(result).toEqual({
      outcome: "failed",
      version: "broken",
      prefix: "deploy/app/broken",
      error: "module did not compile",
    });
  });

  it("returns an unavailable reload channel as an outcome", async () => {
    const result = await client(
      answering(503, {
        ok: false,
        outcome: "unavailable",
        error: "this node has no deployment pointer to reload from",
      }),
    ).reload();

    expect(result).toEqual({
      outcome: "unavailable",
      error: "this node has no deployment pointer to reload from",
    });
  });

  it("gets the exact state path and projects only stable deployment fields", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        deployment: {
          version: "20260830-aabb",
          prefix: "deploy/app/20260830-aabb",
          generation: 7,
          draining: [{ generation: 6, version: "old" }],
          swapping: 1,
          cells: { one: 7 },
          future: true,
        },
        ownership: { alpha: true },
      }),
    );

    const result = await client(fetchFn).state();

    expect(result).toEqual({
      deployment: {
        version: "20260830-aabb",
        prefix: "deploy/app/20260830-aabb",
        generation: 7,
      },
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${ENDPOINT}/state`);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("reports the actor-stopped state without demanding deployment fields", async () => {
    await expect(
      client(answering(200, { error: "actor_stopped", future: "ignored" })).state(),
    ).resolves.toEqual({ error: "actor_stopped" });
  });

  it.each([
    ["non-JSON", new Response("not JSON", { status: 200 })],
    ["missing fields", jsonResponse(200, { ok: true, outcome: "adopted" })],
    [
      "status/outcome mismatch",
      jsonResponse(503, { ok: true, outcome: "unchanged", generation: 1, version: "v1" }),
    ],
  ])("wraps a malformed reload response: %s", async (_label, response) => {
    const error = await rejectsWith(
      () => client(vi.fn<typeof fetch>().mockResolvedValue(response)).reload(),
      "capability-missing",
    );

    expect(error.status).toBe(502);
    expect(error.detail).toContain("POST /reload");
  });

  it.each([
    ["missing deployment", {}],
    ["unknown error", { error: "something_else" }],
    ["unsafe generation", { deployment: { version: "v", prefix: "p", generation: 2 ** 53 } }],
  ])("wraps a malformed state response: %s", async (_label, body) => {
    const error = await rejectsWith(
      () => client(answering(200, body)).state(),
      "capability-missing",
    );

    expect(error.status).toBe(502);
    expect(error.detail).toContain("GET /state");
  });

  it("wraps a network failure and keeps the platform error as its cause", async () => {
    const cause = new TypeError("connection refused");
    const error = await rejectsWith(
      () => client(vi.fn<typeof fetch>().mockRejectedValue(cause)).state(),
      "capability-missing",
    );

    expect(error.cause).toBe(cause);
  });

  it("bounds a call even when the injected fetch ignores its signal", async () => {
    const never = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const error = await rejectsWith(
      () => createCelldInternalClient(ENDPOINT, { fetchFn: never, timeoutMs: 5 }).reload(),
      "capability-missing",
    );

    expect(error.detail).toContain("timed out after 5ms");
    expect(never.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves a typed caller abort reason", async () => {
    const controller = new AbortController();
    const reason = new ScafoError("draining", "Node is stopping");
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    controller.abort(reason);

    await expect(client(fetchFn).state({ signal: controller.signal })).rejects.toBe(reason);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["ftp://127.0.0.1:42101", "http://user@127.0.0.1:42101", `${ENDPOINT}/state`])(
    "refuses an internal endpoint that is not an HTTP origin: %s",
    (endpoint) => {
      expect(() => createCelldInternalClient(endpoint)).toThrowError(
        expect.objectContaining({ code: "invalid-input" }),
      );
    },
  );

  it("refuses a non-positive timeout before making a client", () => {
    expect(() => createCelldInternalClient(ENDPOINT, { timeoutMs: 0 })).toThrowError(
      expect.objectContaining({ code: "invalid-input" }),
    );
  });
});

function client(fetchFn: typeof fetch): CelldInternalClient {
  return createCelldInternalClient(ENDPOINT, { fetchFn, timeoutMs: 100 });
}

function answering(status: number, body: unknown): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(status, body));
}

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}
