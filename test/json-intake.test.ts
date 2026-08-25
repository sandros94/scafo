import type { H3Event } from "h3";
import { describe, expect, it, vi } from "vitest";
import { ScafoError } from "../src/core/error.ts";
import { DEFAULT_JSON_BYTES, readJsonBody } from "../src/daemon/_json.ts";

describe("bounded JSON intake", () => {
  it("accepts a valid document at the exact cap", async () => {
    const raw = `"${"a".repeat(DEFAULT_JSON_BYTES - 2)}"`;

    await expect(readJsonBody(eventOf(bytes(raw)))).resolves.toBe(raw.slice(1, -1));
  });

  it("cancels a chunked document before accepting the byte that crosses the cap", async () => {
    let cancelled = 0;
    const body = chunks(
      [new TextEncoder().encode(`"${"a".repeat(DEFAULT_JSON_BYTES - 2)}`), bytes('x"')],
      () => cancelled++,
    );

    await expect(readJsonBody(eventOf(body))).rejects.toMatchObject({
      code: "resource-limit",
      status: 413,
      detail: expect.stringContaining(String(DEFAULT_JSON_BYTES)),
    });
    expect(cancelled).toBe(1);
  });

  it("does not trust a false-small Content-Length", async () => {
    const body = chunks([bytes(`"${"a".repeat(DEFAULT_JSON_BYTES)}"`)]);

    await expect(readJsonBody(eventOf(body, { "content-length": "1" }))).rejects.toMatchObject({
      code: "resource-limit",
      status: 413,
    });
  });

  it("refuses a valid over-cap Content-Length before pulling the stream", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(): void {
          pulls++;
          throw new Error("sentinel JSON body was read");
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      readJsonBody(eventOf(body, { "content-length": String(DEFAULT_JSON_BYTES + 1) })),
    ).rejects.toMatchObject({ code: "resource-limit", status: 413 });
    expect(pulls).toBe(0);
  });

  it("does not await a never-settling Content-Length refusal cancellation", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        cancel(): Promise<void> {
          cancelled++;
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const event = eventOf(body, { "content-length": String(DEFAULT_JSON_BYTES + 1) });
    const refusal = readJsonBody(event).then(
      () => undefined,
      (error: unknown) => error,
    );

    const error = await Promise.race([
      refusal,
      new Promise<"still-pending">((resolve) => setTimeout(resolve, 25, "still-pending")),
    ]);

    expect(error).not.toBe("still-pending");
    expect(error).toMatchObject({ code: "resource-limit", status: 413 });
    expect(cancelled).toBe(1);
    expect(event.req.body?.locked).toBe(false);
  });

  it("does not await a never-settling crossing-chunk cancellation", async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream): void {
          stream.enqueue(bytes("123"));
        },
        cancel(): Promise<void> {
          cancelled++;
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const event = eventOf(body);
    const refusal = readJsonBody(event, { maxBytes: 2 }).then(
      () => undefined,
      (error: unknown) => error,
    );

    const error = await Promise.race([
      refusal,
      new Promise<"still-pending">((resolve) => setTimeout(resolve, 25, "still-pending")),
    ]);

    expect(error).not.toBe("still-pending");
    expect(error).toMatchObject({ code: "resource-limit", status: 413 });
    expect(cancelled).toBe(1);
    expect(event.req.body?.locked).toBe(false);
  });

  it.each([
    ["malformed UTF-8", new Uint8Array([0xc3, 0x28])],
    ["malformed JSON", bytes("{")],
  ])("reports %s as typed invalid input", async (_what, body) => {
    await expect(readJsonBody(eventOf(body))).rejects.toMatchObject({
      code: "invalid-input",
      status: 400,
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, 2 ** 53, "unlimited"])(
    "refuses an unusable direct limit: %s",
    async (maxBytes) => {
      await expect(
        readJsonBody(eventOf(bytes("{}")), { maxBytes: maxBytes as number }),
      ).rejects.toMatchObject({ code: "invalid-input", status: 400 });
    },
  );

  it("cancels a pending read and preserves the request abort reason", async () => {
    const abortReason = new Error("caller disconnected");
    const transportError = new Error("transport cancellation failed");
    const controller = new AbortController();
    const pull = deferred<void>();
    let cancelledWith: unknown;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(): Promise<void> {
          pull.resolve();
          return new Promise(() => {});
        },
        cancel(reason): void {
          cancelledWith = reason;
          throw transportError;
        },
      },
      { highWaterMark: 0 },
    );
    const event = eventOf(body, {}, controller.signal);
    const removeListener = vi.spyOn(event.req.signal, "removeEventListener");
    const reading = readJsonBody(event).then(
      () => undefined,
      (error: unknown) => error,
    );

    await pull.promise;
    controller.abort(abortReason);
    const error = await Promise.race([
      reading,
      new Promise<"still-pending">((resolve) => setTimeout(resolve, 25, "still-pending")),
    ]);

    expect(error).not.toBe("still-pending");
    expect(error).toMatchObject({ code: "invalid-input", status: 400, cause: abortReason });
    expect((error as Error & { cause?: unknown }).cause).not.toBe(transportError);
    expect(cancelledWith).toBe(abortReason);
    expect(event.req.body?.locked).toBe(false);
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it("uses a typed abort fallback when the request reason is not an Error", async () => {
    const controller = new AbortController();
    const pull = deferred<void>();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(): Promise<void> {
          pull.resolve();
          return new Promise(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const event = eventOf(body, {}, controller.signal);
    const reading = readJsonBody(event).then(
      () => undefined,
      (error: unknown) => error,
    );

    await pull.promise;
    controller.abort("connection-gone");
    const error = await Promise.race([
      reading,
      new Promise<"still-pending">((resolve) => setTimeout(resolve, 25, "still-pending")),
    ]);

    expect(error).not.toBe("still-pending");
    expect(error).toMatchObject({ code: "invalid-input", status: 400 });
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(ScafoError);
    expect(event.req.body?.locked).toBe(false);
  });
});

function eventOf(
  body: BodyInit | Uint8Array,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): H3Event {
  const req = new Request("http://node.test/control", {
    method: "POST",
    headers,
    body: body as BodyInit,
    signal,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });
  return { req } as H3Event;
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function chunks(parts: Uint8Array[], cancel?: () => void): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(stream): void {
      const part = parts[at++];
      if (part === undefined) stream.close();
      else stream.enqueue(part);
    },
    cancel,
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
