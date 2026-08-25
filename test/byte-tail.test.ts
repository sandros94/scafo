import { expect, it } from "vitest";
import { ByteTail, decodeUtf8Tail } from "../src/core/utils/byte-tail.ts";

it("retains only the fixed byte tail across unlimited split output", () => {
  const tail = new ByteTail(8);
  for (let index = 0; index < 10_000; index += 1) {
    tail.push(new Uint8Array([index & 0xff]));
  }

  expect(tail.bytes()).toEqual(
    new Uint8Array([8, 9, 10, 11, 12, 13, 14, 15].map((value) => (10_000 - 8 + value - 8) & 0xff)),
  );
  expect(tail.bytes().byteLength).toBe(8);
});

it("decodes a bounded tail on valid multibyte boundaries", () => {
  const bytes = new TextEncoder().encode(`before-${"€".repeat(2000)}-after`);
  const decoded = decodeUtf8Tail(bytes, 4096);

  expect(new TextEncoder().encode(decoded).byteLength).toBeLessThanOrEqual(4096);
  expect(decoded).toMatch(/€+-after$/);
  expect(decoded).not.toContain("�");
});
