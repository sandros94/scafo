import { describe, expect, it } from "vitest";
import { planLocalStateRemoval } from "../src/core/placement/local-state.ts";

/**
 * A directory a process worked out of can hold writes a peer already
 * acknowledged and the bucket has not got yet, so only the one thing that ends
 * an application — its deletion — ends its directory.
 */
describe("which of a node's local directories may go", () => {
  it("keeps every application the registry still holds", () => {
    expect(
      planLocalStateRemoval({
        held: ["shop", "shop-preview"],
        registered: new Set(["shop", "shop-preview"]),
        running: new Set(),
      }),
    ).toEqual([]);
  });

  it.each([
    ["retired or blocked, which leaves the record where it is", "shop"],
    ["placed on other nodes, which this one may get back", "shop"],
  ])("keeps one that stopped here because it was %s", (_why, application) => {
    expect(
      planLocalStateRemoval({
        held: [application],
        registered: new Set([application]),
        running: new Set(),
      }),
    ).toEqual([]);
  });

  it("removes one the registry no longer holds", () => {
    expect(
      planLocalStateRemoval({
        held: ["shop", "gone"],
        registered: new Set(["shop"]),
        running: new Set(),
      }),
    ).toEqual(["gone"]);
  });

  it("keeps a gone application's directory while a process for it still runs here", () => {
    /* The process has those files open and is still answering peers out of
       them; the pass after the one that stops it is when they may go. */
    expect(
      planLocalStateRemoval({
        held: ["gone"],
        registered: new Set(),
        running: new Set(["gone"]),
      }),
    ).toEqual([]);

    expect(
      planLocalStateRemoval({ held: ["gone"], registered: new Set(), running: new Set() }),
    ).toEqual(["gone"]);
  });

  it("removes nothing when this node holds nothing", () => {
    expect(
      planLocalStateRemoval({ held: [], registered: new Set(["shop"]), running: new Set() }),
    ).toEqual([]);
  });
});
