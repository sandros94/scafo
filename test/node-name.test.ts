import { describe, expect, it } from "vitest";
import { assertNodeId, NODE_ID_RE } from "../src/core/registry/paths.ts";

/**
 * The rule Celld applies to a node session id, mirrored from the release this
 * build runs: non-empty, at most 128 bytes, ASCII alphanumerics plus `_ - .`,
 * and neither of the two path components.
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/logic/peer.rs#L18-L25 (v0.5.0)
 *   https://github.com/denoland/celld/blob/12d5b6333fe52717325addcfe1e99e9fd4f77bcd/crates/celld/machine.rs#L14-L22 (v0.5.0)
 */
function isCelldNodeName(name: string): boolean {
  if (name === "." || name === "..") return false;
  const bytes = new TextEncoder().encode(name);
  if (bytes.length === 0 || bytes.length > 128) return false;
  return /^[A-Za-z\d._-]+$/.test(name);
}

/**
 * A node id becomes the name its runtime processes run under, and a process
 * started under a name the runtime refuses never starts at all — so this is the
 * containment the id rule exists to keep.
 */
describe("a scafo node id as a celld node name", () => {
  it("is a name celld accepts, for every single character an id may be made of", () => {
    /* Every code point an id could carry, not a handful of examples: the two
       rules are only safe to keep apart while one is inside the other. */
    for (let code = 0; code < 0x80; code++) {
      const character = String.fromCharCode(code);
      if (!NODE_ID_RE.test(character)) continue;
      expect(isCelldNodeName(character), JSON.stringify(character)).toBe(true);
    }
  });

  it.each(["node-a", "node_b", "a", "0", "node-a-eu-west-1", "a".repeat(128)])(
    "accepts %s on both sides",
    (id) => {
      expect(NODE_ID_RE.test(id)).toBe(true);
      expect(isCelldNodeName(id)).toBe(true);
      expect(() => assertNodeId(id)).not.toThrow();
    },
  );

  it("stops one byte before celld does", () => {
    expect(isCelldNodeName("a".repeat(129))).toBe(false);
    expect(() => assertNodeId("a".repeat(129))).toThrow(
      expect.objectContaining({ code: "invalid-slug" }),
    );
  });

  it.each([".", "..", "node.a", "Node-A", "node/a", "node a", "nodé"])(
    "refuses %s, whatever celld would make of it",
    (id) => {
      expect(NODE_ID_RE.test(id)).toBe(false);
    },
  );
});
